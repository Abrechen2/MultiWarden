// Login flows that Vaultwarden does not offer, against an in-process mock of the Bitwarden server
// API (shapes as in bitwarden/server): trusted device encryption (TDE) incl. device approval,
// admin approval and new members, Key Connector (existing + new user) and Duo (redirect flow).
import { opened, resetStorage } from "./chrome-stub";
import http from "node:http";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import {
  decryptBytes,
  decryptKey,
  deriveMasterKey,
  encryptBytes,
  encryptKey,
  generateCbcHmacKey,
  generateRsaKeyPair,
  KdfType,
  makePrivateKey,
  rsaDecryptKey,
  rsaEncryptKey,
  stretchMasterKey,
  symKeyToBytes,
  SymKey,
  b64decode,
  b64encode,
} from "../src/crypto/bw";
import { fingerprintPhrase } from "../src/crypto/fingerprint";

const PORT = 8010;
const BASE = `http://localhost:${PORT}`;
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (claims: any) => b64u(JSON.stringify({ alg: "none" })) + "." + b64u(JSON.stringify(claims)) + ".sig";

// ------------------------------------------------------------------------------------------- mock server state

interface User {
  id: string;
  email: string;
  kind: "tde" | "kc" | "duo";
  userKey?: SymKey;
  encPrivateKey?: string;
  publicKey?: Uint8Array;
  privateKey?: Uint8Array;
  hasMasterPassword: boolean;
  encUserKeyMp?: string;
  devices: Map<string, { encryptedUserKey: string; encryptedPublicKey: string; encryptedPrivateKey: string }>;
  resetPasswordKey?: string;
  usesKeyConnector?: boolean;
  orgs?: any[];
}
const users = new Map<string, User>();
const kcStore = new Map<string, string>(); // userId → b64 master key
const authRequests = new Map<string, any>();
let orgKp: { publicKey: Uint8Array; privateKey: Uint8Array };
const MP = "Master-Passwort-Duo-1";

async function addUser(email: string, kind: User["kind"], withKeys: boolean, hasMp = false) {
  const u: User = { id: crypto.randomUUID(), email, kind, hasMasterPassword: hasMp, devices: new Map() };
  if (withKeys) {
    u.userKey = generateCbcHmacKey();
    const kp = await generateRsaKeyPair();
    u.publicKey = kp.publicKey;
    u.privateKey = kp.privateKey;
    u.encPrivateKey = await encryptBytes(kp.privateKey, u.userKey, "application/x.bitwarden.legacy-key");
  }
  users.set(email, u);
  return u;
}

const byToken = (req: http.IncomingMessage) => {
  const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  try {
    const c = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    return [...users.values()].find((u) => u.id === c.sub);
  } catch {
    return undefined;
  }
};

