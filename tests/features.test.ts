// Node integration test of the 1.1 features against local Vaultwarden:
// attachments, PIN unlock, passkeys (authenticator end to end), save-login decisions.
import { localData, opened, sessionData } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { Fido2Service } from "../src/background/fido2";
import { NotificationService } from "../src/background/notify";
import { isNeverDomain } from "../src/background/never-domains";
import { decryptFileData, deserializeKey } from "../src/crypto/bw";
import { cborDecode, CborMap } from "../src/crypto/cbor";
import { b64urlToBytes, bytesToB64url, sha256 } from "../src/crypto/fido2";
import { concat, utf8 } from "../src/crypto/utils";
import { CipherType } from "../src/shared/types";

const PW = "Test-Passwort-123!";
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

function derToP1363(der: Uint8Array): Uint8Array {
  let i = 2;
  const read = () => {
    i++; // 0x02
    const len = der[i++];
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return concat(read(), read());
}

/** Fake runtime port as the bridge content script would open it. */
function fakePort(url: string) {
  const msgL: ((m: any) => void)[] = [];
  const discL: (() => void)[] = [];
  const replies: any[] = [];
  let resolveReply: (v: any) => void = () => {};
  const reply = new Promise<any>((r) => (resolveReply = r));
  const port: any = {
    name: "mw-fido2",
    sender: { tab: { id: 5, windowId: 1 }, frameId: 0, url },
    postMessage: (m: any) => {
      replies.push(m);
      resolveReply(m);
    },
    disconnect: () => discL.forEach((f) => f()),
    onMessage: { addListener: (f: any) => msgL.push(f) },
    onDisconnect: { addListener: (f: any) => discL.push(f) },
  };
  return { port, send: (m: any) => msgL.forEach((f) => f(m)), reply, replies };
}

const lastDialogToken = () => decodeURIComponent(opened.windows[opened.windows.length - 1].split("#")[1]);
const tick = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  const svc = new VaultService(() => {});
  await svc.ready;
  const flows = new LoginFlows(svc, { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} });
  for (const [base, email] of [
    ["http://localhost:8001", "alex@privat.test"],
    ["http://localhost:8002", "alex@firma.test"],
  ]) {
    const f = await flows.startPassword({ server: "selfhosted", baseUrl: base, email, password: PW });
    check("login " + email, f.step === "done", f);
    await flows.ack();
  }
  const [A, B] = svc.accounts.map((a) => a.key);

  // ------------------------------------------------------------------ attachments
  const v = await svc.getVault();
  const notes = v.items.find((i) => i.name === "Server-Notizen")!;
  check("attachment listed", notes?.attachments.length === 1 && notes.attachments[0].fileName === "backup-plan.txt", notes?.attachments);
  const d = await svc.attachmentDownload(B, notes.id, notes.attachments[0].id);
  check("attachment url + name", /^http:\/\/localhost:8002\//.test(d.url) && d.fileName === "backup-plan.txt", d);
  const enc = new Uint8Array(await (await fetch(d.url)).arrayBuffer());
  const plain = new TextDecoder().decode(await decryptFileData(enc, deserializeKey(d.key)));
  check("attachment decrypted", plain === "Backup-Plan\nNAS → Cloud, täglich 02:00 Uhr\n", plain);

  // ------------------------------------------------------------------ PIN
  await svc.setPin("4711", true);
  check(
    "pin envelopes",
    svc.publicAccounts().every((a) => a.pinUnlock),
    svc.publicAccounts(),
  );
  await svc.lock();
  check("locked", !svc.anyUnlocked());
  let pr = await svc.unlockWithPin("0000");
  check("wrong pin", pr.results.every((r) => !r.ok) && /Falsche PIN/.test(pr.error ?? ""), pr);
  pr = await svc.unlockWithPin("4711");
  check("pin unlock all", pr.results.length === 2 && pr.results.every((r) => r.ok), pr);
  check("pin fail counter reset", localData.pinFails === 0, localData.pinFails);
  check("verifyUser pin", (await svc.verifyUser(A, "4711", "pin")) && !(await svc.verifyUser(A, "4712", "pin")));
  check("verifyUser mp", (await svc.verifyUser(A, PW, "mp")) && !(await svc.verifyUser(A, "x", "mp")));
  localData.pinFails = 0;
  // pin survives only the session when lockAfterRestart
  check(
    "pin env in session",
    Object.keys(sessionData).some((k) => k.startsWith("pinEnv:")),
  );

  // ------------------------------------------------------------------ passkeys
  await svc.setSettings({ passkeys: true });
  const fido2 = new Fido2Service(svc, { async openPopup() {} });
  const ORIGIN = "https://shop.example.test";
  const challenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const userId = bytesToB64url(utf8("user-4711"));

  // create
  let p = fakePort(ORIGIN + "/register");
  (fido2 as any).onPort(p.port);
  p.send({
    type: "request",
    kind: "create",
    fallbackSupported: true,
    options: {
      rp: { id: "example.test", name: "Example Shop" },
      user: { id: userId, name: "alex@shop", displayName: "Alex" },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      extensions: { credProps: true },
    },
  });
  await tick();
  await tick();
  let token = lastDialogToken();
  let sess = await fido2.session(token);
  check("create session", sess.kind === "create" && sess.rpId === "example.test" && sess.userName === "alex@shop", sess);
  check("create needs verification", sess.newItemVerify[A]?.modes.join(",") === "mp,pin", sess.newItemVerify);
  let r = await fido2.save(token, A, undefined, "falsch", "mp");
  check("wrong mp rejected", !r.ok && /Falsches Master-Passwort/.test(r.error ?? ""), r);
  r = await fido2.save(token, A, undefined, "4711", "pin");
  check("passkey saved", r.ok, r);
  const cres = await p.reply;
  check("create result", cres.type === "result" && cres.result.publicKeyAlgorithm === -7, cres);
  const att = cborDecode(b64urlToBytes(cres.result.attestationObject)) as CborMap;
  const authData = att.get("authData") as Uint8Array;
  check("attestation fmt none", att.get("fmt") === "none");
  check("authData rpIdHash", bytesToB64url(authData.subarray(0, 32)) === bytesToB64url(await sha256(utf8("example.test"))));
  check("authData flags UP|UV|BE|BS|AT", authData[32] === (0x01 | 0x04 | 0x08 | 0x10 | 0x40), authData[32]);
  check("credProps rk", cres.result.credProps?.rk === true, cres.result.credProps);
  const cdj = JSON.parse(new TextDecoder().decode(b64urlToBytes(cres.result.clientDataJSON)));
  check("clientData create", cdj.type === "webauthn.create" && cdj.origin === ORIGIN && cdj.challenge === challenge, cdj);
  const credId = cres.result.id;
  const pubKey = await crypto.subtle.importKey(
    "spki",
    b64urlToBytes(cres.result.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const item = (await svc.getVault()).items.find((i) => i.login?.fido2?.length);
  check(
    "passkey item stored",
    !!item && item.name === "Example Shop" && item.login!.username === "alex@shop" && item.login!.uris[0].uri === ORIGIN,
    item,
  );
  check(
    "passkey meta",
    item?.login?.fido2?.[0].rpId === "example.test" && item?.login?.fido2?.[0].discoverable === true,
    item?.login?.fido2,
  );

  // excluded
  p = fakePort(ORIGIN + "/register");
  (fido2 as any).onPort(p.port);
  p.send({
    type: "request",
    kind: "create",
    options: {
      rp: { id: "example.test", name: "Example Shop" },
      user: { id: userId, name: "alex@shop" },
      challenge,
      pubKeyCredParams: [],
      excludeCredentials: [{ id: credId, type: "public-key" }],
    },
  });
  await tick();
  await tick();
  sess = await fido2.session(lastDialogToken());
  check("excluded", sess.kind === "excluded", sess.kind);
  fido2.cancel(lastDialogToken());
  const ex = await p.reply;
  check("excluded → InvalidStateError", ex.type === "error" && ex.name === "InvalidStateError", ex);

  // get (modal, discoverable)
  const ch2 = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({ type: "request", kind: "get", options: { rpId: "example.test", challenge: ch2, userVerification: "required" } });
  await tick();
  await tick();
  token = lastDialogToken();
  sess = await fido2.session(token);
  check(
    "get candidates",
    sess.kind === "get" && sess.candidates.length === 1 && sess.candidates[0].userName === "alex@shop",
    sess.candidates,
  );
  r = await fido2.pick(token, sess.candidates[0].accountKey, sess.candidates[0].itemId);
  check("uv required without secret", !r.ok, r);
  r = await fido2.pick(token, sess.candidates[0].accountKey, sess.candidates[0].itemId, PW, "mp");
  check("pick ok", r.ok, r);
  const gres = await p.reply;
  check("assertion result", gres.type === "result" && gres.result.id === credId && gres.result.userHandle === userId, gres);
  const ad = b64urlToBytes(gres.result.authenticatorData);
  const cdjBytes = b64urlToBytes(gres.result.clientDataJSON);
  const sigOk = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    derToP1363(b64urlToBytes(gres.result.signature)),
    concat(ad, await sha256(cdjBytes)),
  );
  check("assertion signature valid", sigOk);
  check("assertion flags UP|UV|BE|BS", ad[32] === 0x1d, ad[32]);
  const gcd = JSON.parse(new TextDecoder().decode(cdjBytes));
  check("clientData get", gcd.type === "webauthn.get" && gcd.challenge === ch2 && gcd.origin === ORIGIN, gcd);

  // get with allowCredentials of an unknown key → browser fallback
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({
    type: "request",
    kind: "get",
    options: { rpId: "example.test", challenge: ch2, allowCredentials: [{ id: "AAAA", type: "public-key" }] },
  });
  check("unknown credential → fallback", (await p.reply).type === "fallback");
  // hardware-key-only transports → fallback
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({
    type: "request",
    kind: "get",
    options: { rpId: "example.test", challenge: ch2, allowCredentials: [{ id: credId, type: "public-key", transports: ["usb"] }] },
  });
  check("usb-only → fallback", (await p.reply).type === "fallback");
  // invalid rpId
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({ type: "request", kind: "get", options: { rpId: "evil.test", challenge: ch2 } });
  const sec = await p.reply;
  check("foreign rpId → SecurityError", sec.type === "error" && sec.name === "SecurityError", sec);
  // http origin (not localhost) → fallback
  p = fakePort("http://shop.example.test/login");
  (fido2 as any).onPort(p.port);
  p.send({ type: "request", kind: "get", options: { challenge: ch2 } });
  check("http origin → fallback", (await p.reply).type === "fallback");
  // disabled setting → fallback
  await svc.setSettings({ passkeys: false });
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({ type: "request", kind: "get", options: { rpId: "example.test", challenge: ch2 } });
  check("disabled → fallback", (await p.reply).type === "fallback");
  await svc.setSettings({ passkeys: true });

  // conditional mediation: passkey offered in inline menu, pick needs verification (preferred) → dialog
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({
    type: "request",
    kind: "get",
    options: { rpId: "example.test", challenge: ch2, mediation: "conditional", userVerification: "discouraged" },
  });
  await tick();
  await tick();
  check("conditional registered", fido2.hasConditional(5, 0));
  const offered = await fido2.conditionalPasskeys(5, 0);
  check("conditional passkeys", offered.length === 1 && offered[0].userName === "alex@shop", offered);
  const ok = await fido2.conditionalPick(5, 0, offered[0].accountKey, offered[0].itemId);
  check("conditional pick (no UV)", ok);
  const cr = await p.reply;
  check("conditional assertion", cr.type === "result" && cr.result.id === credId, cr);
  const cad = b64urlToBytes(cr.result.authenticatorData);
  check("conditional flags UP only + BE|BS", cad[32] === 0x19, cad[32]);

  // abort while dialog open
  p = fakePort(ORIGIN + "/login");
  (fido2 as any).onPort(p.port);
  p.send({ type: "request", kind: "get", options: { rpId: "example.test", challenge: ch2 } });
  await tick();
  await tick();
  p.send({ type: "abort" });
  const ab = await p.reply;
  check("abort", ab.type === "error" && ab.name === "AbortError", ab);

  // passkey stays when the item is edited, and can be removed
  const pkItem = (await svc.getVault()).items.find((i) => i.login?.fido2?.length)!;
  const edited = structuredClone(pkItem);
  edited.notes = "bearbeitet";
  await svc.saveItem(pkItem.accountKey, edited, false);
  let after = await svc.findItem(pkItem.accountKey, pkItem.id);
  check("passkey kept on edit", after?.login?.passkeys === 1 && after.notes === "bearbeitet", after?.login);
  const removed = structuredClone(after!);
  removed.login!.passkeys = 0;
  removed.login!.fido2 = [];
  await svc.saveItem(pkItem.accountKey, removed, false);
  after = await svc.findItem(pkItem.accountKey, pkItem.id);
  check("passkey removed", after?.login?.passkeys === 0, after?.login);

  // ------------------------------------------------------------------ save-login prompt
  const notify = new NotificationService(svc, { async injectContentScript() {} });
  const sender = (url: string) => ({ tab: { id: 7 } as any, frameId: 0, url }) as chrome.runtime.MessageSender;
  const pending = async () => {
    const p2 = sessionData["notify:7"];
    return p2 ? notify.dataFor(p2.token) : null;
  };
  await notify.capture({ url: "", username: "alex.privat", password: "privat-geheim-1" }, sender("http://localhost:9000/login.html"));
  check("known login → no prompt", (await pending())?.kind === "none", await pending());
  await notify.capture({ url: "", username: "alex.privat", password: "neues-passwort-5" }, sender("http://localhost:9000/login.html"));
  let nd = await pending();
  check("changed password → update", nd?.kind === "update" && nd.targets.length === 1 && nd.targets[0].accountKey === A, nd);
  const up = await notify.update(sessionData["notify:7"].token, nd!.targets);
  check("update done", up.ok, up);
  const upd = (await svc.getVault()).items.find((i) => i.name === "Test-Login (privat)")!;
  check(
    "password updated + history",
    upd.login?.password === "neues-passwort-5" && upd.passwordHistory[0]?.password === "privat-geheim-1",
    upd,
  );
  await notify.capture({ url: "", username: "neu@example.test", password: "ganz-neu-6" }, sender("https://neu.example.test/signin"));
  nd = await pending();
  check("new login → save", nd?.kind === "save" && nd.accounts.length === 2, nd);
  const sv = await notify.save(sessionData["notify:7"].token, B);
  check("save done", sv.ok, sv);
  const saved = (await svc.getVault()).items.find((i) => i.login?.username === "neu@example.test");
  check(
    "saved item",
    saved?.accountKey === B &&
      saved.name === "neu.example.test" &&
      saved.login?.uris[0].uri === "https://neu.example.test" &&
      saved.type === CipherType.Login,
    saved,
  );
  // multi-step login: username first, password on the next page
  await notify.capture({ url: "", username: "zwei@schritt.test" }, sender("https://schritt.test/u"));
  await notify.capture({ url: "", username: "", password: "pw-schritt" }, sender("https://schritt.test/p"));
  nd = await pending();
  check("multi-step username", nd?.kind === "save" && nd.username === "zwei@schritt.test", nd);
  await notify.never(sessionData["notify:7"].token);
  check("never domain", await isNeverDomain("schritt.test"));
  await notify.capture({ url: "", username: "x", password: "y" }, sender("https://schritt.test/p"));
  check("never → no capture", !sessionData["notify:7"], sessionData["notify:7"]);
  // change password form: current + new
  await notify.capture(
    { url: "", username: "", currentPassword: "fam-geheim-2", newPassword: "fam-neu-7" },
    sender("http://localhost:9000/settings"),
  );
  nd = await pending();
  check(
    "change-password form → update",
    nd?.kind === "update" && nd.targets.length === 1 && nd.targets[0].name === "Test-Login (Familie)",
    nd,
  );

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
