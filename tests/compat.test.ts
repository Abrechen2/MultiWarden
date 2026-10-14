// Cross-check with the official Bitwarden CLI: a passkey created by MultiWarden must decrypt in the
// official client with the same values (Bitwarden's Fido2Credential format).
import { opened } from "./chrome-stub";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { Fido2Service } from "../src/background/fido2";
import { cborDecode, CborMap } from "../src/crypto/cbor";
import { b64urlToBytes, bytesToB64url, bytesToGuid } from "../src/crypto/fido2";
import { utf8 } from "../src/crypto/utils";
import { SendType } from "../src/shared/sends";

// newer CLI versions refuse plain-http servers, 2026.7 still accepts the local test servers
// official Bitwarden CLI (npm i -g @bitwarden/cli) – path via BW_CLI, otherwise "bw" from the PATH
const BW = process.env.BW_CLI ?? "bw";
const PW = "Test-Passwort-123!";
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

(async () => {
  const svc = new VaultService(() => {});
  await svc.ready;
  await svc.setSettings({ passkeys: true });
  const flows = new LoginFlows(svc, { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} });
  const f = await flows.startPassword({ server: "selfhosted", baseUrl: "http://localhost:8001", email: "alex@privat.test", password: PW });
  check("login", f.step === "done", f);
  const fido2 = new Fido2Service(svc, { async openPopup() {} });

  let resolve: (m: any) => void = () => {};
  const reply = new Promise<any>((r) => (resolve = r));
  const listeners: any[] = [];
  const port: any = {
    name: "mw-fido2",
    sender: { tab: { id: 9, windowId: 1 }, frameId: 0, url: "https://compat.example.test/" },
    postMessage: (m: any) => resolve(m),
    disconnect() {},
    onMessage: { addListener: (fn: any) => listeners.push(fn) },
    onDisconnect: { addListener() {} },
  };
  (fido2 as any).onPort(port);
  const userHandle = bytesToB64url(utf8("compat-user"));
  listeners.forEach((fn) =>
    fn({
      type: "request",
      kind: "create",
      options: {
        rp: { id: "compat.example.test", name: "Compat" },
        user: { id: userHandle, name: "compat@example.test", displayName: "Compat User" },
        challenge: bytesToB64url(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "discouraged" },
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 100));
  const token = decodeURIComponent(opened.windows.at(-1)!.split("#")[1]);
  const r = await fido2.save(token, svc.accounts[0].key);
  check("created", r.ok, r);
  const res = (await reply).result;
  const authData = (cborDecode(b64urlToBytes(res.attestationObject)) as CborMap).get("authData") as Uint8Array;
  const credId = authData.subarray(55, 55 + ((authData[53] << 8) | authData[54]));
  const cose = cborDecode(authData.subarray(55 + credId.length)) as CborMap;
  const item = (await svc.getVault()).items.find((i) => i.login?.fido2?.[0]?.credentialId === bytesToGuid(credId))!;

  // official CLI
  const dir = mkdtempSync(join(tmpdir(), "bwcli-"));
  // local self-signed test server: trust it, and keep localhost traffic away from any outbound proxy
  const env = {
    ...process.env,
    BITWARDENCLI_APPDATA_DIR: dir,
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  } as Record<string, string | undefined>;
  // the CLI's HTTP agent ignores NO_PROXY; it only talks to the local test server here
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[k];
  const bw = (...args: string[]) => execFileSync(BW, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  bw("config", "server", process.env.BW_SERVER ?? "https://localhost:8443"); // tests/tls-proxy.mjs in front of :8001
  const session = bw("login", "alex@privat.test", PW, "--raw");
  const official = JSON.parse(bw("get", "item", item.id, "--session", session));
  const fc = official.login?.fido2Credentials?.[0];
  check("official client sees passkey", !!fc, official.login);
  check("credentialId", fc?.credentialId === bytesToGuid(credId), { cli: fc?.credentialId, ours: bytesToGuid(credId) });
  check("rpId / rpName", fc?.rpId === "compat.example.test" && fc?.rpName === "Compat", fc);
  check("user", fc?.userName === "compat@example.test" && fc?.userDisplayName === "Compat User" && fc?.userHandle === userHandle, fc);
  check("key type", fc?.keyType === "public-key" && fc?.keyAlgorithm === "ECDSA" && fc?.keyCurve === "P-256", fc);
  check("counter / discoverable", String(fc?.counter) === "0" && String(fc?.discoverable) === "true", fc);
  const priv = await crypto.subtle.importKey("pkcs8", b64urlToBytes(fc.keyValue), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  check(
    "private key matches attested public key",
    jwk.x === bytesToB64url(cose.get(-2) as Uint8Array) && jwk.y === bytesToB64url(cose.get(-3) as Uint8Array),
  );

  // --- export / import compatibility (file formats of the official clients) ---
  const accKey = svc.accounts[0].key;
  const personal = (await svc.getVault()).items.filter((i) => i.accountKey === accKey && !i.organizationId && !i.deletedDate);
  // official password-protected export → MultiWarden import
  writeFileSync(join(dir, "pw.txt"), "Datei-Passwort-9\n");
  bw("export", "--format", "encrypted_json", "--password", "Datei-Passwort-9", "--output", join(dir, "cli-pw.json"), "--session", session);
  const cliPw = await svc.decryptImportFile(accKey, JSON.parse(readFileSync(join(dir, "cli-pw.json"), "utf8")), "Datei-Passwort-9");
  check("official password-protected export decrypts", cliPw.items?.length === personal.length, [cliPw.items?.length, personal.length]);
  // official account-restricted export → MultiWarden import
  bw("export", "--format", "encrypted_json", "--output", join(dir, "cli-acc.json"), "--session", session);
  const cliAcc = await svc.decryptImportFile(accKey, JSON.parse(readFileSync(join(dir, "cli-acc.json"), "utf8")));
  const visa = cliAcc.items.find((i: any) => i.name === "Visa Privat");
  check("official account-restricted export decrypts", cliAcc.items.length === personal.length && visa?.card?.number === "4111111111111111", visa);
  // official unencrypted export has the same items as ours
  bw("export", "--format", "json", "--output", join(dir, "cli.json"), "--session", session);
  const cliJson = JSON.parse(readFileSync(join(dir, "cli.json"), "utf8"));
  const ours = JSON.parse((await svc.exportVault(accKey, "json", { mode: "mp", secret: PW })).data);
  const names = (d: any) => d.items.map((i: any) => i.name + "|" + (i.login?.password ?? i.card?.number ?? "")).sort().join("\n");
  check("unencrypted export equals the official one", names(cliJson) === names(ours), { cli: cliJson.items.length, ours: ours.items.length });
  // MultiWarden password-protected export → official import
  const ourPw = await svc.exportVault(accKey, "password_json", { mode: "mp", secret: PW }, "Datei-Passwort-9");
  writeFileSync(join(dir, "ours-pw.json"), ourPw.data);
  const out = bw("import", "bitwardenjson", join(dir, "ours-pw.json"), "--passwordfile", join(dir, "pw.txt"), "--session", session);
  check("official CLI imports our password-protected export", /Imported/i.test(out), out);
  await svc.sync(accKey);
  const after = (await svc.getVault()).items.filter((i) => i.accountKey === accKey && !i.organizationId && !i.deletedDate);
  check("imported copies are complete", after.length === personal.length * 2 && after.filter((i) => i.name === "Visa Privat").every((i) => i.card?.number === "4111111111111111"), [after.length, personal.length]);
  // remove the imported copies again
  const firstIds = new Set(personal.map((i) => i.id));
  for (const i of after) if (!firstIds.has(i.id)) await svc.deleteItem(accKey, i.id, true);

  // fingerprint phrase as shown by the official client
  const cliFp = bw("get", "fingerprint", "me", "--session", session);
  const ourFp = await svc.fingerprint(accKey);
  check("fingerprint phrase equals the official one", cliFp === ourFp, { cli: cliFp, ours: ourFp });

  // Send: ours as the official client sees it, and one of the official client in MultiWarden
  const ourSend = await svc.saveSend(accKey, {
    type: SendType.Text,
    name: "Compat-Send",
    text: "Hallo vom Send",
    newPassword: "pw-123",
    disabled: false,
    hideEmail: false,
    deletionDate: new Date(Date.now() + 86400_000).toISOString(),
  });
  bw("sync", "--session", session);
  const cliSend = JSON.parse(bw("send", "list", "--session", session)).find((x: any) => x.id === ourSend.id);
  check("official client decrypts our Send", cliSend?.name === "Compat-Send" && cliSend?.text?.text === "Hallo vom Send" && !!cliSend?.passwordSet, cliSend);
  check("same share link", typeof cliSend?.accessUrl === "string" && cliSend.accessUrl.endsWith(ourSend.link.split("/#/send/")[1]), [cliSend?.accessUrl, ourSend.link]);
  const cliCreated = JSON.parse(bw("send", "-n", "CLI-Send", "-d", "2", "--fullObject", "--session", session, "vom offiziellen Client"));
  await svc.sync(accKey);
  const seen = (await svc.listSends(accKey)).sends.find((x) => x.id === cliCreated.id);
  check("MultiWarden decrypts a Send of the official client", seen?.name === "CLI-Send" && seen?.text === "vom offiziellen Client", seen);
  check("same link as the official client", !!seen && cliCreated.accessUrl.endsWith(seen.link.split("/#/send/")[1]), [cliCreated.accessUrl, seen?.link]);
  await svc.deleteSend(accKey, ourSend.id);
  await svc.deleteSend(accKey, cliCreated.id);

  bw("logout");
  // clean up the test items
  for (const it of (await svc.getVault()).items.filter((i) => i.login?.fido2?.[0]?.rpId === "compat.example.test"))
    await svc.deleteItem(svc.accounts[0].key, it.id, true);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e?.stderr?.toString?.() ?? e);
  process.exit(1);
});