function tokenResponse(u: User, deviceId: string) {
  const dev = u.devices.get(deviceId);
  const r: any = {
    access_token: jwt({ sub: u.id, email: u.email, exp: Math.floor(Date.now() / 1000) + 3600 }),
    expires_in: 3600,
    token_type: "Bearer",
    refresh_token: "refresh-" + u.id,
    scope: "api offline_access",
    Kdf: 0,
    KdfIterations: 600000,
    UserDecryptionOptions: { HasMasterPassword: u.hasMasterPassword, Object: "userDecryptionOptions" },
  };
  if (u.encPrivateKey) r.PrivateKey = u.encPrivateKey;
  if (u.kind === "tde")
    r.UserDecryptionOptions.TrustedDeviceOption = {
      HasAdminApproval: true,
      HasLoginApprovingDevice: true,
      HasManageResetPasswordPermission: false,
      IsTdeOffboarding: false,
      EncryptedPrivateKey: dev?.encryptedPrivateKey ?? null,
      EncryptedUserKey: dev?.encryptedUserKey ?? null,
    };
  if (u.kind === "kc") {
    r.UserDecryptionOptions.KeyConnectorOption = { KeyConnectorUrl: BASE + "/kc" };
    if (u.encUserKeyMp) r.Key = u.encUserKeyMp;
  }
  if (u.hasMasterPassword && u.encUserKeyMp) {
    r.Key = u.encUserKeyMp;
    r.UserDecryptionOptions.MasterPasswordUnlock = {
      Kdf: { KdfType: 0, Iterations: 600000 },
      MasterKeyEncryptedUserKey: u.encUserKeyMp,
      Salt: u.email,
    };
  }
  return r;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => res(d));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url!, BASE);
  const send = (status: number, obj: any) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  const raw = await readBody(req);
  const json = () => (raw ? JSON.parse(raw) : {});
  try {
    if (u.pathname === "/identity/sso/prevalidate") return send(200, { token: "sso-token" });
    if (u.pathname === "/identity/connect/token") {
      const f = new URLSearchParams(raw);
      const email = (f.get("code") ?? "").replace(/^code-/, "");
      const user = users.get(email);
      if (f.get("grant_type") !== "authorization_code" || !user || !f.get("code_verifier"))
        return send(400, { error: "invalid_grant", ErrorModel: { Message: "invalid" } });
      if (user.kind === "duo") {
        const tf = f.get("twoFactorToken");
        if (f.get("twoFactorProvider") !== "2" || tf !== "duo-ok|duo-state")
          return send(400, {
            error: "invalid_grant",
            error_description: "Two factor required.",
            TwoFactorProviders: ["2"],
            TwoFactorProviders2: { "2": { AuthUrl: "https://api-duo.example/frame/v4/auth?client_id=x" } },
          });
      }
      return send(200, tokenResponse(user, f.get("deviceIdentifier") ?? ""));
    }
    if (u.pathname === "/api/sync") {
      const user = byToken(req)!;
      return send(200, {
        Object: "sync",
        Profile: {
          Id: user.id,
          Email: user.email,
          PrivateKey: user.encPrivateKey ?? null,
          UsesKeyConnector: !!user.usesKeyConnector,
          Organizations: user.orgs ?? [],
        },
        Folders: [],
        Collections: [],
        Ciphers: [],
        Domains: null,
      });
    }
    let m = u.pathname.match(/^\/api\/devices\/([^/]+)\/keys$/);
    if (m && req.method === "PUT") {
      const user = byToken(req)!;
      user.devices.set(decodeURIComponent(m[1]), json());
      return send(200, { Object: "device" });
    }
    if (u.pathname === "/api/auth-requests/" && req.method === "POST") {
      const b = json();
      const user = users.get(b.email);
      if (!user || req.headers["device-identifier"] !== b.deviceIdentifier) return send(400, { message: "bad" });
      const id = crypto.randomUUID();
      authRequests.set(id, { ...b, id, user, requestApproved: null, key: null });
      return send(200, { id, publicKey: b.publicKey, requestDeviceType: "Chrome", creationDate: new Date().toISOString() });
    }
    if (u.pathname === "/api/auth-requests/admin-request" && req.method === "POST") {
      const user = byToken(req);
      const b = json();
      if (!user || b.type !== 2) return send(400, { message: "bad" });
      const id = crypto.randomUUID();
      authRequests.set(id, { ...b, id, user, requestApproved: null, key: null });
      return send(200, { id });
    }
    m = u.pathname.match(/^\/api\/auth-requests\/([^/]+)(\/response)?$/);
    if (m && req.method === "GET") {
      const ar = authRequests.get(m[1]);
      if (!ar) return send(404, { message: "not found" });
      if (m[2] ? u.searchParams.get("code") !== ar.accessCode : byToken(req) !== ar.user) return send(404, { message: "not found" });
      return send(200, {
        id: ar.id,
        publicKey: ar.publicKey,
        requestApproved: ar.requestApproved,
        key: ar.key,
        responseDate: ar.requestApproved == null ? null : new Date().toISOString(),
      });
    }
    if (u.pathname === "/api/accounts/keys" && req.method === "POST") {
      const user = byToken(req)!;
      const b = json();
      user.encPrivateKey = b.encryptedPrivateKey;
      user.publicKey = b64decode(b.publicKey);
      return send(200, { Object: "keys" });
    }
    m = u.pathname.match(/^\/api\/organizations\/([^/]+)\/auto-enroll-status$/);
    if (m) return send(200, { Id: "org-1", Identifier: m[1], ResetPasswordEnabled: true });
    if (u.pathname === "/api/organizations/org-1/keys")
      return send(200, { PublicKey: b64encode(orgKp.publicKey), Object: "organizationKeys" });
    m = u.pathname.match(/^\/api\/organizations\/org-1\/users\/([^/]+)\/reset-password-enrollment$/);
    if (m && req.method === "PUT") {
      const user = [...users.values()].find((x) => x.id === m![1]);
      if (!user || byToken(req) !== user) return send(403, { message: "forbidden" });
      user.resetPasswordKey = json().resetPasswordKey;
      return send(200, undefined);
    }
    if (u.pathname === "/kc/user-keys") {
      const user = byToken(req);
      if (!user) return send(401, { message: "unauthorized" });
      if (req.method === "GET") {
        const k = kcStore.get(user.id);
        return k ? send(200, { key: k }) : send(404, { message: "no key" });
      }
      kcStore.set(user.id, json().key);
      return send(200, undefined);
    }
    if (u.pathname === "/api/accounts/convert-to-key-connector" && req.method === "POST") {
      const user = byToken(req)!;
      if (!kcStore.has(user.id)) return send(400, { message: "no key on key connector" });
      user.usesKeyConnector = true;
      user.hasMasterPassword = false;
      return send(200, undefined);
    }
    m = u.pathname.match(/^\/api\/organizations\/([^/]+)\/leave$/);
    if (m && req.method === "POST") {
      const user = byToken(req)!;
      user.orgs = (user.orgs ?? []).filter((o) => o.Id !== m![1]);
      return send(200, undefined);
    }
    if (u.pathname === "/api/accounts/set-key-connector-key" && req.method === "POST") {
      const user = byToken(req)!;
      const b = json();
      user.encUserKeyMp = b.key;
      user.encPrivateKey = b.keys.encryptedPrivateKey;
      return send(200, undefined);
    }
    send(404, { message: "not mocked: " + u.pathname });
  } catch (e: any) {
    send(500, { message: String(e?.message ?? e) });
  }
});

