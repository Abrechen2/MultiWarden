// Node test of the tools: Send (crypto, create/edit/delete against Vaultwarden, opened anonymously
// like a recipient), duplicate check, and where logins are filled (domain vs. exact host).
// The shareable-key test vectors come from the official Bitwarden SDK, https://github.com/bitwarden/sdk-internal
// (crate bitwarden-crypto; "GPL-3.0-only OR Bitwarden SDK License", used here under the GPL-3.0).
import { localData } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { sendKeyFromMaterial, sendPasswordHash, shareableKey } from "../src/background/sends";
import { decryptFileData, decryptString, symKeyToBytes } from "../src/crypto/bw";
import { b64decode, b64encode, utf8 } from "../src/crypto/utils";
import { findDuplicates } from "../src/shared/duplicates";
import { SendType } from "../src/shared/sends";
import { CipherType, ItemView, UriMatch } from "../src/shared/types";
import { makeMatchContext, uriMatches } from "../src/shared/uri";
import { describeScope, scopeOf, withScope } from "../src/popup/fill-scope";
import { parseSendLink, receiveSend, receiveSendFile, urlsForSend } from "../src/background/send-receive";
import { deserializeKey } from "../src/crypto/bw";
import { strengthScore, userWords } from "../src/shared/strength";
import { DEFAULT_PASSPHRASE, DEFAULT_PASSWORD, generatePassphrase, generatePassword } from "../src/shared/generator";

const PW = "Test-Passwort-123!";
const BASE = "http://localhost:8001";
let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

