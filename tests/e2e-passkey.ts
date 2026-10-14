// Browser test: "log in with passkey" (Vaultwarden does not offer it) against an in-process mock of
// the Bitwarden identity/API server. The mock web vault page creates the passkey on the virtual
// authenticator and reports the PRF input/output to the mock (test only), so the mock can answer
// with a WebAuthnPrfOption like the real server does after "turn on encryption" for a passkey.
// Also: security tasks ("at-risk passwords", Access Intelligence), which Vaultwarden does not offer either.
// Run: tests/run-node.sh tests/e2e-passkey.ts   (needs dist/chrome from `npm run build:test`)
import http from "node:http";
import path from "node:path";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import {
  b64decode,
  b64encode,
  deriveMasterKey,
  encryptBytes,
  encryptKey,
  encryptString,
  generateCbcHmacKey,
  generateRsaKeyPair,
  KdfType,
  rsaEncryptKey,
  stretchKey,
  stretchMasterKey,
} from "../src/crypto/bw";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const PORT = 8011;
const BASE = `http://localhost:${PORT}`;
const MP = "Passkey-Test-Passwort-1";
const EMAIL = "pia@passkey.test";
const USER_ID = "7c1f6a52-0c55-4d3a-9d3e-passkey00001";
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + (typeof info === "string" ? info : JSON.stringify(info))));
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64u = (s: string | Uint8Array) => Buffer.from(s).toString("base64url");
const jwt = (claims: any) => b64u(JSON.stringify({ alg: "none" })) + "." + b64u(JSON.stringify(claims)) + ".sig";

// ------------------------------------------------------------------------------------------- mock server
const mock = {
  ready: false,
  prfOption: true,
  challenge: "",
  seenSalt: "" as string | null,
  prf: "" as string | null,
  deviceResponse: null as any,
  tokenRequests: 0,
  taskDone: false,
  cipherPuts: 0,
};
let userKey: Awaited<ReturnType<typeof generateCbcHmacKey>>;
let kp: { publicKey: Uint8Array; privateKey: Uint8Array };
let encPrivateKey = "";
let encUserKeyMp = "";
let cipher: any;