/** "Another device" / "the admin" approves an auth request: user key encrypted to the request's public key. */
async function approve(id: string, userKey: SymKey) {
  const ar = authRequests.get(id);
  ar.key = await rsaEncryptKey(userKey, b64decode(ar.publicKey));
  ar.requestApproved = true;
}

// ------------------------------------------------------------------------------------------- tests

const ui = { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} };

async function ssoLogin(flows: LoginFlows, email: string) {
  let f = await flows.startSso({ server: "selfhosted", baseUrl: BASE, email, orgIdentifier: "acme" });
  if (f.step !== "sso-wait") return f;
  const state = new URL(opened.tabs.at(-1)!).searchParams.get("state")!;
  await flows.onTabUpdated(1, `${BASE}/sso-connector.html?code=code-${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`);
  return (await flows.current())!;
}

(async () => {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  orgKp = await generateRsaKeyPair();
  const tina = await addUser("tina@tde.test", "tde", true);
  await addUser("neu@tde.test", "tde", false);
  const kai = await addUser("kai@kc.test", "kc", true);
  await addUser("kc-neu@kc.test", "kc", false);
  const duo = await addUser("duo@sso.test", "duo", true, true);
  const mia = await addUser("mia@kc.test", "kc", true, true);
  const miaMk = await deriveMasterKey(MP, mia.email, { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 });
  mia.encUserKeyMp = await encryptKey(mia.userKey!, await stretchMasterKey(miaMk));
  const kcOrg = { Id: "org-kc", Name: "KC Firma", KeyConnectorEnabled: true, KeyConnectorUrl: BASE + "/kc", Type: 2, Enabled: true };
  mia.orgs = [kcOrg];
  // Key Connector user: master key lives on the key server
  const kaiMk = await deriveMasterKey("random-kc-secret", kai.email, { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 });
  kai.encUserKeyMp = await encryptKey(kai.userKey!, await stretchMasterKey(kaiMk));
  kcStore.set(kai.id, b64encode(kaiMk));
  const duoMk = await deriveMasterKey(MP, duo.email, { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 });
  duo.encUserKeyMp = await encryptKey(duo.userKey!, await stretchMasterKey(duoMk));

  let svc = new VaultService(() => {});
  await svc.ready;
  let flows = new LoginFlows(svc, ui);

  // ---------------------------------------------------------------- TDE: untrusted device → approve from other device
  let f = await ssoLogin(flows, "tina@tde.test");
  check("TDE options offered", f.step === "tde" && !!f.tde?.canDevice && !!f.tde?.canAdmin && !f.tde?.canMp, f);
  f = await flows.tdeChoose({ option: "device", rememberDevice: true });
  check(
    "device auth request pending",
    f.step === "auth-request" && f.authRequest?.type === 0 && f.authRequest.fingerprint.split("-").length === 5,
    f,
  );
  const ar1 = [...authRequests.values()].at(-1);
  check("auth request sent anonymously with device id", ar1.type === 0 && ar1.email === "tina@tde.test" && !!ar1.accessCode, ar1);
  const expectedFp = await fingerprintPhrase("tina@tde.test", b64decode(ar1.publicKey));
  check("fingerprint matches public key", f.authRequest?.fingerprint === expectedFp, { got: f.authRequest?.fingerprint, expectedFp });
  f = (await flows.poll())!;
  check("still waiting", f.step === "auth-request");
  await approve(ar1.id, tina.userKey!);
  f = (await flows.poll())!;
  check("approved → done", f.step === "done", f);
  await flows.ack();
  let acc = svc.publicAccounts()[0];
  check("TDE account", acc.decryption === "tde" && !acc.hasMasterPassword && acc.sso && acc.status === "unlocked", acc);
  check("user key correct", symKeyToBytes((await svc.getUserKey(acc.key))!).join() === symKeyToBytes(tina.userKey!).join());
  const dev = tina.devices.get(svc.deviceId);
  check("device trusted on server", !!dev?.encryptedUserKey && !!dev.encryptedPrivateKey && !!dev.encryptedPublicKey, dev);
  // the server side: user key → device public key, device public key encrypted with the user key
  const devPub = (await decryptBytes(dev!.encryptedPublicKey, tina.userKey!)).bytes;
  check("device public key encrypted with user key (SPKI)", devPub.length > 200 && devPub[0] === 0x30);
  check("device key stored locally", !!(await svc.getDeviceKey(acc.key)));

  // ---------------------------------------------------------------- TDE: trusted device → automatic unlock
  await svc.lock();
  f = await flows.startSso({
    server: "selfhosted",
    baseUrl: BASE,
    email: "tina@tde.test",
    orgIdentifier: "acme",
    existingAccountKey: acc.key,
  });
  let state = new URL(opened.tabs.at(-1)!).searchParams.get("state")!;
  await flows.onTabUpdated(1, `${BASE}/sso-connector.html?code=code-tina%40tde.test&state=${encodeURIComponent(state)}`);
  f = (await flows.current())!;
  check("trusted device unlocks without approval", f.step === "done" && f.existingAccountKey === acc.key, f);
  await flows.ack();
  check("unlocked again", svc.isUnlocked(acc.key));

  // ---------------------------------------------------------------- TDE: admin approval (pending survives restart of the flow)
  resetStorage();
  svc = new VaultService(() => {});
  await svc.ready;
  flows = new LoginFlows(svc, ui);
  f = await ssoLogin(flows, "tina@tde.test");
  check("fresh install → TDE options again", f.step === "tde", f);
  f = await flows.tdeChoose({ option: "admin", rememberDevice: false });
  check("admin request pending", f.step === "auth-request" && f.authRequest?.type === 2, f);
  const ar2 = [...authRequests.values()].at(-1);
  check("admin request has type 2", ar2.type === 2);
  await flows.cancel(); // user closes the window, admin approves later
  await approve(ar2.id, tina.userKey!);
  f = await ssoLogin(flows, "tina@tde.test");
  check("approved admin request is used at next login", f.step === "done", f);
  await flows.ack();
  check("not trusted (remember off)", tina.devices.size === 1 && !(await svc.getDeviceKey(svc.publicAccounts()[0].key)), tina.devices.size);

  // ---------------------------------------------------------------- TDE: new member
  f = await ssoLogin(flows, "neu@tde.test");
  check("new TDE member", f.step === "tde-new", f);
  f = await flows.tdeCreateUser({ rememberDevice: true });
  check("member created → done", f.step === "done", f);
  await flows.ack();
  const neu = users.get("neu@tde.test")!;
  acc = svc.publicAccounts().find((a) => a.email === "neu@tde.test")!;
  const neuKey = (await svc.getUserKey(acc.key))!;
  check("keys uploaded", !!neu.encPrivateKey && !!neu.publicKey);
  const recovered = await rsaDecryptKey(neu.resetPasswordKey!, makePrivateKey(orgKp.privateKey));
  check("enrolled in account recovery (org can recover user key)", symKeyToBytes(recovered).join() === symKeyToBytes(neuKey).join());
  check("new member device trusted", neu.devices.has(svc.deviceId));
  const priv = (await decryptBytes(neu.encPrivateKey!, neuKey)).bytes;
  check("private key decrypts with user key", priv.length > 600);

  // ---------------------------------------------------------------- Key Connector: existing user
  f = await ssoLogin(flows, "kai@kc.test");
  check("Key Connector login → done", f.step === "done", f);
  await flows.ack();
  acc = svc.publicAccounts().find((a) => a.email === "kai@kc.test")!;
  check("KC account", acc.decryption === "keyConnector" && !acc.hasMasterPassword, acc);
  check("KC user key", symKeyToBytes((await svc.getUserKey(acc.key))!).join() === symKeyToBytes(kai.userKey!).join());

  // ---------------------------------------------------------------- Key Connector: new user
  f = await ssoLogin(flows, "kc-neu@kc.test");
  check("new KC user → confirm key server", f.step === "kc-confirm" && f.keyConnectorHost === `localhost:${PORT}`, f);
  f = await flows.confirmKeyConnector();
  check("KC user created → done", f.step === "done", f);
  await flows.ack();
  const kcNeu = users.get("kc-neu@kc.test")!;
  acc = svc.publicAccounts().find((a) => a.email === "kc-neu@kc.test")!;
  const mkStored = b64decode(kcStore.get(kcNeu.id)!);
  const ukFromServer = await decryptKey(kcNeu.encUserKeyMp!, await stretchMasterKey(mkStored));
  check(
    "master key on key server unwraps user key",
    symKeyToBytes(ukFromServer).join() === symKeyToBytes((await svc.getUserKey(acc.key))!).join(),
  );
  // a later login uses the stored master key
  await svc.logout(acc.key);
  f = await ssoLogin(flows, "kc-neu@kc.test");
  check("KC re-login", f.step === "done", f);
  await flows.ack();

  // ---------------------------------------------------------------- Key Connector: member with master password → remove it
  f = await ssoLogin(flows, "mia@kc.test");
  check("KC member with MP → master password step", f.step === "mp", f);
  f = await flows.submitMasterPassword({ password: MP });
  check("KC member with MP → done", f.step === "done", f);
  await flows.ack();
  acc = svc.publicAccounts().find((a) => a.email === "mia@kc.test")!;
  await svc.sync(acc.key);
  acc = svc.publicAccounts().find((a) => a.email === "mia@kc.test")!;
  check("migration offered", acc.kcMigration?.orgId === "org-kc" && acc.kcMigration.url === BASE + "/kc" && acc.hasMasterPassword, acc);
  await svc.leaveOrganization(acc.key, "org-kc");
  acc = svc.publicAccounts().find((a) => a.email === "mia@kc.test")!;
  check("leaving the organization ends the migration", !acc.kcMigration && !mia.orgs!.length, acc);
  mia.orgs = [kcOrg];
  await svc.sync(acc.key);
  const wrong = await svc.removeMasterPassword(acc.key, "falsch").then(
    () => "ok",
    (e) => e.message,
  );
  check("wrong master password rejected", wrong !== "ok" && !kcStore.has(mia.id), wrong);
  await svc.removeMasterPassword(acc.key, MP);
  acc = svc.publicAccounts().find((a) => a.email === "mia@kc.test")!;
  check("master password removed", !acc.hasMasterPassword && acc.decryption === "keyConnector" && !acc.kcMigration, acc);
  check("server converted", !!mia.usesKeyConnector && !mia.hasMasterPassword);
  check("master key on key server", kcStore.get(mia.id) === b64encode(miaMk));
  await svc.logout(acc.key);
  f = await ssoLogin(flows, "mia@kc.test");
  check("after removal: SSO login via Key Connector", f.step === "done", f);
  await flows.ack();
  acc = svc.publicAccounts().find((a) => a.email === "mia@kc.test")!;
  check("same user key", symKeyToBytes((await svc.getUserKey(acc.key))!).join() === symKeyToBytes(mia.userKey!).join());

  // ---------------------------------------------------------------- Duo (redirect) + master password
  f = await ssoLogin(flows, "duo@sso.test");
  check("Duo required", f.step === "twoFactor" && !!f.twoFactor?.providers.includes(2), f);
  const tabsBefore = opened.tabs.length;
  f = await flows.startDuo({ provider: 2, remember: false });
  check("Duo opens prompt", f.step === "twoFactor-wait" && f.waitKind === "duo" && opened.tabs.length === tabsBefore + 1, f);
  check("Duo prompt url", opened.tabs.at(-1)!.startsWith("https://api-duo.example/frame/v4/auth"), opened.tabs.at(-1));
  await flows.onTabUpdated(77, `${BASE}/duo-redirect-connector.html?code=duo-ok&state=duo-state`);
  f = (await flows.current())!;
  check("Duo accepted → master password", f.step === "mp", f);
  f = await flows.submitMasterPassword({ password: MP });
  check("Duo + MP → done", f.step === "done", f);
  await flows.ack();
  // wrong Duo answer
  f = await ssoLogin(flows, "duo@sso.test");
  await flows.startDuo({ provider: 2, remember: false });
  await flows.onTabUpdated(78, `${BASE}/duo-redirect-connector.html?code=duo-bad&state=duo-state`);
  f = (await flows.current())!;
  check("wrong Duo response rejected", f.step === "twoFactor" && !!f.error, f);
  await flows.cancel();

  server.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