/** Open a Send like the web vault of a recipient: send access token, then the content. */
async function openSend(link: string, password?: string): Promise<{ status: number; send?: any; material?: Uint8Array; error?: string }> {
  const m = /#\/send\/([^/]+)\/([^/?#]+)$/.exec(link);
  if (!m) return { status: 0, error: "bad link " + link };
  const material = b64decode(m[2]);
  const form = new URLSearchParams({ grant_type: "send_access", client_id: "send", scope: "api.send.access", send_id: m[1] });
  if (password) form.set("password_hash_b64", await sendPasswordHash(password, material));
  const tok = await fetch(BASE + "/identity/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!tok.ok) return { status: tok.status, error: await tok.text() };
  const at = (await tok.json()).access_token;
  const r = await fetch(BASE + "/api/sends/access", { method: "POST", headers: { authorization: "Bearer " + at } });
  if (!r.ok) return { status: r.status, error: await r.text() };
  return { status: r.status, send: { ...(await r.json()), _token: at }, material };
}

function item(p: Partial<ItemView> & { name: string }): ItemView {
  return {
    id: Math.random().toString(36).slice(2),
    accountKey: "A",
    collectionIds: [],
    type: CipherType.Login,
    favorite: false,
    reprompt: 0,
    edit: true,
    viewPassword: true,
    fields: [],
    passwordHistory: [],
    attachments: [],
    ...p,
  } as ItemView;
}

(async () => {
  // ---------------------------------------------------------------- crypto vectors (Bitwarden SDK, shareable_key.rs)
  const k1 = await shareableKey(utf8("&/$%F1a895g67HlX"), "test_key");
  check(
    "shareable key vector (no info)",
    b64encode(symKeyToBytes(k1)) === "4PV6+PcmF2w7YHRatvyMcVQtI7zvCyssv/wFWmzjiH6Iv9altjmDkuBD1aagLVaLezbthbSe+ktR+U6qswxNnQ==",
  );
  const k2 = await shareableKey(utf8("67t9b5g67$%Dh89n"), "test_key", "test");
  check(
    "shareable key vector (info)",
    b64encode(symKeyToBytes(k2)) === "F9jVQmrACGx9VUPjuzfMYDjr726JtL300Y3Yg+VYUnVQtQ1s8oImJ5xtp1KALC9h2nav04++1LDW4iFD+infng==",
  );

  // ---------------------------------------------------------------- duplicates (pure)
  const items = [
    item({ name: "Shop", login: { username: "Alex", password: "a", uris: [{ uri: "https://www.shop.test/login" }], passkeys: 0 }, revisionDate: "2026-01-01" }),
    item({ name: "Shop alt", login: { username: "alex", password: "b", uris: [{ uri: "https://shop.test" }], passkeys: 0 }, revisionDate: "2025-01-01" }),
    item({ name: "Shop anderer Nutzer", login: { username: "kim", password: "a", uris: [{ uri: "https://shop.test" }], passkeys: 0 } }),
    item({ name: "Shop Subdomain", login: { username: "alex", password: "a", uris: [{ uri: "https://mail.shop.test" }], passkeys: 0 } }),
    item({ name: "Karte 1", type: CipherType.Card, card: { number: "4111 1111 1111 1111", brand: "Visa" } }),
    item({ name: "Karte 2", type: CipherType.Card, card: { number: "4111111111111111" } }),
    item({ name: "Gelöscht", login: { username: "alex", password: "a", uris: [{ uri: "https://shop.test" }], passkeys: 0 }, deletedDate: "2026-02-01" }),
    item({ name: "Notiz", type: CipherType.SecureNote, notes: "x" }),
    item({ name: "Notiz", type: CipherType.SecureNote, notes: "x " }),
  ];
  const g = findDuplicates(items, "site");
  const shop = g.find((x) => x.type === CipherType.Login);
  check("dup: same host (www ignored) + username (case-insensitive)", shop?.items.map((i) => i.name).join(",") === "Shop,Shop alt", shop);
  check("dup: newest first, different passwords flagged", shop?.samePassword === false && shop.label === "shop.test · Alex", shop?.label);
  check("dup: card by number", g.some((x) => x.type === CipherType.Card && x.items.length === 2));
  check("dup: notes by name and content", g.some((x) => x.type === CipherType.SecureNote && x.items.length === 2));
  check("dup: deleted, other user and other subdomain ignored", g.length === 3, g.map((x) => x.label));
  check("dup: mode with password", !findDuplicates(items, "sitePassword").some((x) => x.type === CipherType.Login));

  // ---------------------------------------------------------------- fill scope (domain vs. host)
  const ctxOther = makeMatchContext("https://mail.example.com/login", []);
  const ctxSame = makeMatchContext("https://login.example.com/x", []);
  const saved = "https://login.example.com/";
  check("domain match fills other subdomain", uriMatches(saved, null, ctxOther, UriMatch.Domain));
  check("host match only on the saved subdomain", !uriMatches(saved, UriMatch.Host, ctxOther, UriMatch.Domain) && uriMatches(saved, UriMatch.Host, ctxSame, UriMatch.Domain));
  check("global default host", !uriMatches(saved, null, ctxOther, UriMatch.Host) && uriMatches(saved, null, ctxSame, UriMatch.Host));
  const uris = [{ uri: saved, match: null }, { uri: "https://other.example.org", match: null }];
  check("scope default", scopeOf(uris) === "default");
  const host = withScope(uris, "host");
  check("scope host applied to all websites", scopeOf(host) === "host" && host.every((u) => u.match === UriMatch.Host));
  check("scope custom keeps values", scopeOf([{ uri: saved, match: UriMatch.Exact }, { uri: saved, match: null }]) === "custom");
  check("scope description", describeScope([{ uri: saved, match: UriMatch.Host }], UriMatch.Domain) === "Nur login.example.com", describeScope([{ uri: saved, match: UriMatch.Host }], UriMatch.Domain));
  check("scope description default", describeScope([{ uri: saved, match: null }], UriMatch.Domain) === "example.com und alle Subdomains");

  // ---------------------------------------------------------------- password strength (report)
  const weakOnes = ["123456", "password", "Passwort123", "Sommer2024!", "qwertz123", "aaaaaaaaaaaa", "abcdef123456"];
  check("common patterns are weak", weakOnes.every((p) => strengthScore(p) <= 2), weakOnes.map((p) => strengthScore(p)));
  check("own data counts as weak", strengthScore("alex.privat2024", userWords(["alex.privat", "alex@privat.test"])) <= 2);
  const gen = [generatePassword(DEFAULT_PASSWORD), generatePassphrase(DEFAULT_PASSPHRASE)];
  check("generated passwords are strong", gen.every((p) => strengthScore(p) === 4), gen);
  check("random 12 characters strong", strengthScore("x7#Kp2!qL9zR") === 4);

  // ---------------------------------------------------------------- Send links
  const us = parseSendLink("https://send.bitwarden.com/#AbCd_123-xyz/" + "A".repeat(22));
  check("US vanity link", us?.base === "https://send.bitwarden.com" && us.accessId === "AbCd_123-xyz" && urlsForSend(us.base, []).api === "https://api.bitwarden.com");
  const eu = parseSendLink("https://vault.bitwarden.eu/#/send/abc/" + "B".repeat(22));
  check("EU link", !!eu && urlsForSend(eu.base, []).api === "https://api.bitwarden.eu");
  const sh = parseSendLink("https://pw.example.org/vault/#/send/abc/" + "C".repeat(22));
  check("self-hosted link with path", sh?.base === "https://pw.example.org/vault" && urlsForSend(sh.base, []).identity === "https://pw.example.org/vault/identity");
  check("custom service URLs of a known account", urlsForSend("https://pw.example.org", [{ urls: { webVault: "https://pw.example.org", api: "https://api.example.org", identity: "https://id.example.org" } as any }]).api === "https://api.example.org");
  check("invalid links", !parseSendLink("https://example.org/#/send/x") && !parseSendLink("nonsense") && !parseSendLink("https://vault.example.org/#/send/a/short"));

  // ---------------------------------------------------------------- Send against Vaultwarden
  const svc = new VaultService(() => {});
  await svc.ready;
  const flows = new LoginFlows(svc, { async openLoginWindow() {}, async focusLoginWindow() {}, changed() {} });
  const f = await flows.startPassword({ server: "selfhosted", baseUrl: BASE, email: "alex@privat.test", password: PW });
  check("login", f.step === "done", f);
  await flows.ack();
  const A = svc.accounts[0].key;
  await svc.sync(A);

  let list = await svc.listSends(A);
  check("no sends yet, premium (Vaultwarden)", list.sends.length === 0 && list.premium, list);

  const deletion = new Date(Date.now() + 2 * 86400_000).toISOString();
  const text = await svc.saveSend(A, {
    type: SendType.Text,
    name: "Zugangsdaten WLAN",
    text: "Gäste-WLAN: geheim-123 🔑",
    hidden: true,
    notes: "für Besuch",
    newPassword: "sesam",
    maxAccessCount: 3,
    disabled: false,
    hideEmail: true,
    deletionDate: deletion,
  });
  check("text send created", !!text.id && text.name === "Zugangsdaten WLAN" && text.hasPassword && text.hidden === true, text);
  check("link points to the web vault", text.link.startsWith(BASE + "/#/send/" + text.accessId + "/"), text.link);
  check("stored in sync data", (localData["sync:" + A] as any).sends.length === 1);

  let o = await openSend(text.link);
  check("recipient without password is refused", o.status >= 400, o);
  o = await openSend(text.link, "falsch");
  check("recipient with wrong password is refused", o.status >= 400, o.status);
  o = await openSend(text.link, "sesam");
  check("recipient opens the send", o.status === 200, o);
  const rk = await sendKeyFromMaterial(o.material!);
  check("recipient decrypts name and text", (await decryptString(o.send.name, rk)) === "Zugangsdaten WLAN" && (await decryptString(o.send.text.text, rk)) === "Gäste-WLAN: geheim-123 🔑");
  check("hidden flag + hidden e-mail", o.send.text.hidden === true && !o.send.creatorIdentifier, o.send);

  await svc.sync(A);
  list = await svc.listSends(A);
  const counted = list.sends.find((s) => s.id === text.id)!;
  check("access counted after sync", counted.accessCount === 1, counted.accessCount);

  // edit: new name, keep password and key
  const edited = await svc.saveSend(A, {
    id: text.id,
    type: SendType.Text,
    name: "WLAN Gäste",
    text: "neu",
    hidden: false,
    maxAccessCount: null,
    disabled: false,
    hideEmail: false,
    deletionDate: deletion,
  });
  check("edit keeps link and password", edited.link === text.link && edited.hasPassword && edited.name === "WLAN Gäste", edited);
  o = await openSend(text.link, "sesam");
  check("edited content for recipient", o.status === 200 && (await decryptString(o.send.text.text, rk)) === "neu");

  const nopw = await svc.removeSendPassword(A, text.id);
  check("password removed", !nopw.hasPassword);
  o = await openSend(text.link);
  check("opens without password now", o.status === 200, o);

  // disabled send cannot be opened
  await svc.saveSend(A, { id: text.id, type: SendType.Text, name: "WLAN Gäste", text: "neu", disabled: true, hideEmail: false, deletionDate: deletion });
  o = await openSend(text.link);
  check("disabled send refused", o.status >= 400, o.status);

  // file send
  const content = utf8("Hallo Datei-Send\n".repeat(1000));
  const up = svc.sendUploadStart(A, "notiz.txt", content.length);
  svc.attachmentUploadChunk(up, b64encode(content));
  const file = await svc.saveSend(A, { type: SendType.File, name: "Datei", disabled: false, hideEmail: false, deletionDate: deletion, uploadId: up });
  check("file send created", file.type === SendType.File && file.file?.fileName === "notiz.txt" && !!file.file?.id, file);
  o = await openSend(file.link);
  check("recipient sees the file", o.status === 200 && o.send.file?.id === file.file!.id, o);
  const fk = await sendKeyFromMaterial(o.material!);
  check("recipient decrypts file name", (await decryptString(o.send.file.fileName, fk)) === "notiz.txt");
  const dl = await fetch(`${BASE}/api/sends/access/file/${file.file!.id}`, { method: "POST", headers: { authorization: "Bearer " + o.send._token } });
  const dlj = await dl.json();
  const encFile = new Uint8Array(await (await fetch(dlj.url)).arrayBuffer());
  const plain = await decryptFileData(encFile, fk);
  check("recipient downloads and decrypts the file", new TextDecoder().decode(plain) === new TextDecoder().decode(content), plain.length);

  // upload id cannot be reused / upload must be complete
  let threw = false;
  try {
    await svc.saveSend(A, { type: SendType.File, name: "x", disabled: false, hideEmail: false, deletionDate: deletion, uploadId: up });
  } catch {
    threw = true;
  }
  check("upload used only once", threw);

  // receive (as MultiWarden opens a Send link)
  await svc.saveSend(A, { id: text.id, type: SendType.Text, name: "WLAN Gäste", text: "neu", newPassword: "sesam2", disabled: false, hideEmail: false, deletionDate: deletion });
  let rr: any = await receiveSend({ link: text.link }, []);
  check("receive: password needed", rr.status === "password", rr);
  rr = await receiveSend({ link: text.link, password: "falsch" }, []);
  check("receive: wrong password", rr.status === "wrongPassword", rr);
  rr = await receiveSend({ link: text.link, password: "sesam2" }, []);
  check("receive: text decrypted", rr.status === "ok" && rr.send.name === "WLAN Gäste" && rr.send.text === "neu" && rr.send.type === SendType.Text, rr);
  check("receive: sender shown unless hidden", rr.send?.creatorIdentifier === "alex@privat.test", rr.send?.creatorIdentifier);
  rr = await receiveSend({ link: file.link }, []);
  check("receive: file metadata", rr.status === "ok" && rr.send.file?.fileName === "notiz.txt", rr);
  const fd = await receiveSendFile(file.link, rr.send.id, rr.send.file.id, rr.auth, []);
  const fbytes = await decryptFileData(new Uint8Array(await (await fetch(fd.url)).arrayBuffer()), deserializeKey(fd.key));
  check("receive: file downloaded and decrypted", new TextDecoder().decode(fbytes) === new TextDecoder().decode(content));
  rr = await receiveSend({ link: BASE + "/#/send/AAAAAAAAAAAAAAAAAAAAAA/" + text.link.split("/").pop() }, []);
  check("receive: unknown Send", rr.status === "unavailable", rr);

  // delete
  await svc.deleteSend(A, text.id);
  await svc.deleteSend(A, file.id);
  list = await svc.listSends(A);
  check("sends deleted", list.sends.length === 0, list.sends.length);
  o = await openSend(text.link);
  check("deleted send gone for recipients", o.status >= 400);

  // sync keeps them in the list
  const again = await svc.saveSend(A, { type: SendType.Text, name: "Nach Sync", text: "t", disabled: false, hideEmail: false, deletionDate: deletion });
  await svc.sync(A);
  list = await svc.listSends(A);
  check("send present after full sync", list.sends.some((s) => s.id === again.id && s.name === "Nach Sync"));
  await svc.deleteSend(A, again.id);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