const VAULT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mock Web Vault</title></head>
<body><h1>Mock Web Vault</h1><script>
(function () {
  const realGet = navigator.credentials.get.bind(navigator.credentials);
  const b64 = (b) => {
    if (!b) return null;
    const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    let s = ""; for (const x of u) s += String.fromCharCode(x); return btoa(s);
  };
  let created = false;
  navigator.credentials.get = async function (opts) {
    for (let i = 0; i < 200; i++) { if ((await (await fetch("/test/ready")).text()) === "1") break; await new Promise((r) => setTimeout(r, 100)); }
    if (!created) {
      // the passkey "registered in the web vault" (with PRF) lives on this tab's virtual authenticator
      await navigator.credentials.create({ publicKey: {
        rp: { id: "localhost", name: "Mock" },
        user: { id: new TextEncoder().encode(${JSON.stringify(USER_ID)}), name: ${JSON.stringify(EMAIL)}, displayName: "Pia" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        extensions: { prf: {} },
      }});
      created = true;
    }
    const cred = await realGet(opts);
    const salt = opts && opts.publicKey && opts.publicKey.extensions && opts.publicKey.extensions.prf ? opts.publicKey.extensions.prf.eval.first : null;
    const res = cred.getClientExtensionResults();
    await fetch("/test/prf", { method: "POST", body: JSON.stringify({ salt: b64(salt), prf: b64(res.prf && res.prf.results ? res.prf.results.first : null) }) });
    return cred;
  };
})();
</script></body></html>`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => res(d));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url!, BASE);
  const send = (status: number, obj: any, type = "application/json") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(typeof obj === "string" ? obj : obj === undefined ? "" : JSON.stringify(obj));
  };
  const raw = await readBody(req);
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") return send(200, VAULT_PAGE, "text/html; charset=utf-8");
    if (u.pathname === "/test/ready") return send(200, mock.ready ? "1" : "0", "text/plain");
    if (u.pathname === "/test/prf") {
      const b = JSON.parse(raw);
      mock.seenSalt = b.salt;
      mock.prf = b.prf;
      return send(200, "ok", "text/plain");
    }
    if (u.pathname === "/identity/accounts/webauthn/assertion-options") {
      mock.challenge = b64u(crypto.getRandomValues(new Uint8Array(32)));
      return send(200, {
        Options: { Challenge: mock.challenge, Timeout: 60000, RpId: "localhost", AllowCredentials: [], UserVerification: "required", Extensions: {} },
        Token: "assertion-token-" + mock.challenge.slice(0, 8),
        Object: "webAuthnLoginAssertionOptions",
      });
    }
    if (u.pathname === "/identity/connect/token") {
      const f = new URLSearchParams(raw);
      mock.tokenRequests++;
      if (f.get("grant_type") !== "webauthn") return send(400, { error: "invalid_grant", ErrorModel: { Message: "unexpected grant" } });
      if (f.get("token") !== "assertion-token-" + mock.challenge.slice(0, 8)) return send(400, { error: "invalid_grant", ErrorModel: { Message: "bad token" } });
      const dr = JSON.parse(f.get("deviceResponse") ?? "{}");
      mock.deviceResponse = dr;
      const cd = JSON.parse(Buffer.from(dr.response?.clientDataJSON ?? "", "base64url").toString());
      if (cd.type !== "webauthn.get" || cd.challenge !== mock.challenge || cd.origin !== BASE)
        return send(400, { error: "invalid_grant", ErrorModel: { Message: "bad client data " + JSON.stringify(cd) } });
      if (Buffer.from(dr.response?.userHandle ?? "", "base64url").toString() !== USER_ID)
        return send(400, { error: "invalid_grant", ErrorModel: { Message: "unknown passkey" } });
      const r: any = {
        access_token: jwt({ sub: USER_ID, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 3600, amr: ["webauthn"] }),
        expires_in: 3600,
        token_type: "Bearer",
        refresh_token: "refresh-passkey",
        scope: "api offline_access",
        Key: encUserKeyMp,
        PrivateKey: encPrivateKey,
        Kdf: 0,
        KdfIterations: 600000,
        UserDecryptionOptions: {
          HasMasterPassword: true,
          MasterPasswordUnlock: { Kdf: { KdfType: 0, Iterations: 600000 }, MasterKeyEncryptedUserKey: encUserKeyMp, Salt: EMAIL },
          Object: "userDecryptionOptions",
        },
      };
      if (mock.prfOption && mock.prf) {
        // what the web vault stored when encryption was turned on for this passkey
        const prfKey = await stretchKey(b64decode(mock.prf));
        r.UserDecryptionOptions.WebAuthnPrfOption = {
          EncryptedPrivateKey: await encryptBytes(kp.privateKey, prfKey, "application/x.bitwarden.legacy-key"),
          EncryptedUserKey: await rsaEncryptKey(userKey, kp.publicKey),
          CredentialId: dr.id,
          Transports: ["internal"],
        };
      }
      return send(200, r);
    }
    if (u.pathname === "/api/sync")
      return send(200, {
        Object: "sync",
        Profile: {
          Id: USER_ID,
          Email: EMAIL,
          Name: "Pia",
          Key: encUserKeyMp,
          PrivateKey: encPrivateKey,
          Organizations: [{ Id: "org-risk", Name: "Risiko GmbH", UseRiskInsights: true, Enabled: true, Status: 2, Type: 2, UsePolicies: true }],
        },
        Folders: [],
        Collections: [],
        Ciphers: [cipher],
        Policies: [],
        Domains: null,
      });
    if (u.pathname === "/api/tasks" && req.method === "GET")
      return send(200, {
        Object: "list",
        Data: [
          {
            Id: "task-1",
            OrganizationId: "org-risk",
            CipherId: "c-passkey-1",
            Type: 0,
            Status: mock.taskDone ? 1 : 0,
            CreationDate: new Date().toISOString(),
            RevisionDate: new Date().toISOString(),
          },
        ],
      });
    if (u.pathname === "/api/tasks/task-1/complete" && req.method === "PATCH") {
      mock.taskDone = true;
      return send(200, undefined);
    }
    if (u.pathname === "/api/ciphers/c-passkey-1" && req.method === "PUT") {
      const b = JSON.parse(raw);
      mock.cipherPuts++;
      const now = new Date().toISOString();
      cipher = { ...b, id: "c-passkey-1", organizationId: null, folderId: null, edit: true, viewPassword: true, collectionIds: [], revisionDate: now, creationDate: now, object: "cipherDetails" };
      return send(200, cipher);
    }
    if (u.pathname === "/.well-known/change-password") return send(200, "<h1>Passwort ändern</h1>", "text/html; charset=utf-8");
    send(404, { message: "not mocked: " + u.pathname });
  } catch (e: any) {
    send(500, { message: String(e?.message ?? e) });
  }
});

// ------------------------------------------------------------------------------------------- browser
(async () => {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  userKey = generateCbcHmacKey();
  kp = await generateRsaKeyPair();
  encPrivateKey = await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key");
  const mk = await deriveMasterKey(MP, EMAIL, { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 });
  encUserKeyMp = await encryptKey(userKey, await stretchMasterKey(mk));
  const now = new Date().toISOString();
  cipher = {
    Id: "c-passkey-1",
    Type: 1,
    Name: await encryptString("Passkey-Eintrag", userKey),
    Notes: null,
    Login: {
      Username: await encryptString("pia", userKey),
      Password: await encryptString("geheim", userKey),
      Uris: [{ Uri: await encryptString(BASE + "/login", userKey), Match: null }],
      Totp: null,
    },
    FolderId: null,
    OrganizationId: null,
    Favorite: false,
    Reprompt: 0,
    Fields: null,
    Attachments: null,
    CollectionIds: [],
    RevisionDate: now,
    CreationDate: now,
    DeletedDate: null,
    Edit: true,
    ViewPassword: true,
    Key: null,
    Object: "cipherDetails",
  };

  const profile = SP + "/profile-passkey";
  rmSync(profile, { recursive: true, force: true });
  const EXT = path.resolve("dist/chrome");
  const ctx = await chromium.launchPersistentContext(profile, {
    ...chromiumOptions,
    headless: true,
    locale: "de-DE",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
    viewport: { width: 1000, height: 760 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/inline-menu.html#rpc`);
  const rpc = async (n: string, args: any = {}) => {
    const r: any = await ext.evaluate(([x, a]) => chrome.runtime.sendMessage({ rpc: x, args: a }), [n, args] as const);
    if (!r?.ok) throw new Error(n + ": " + r?.error);
    return r.data;
  };
  // the ceremony tab on the (mock) web vault: give it a virtual authenticator with PRF
  let ceremonyUrl = "";
  ctx.on("page", async (p) => {
    for (let i = 0; i < 60 && !p.url().includes("#mw-passkey"); i++) await sleep(50);
    if (!p.url().includes("#mw-passkey")) return;
    ceremonyUrl = p.url();
    try {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          ctap2Version: "ctap2_1",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
          hasPrf: true,
        },
      });
      mock.ready = true;
    } catch (e) {
      console.log("authenticator setup failed", e);
    }
  });
  const openLogin = async () => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 380, height: 640 });
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.getByRole("button", { name: "Eigener Server" }).click();
    await p.fill('input[name="server-url"]', BASE);
    return p;
  };
  const waitFlow = async (pred: (f: any) => boolean, ms = 30000, nullOk = true) => {
    await sleep(500);
    for (let i = 0; i < ms / 200; i++) {
      const f = await rpc("loginGet");
      if ((f === null && nullOk) || (f && pred(f))) return f;
      await sleep(200);
    }
    return rpc("loginGet");
  };

  // 1. passkey with PRF → logged in and unlocked without master password
  {
    const p = await openLogin();
    await p.click('[data-testid="login-passkey"]');
    // the login popup acknowledges "done" itself → the flow may already be gone
    const f = await waitFlow((x) => x.step === "done" || x.step === "error" || x.step === "mp");
    const st0 = await rpc("getState");
    check("passkey login done", (f === null || f.step === "done") && st0.accounts.some((a: any) => a.email === EMAIL), f);
    check("ceremony ran on the web vault origin", ceremonyUrl.startsWith(BASE + "/"), ceremonyUrl);
    const salt = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("passwordless-login"))).toString("base64");
    check("PRF salt = SHA-256('passwordless-login')", mock.seenSalt === salt, mock.seenSalt);
    check("PRF output never sent to the server", !JSON.stringify(mock.deviceResponse).includes("prf") && mock.deviceResponse?.extensions && !Object.keys(mock.deviceResponse.extensions).length);
    check("assertion fields as in the official client", ["authenticatorData", "signature", "clientDataJSON", "userHandle"].every((k) => !!mock.deviceResponse?.response?.[k]));
    await rpc("loginAck");
    const st = await rpc("getState");
    const acc = st.accounts.find((a: any) => a.email === EMAIL);
    check("account unlocked via PRF", acc?.status === "unlocked" && acc.hasMasterPassword, acc);
    let v: any;
    for (let i = 0; i < 30; i++) {
      v = await rpc("getVault");
      if (v.items.length) break;
      await sleep(200);
    }
    check("vault decrypts", v.items.some((i: any) => i.name === "Passkey-Eintrag" && i.login?.password === "geheim"), v.items.map((i: any) => i.name));
    // the account can still be unlocked with the master password later
    await rpc("lock");
    const r = await rpc("unlock", { password: MP });
    check("master password unlock afterwards", (r.results ?? r).some((x: any) => x.ok), r);
    await rpc("logout", { accountKey: acc.key }).catch(() => {});
    await p.close();
    for (const pg of ctx.pages()) if (pg.url().includes("popup.html?popout=1")) await pg.close();
  }

  // 2. passkey without encryption (no PRF option) → master password asked after the login
  {
    mock.prfOption = false;
    mock.ready = false;
    const p = await openLogin();
    await p.click('[data-testid="login-passkey"]');
    const f = await waitFlow((x) => x.step === "done" || x.step === "error" || x.step === "mp", 30000, false);
    check("without PRF option → master password step", f?.step === "mp" && f.method === "passkey", f);
    const lw = ctx.pages().find((pg) => pg.url().includes("popup.html?popout=1")) ?? p;
    await lw.reload();
    await lw.waitForSelector('[data-testid="flow-mp"]', { timeout: 10000 }).catch(() => {});
    await lw.screenshot({ path: SP + "/shots/passkey-mp.png" });
    await lw.fill('input[name="master-password"]', MP);
    await lw.locator('[data-testid="flow-mp"] button[type="submit"]').click();
    const f2 = await waitFlow((x) => x.step === "done" || x.step === "error");
    check("master password completes the passkey login", f2 === null || f2.step === "done", f2);
    await rpc("loginAck");
    const st = await rpc("getState");
    check("unlocked", st.accounts.some((a: any) => a.email === EMAIL && a.status === "unlocked"));
    await p.close().catch(() => {});
  }

  // 3. server without passkey login (Vaultwarden)
  {
    const f = await rpc("loginPasskey", { server: "selfhosted", baseUrl: "http://localhost:8001" });
    check("unsupported server → clear error", f.step === "error" && /Passkey/.test(f.error ?? ""), f);
    await rpc("loginAck");
  }

  // 4. security task: the organization asks to change the password of the item
  {
    const st0 = await rpc("getState");
    const acc = st0.accounts.find((a: any) => a.email === EMAIL);
    await rpc("sync", { accountKey: acc.key });
    let st = await rpc("getState");
    for (let i = 0; i < 20 && !st.accounts.find((a: any) => a.email === EMAIL)?.atRisk?.length; i++) {
      await sleep(200);
      st = await rpc("getState");
    }
    check("pending task loaded", JSON.stringify(st.accounts.find((a: any) => a.email === EMAIL)?.atRisk) === '["c-passkey-1"]', st.accounts);
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 380, height: 640 });
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForSelector('[data-testid="at-risk-banner"]', { timeout: 15000 });
    await p.screenshot({ path: SP + "/shots/at-risk-banner.png" });
    await p.locator('[data-testid="at-risk-banner"] button').click();
    await p.waitForSelector('[data-testid="at-risk-row"]');
    check("at-risk list shows the item", (await p.locator('[data-testid="at-risk-row"]').count()) === 1);
    const tabPromise = ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    await p.click('[data-testid="change-at-risk"]');
    const tab = await tabPromise;
    if (tab) await tab.waitForLoadState().catch(() => {});
    check("change-password page of the website opened", !!tab && tab.url() === BASE + "/.well-known/change-password", tab?.url());
    await tab?.close();
    await p.screenshot({ path: SP + "/shots/at-risk-list.png" });
    // changing the password completes the task
    const v = await rpc("getVault");
    const item = v.items.find((i: any) => i.id === "c-passkey-1");
    const r = await rpc("saveItem", { accountKey: acc.key, isNew: false, item: { ...item, login: { ...item.login, password: "ganz-neu-2026" } } });
    check("password saved", r.ok !== false && mock.cipherPuts === 1, r);
    for (let i = 0; i < 20 && !mock.taskDone; i++) await sleep(200);
    check("task marked complete", mock.taskDone);
    for (let i = 0; i < 20 && (await rpc("getState")).accounts.find((a: any) => a.email === EMAIL)?.atRisk?.length; i++) await sleep(200);
    st = await rpc("getState");
    check("no more at-risk items", !st.accounts.find((a: any) => a.email === EMAIL)?.atRisk?.length, st.accounts);
    await p.close();
  }

  await ctx.close();
  server.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
