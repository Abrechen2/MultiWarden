// "Copy into another account": the copy is re-encrypted for the target account (fields, passkeys,
// attachments), nothing in it opens with the source keys, and items whose password the organization
// hides or targets whose policies forbid personal items are refused. Runs offline (fetch is stubbed).
import { localData, sessionData } from "./chrome-stub";
import {
  decryptFileData,
  decryptKey,
  decryptString,
  encryptFileData,
  encryptKey,
  encryptString,
  generateCbcHmacKey,
  isEncString,
  serializeKey,
  SymKey,
} from "../src/crypto/bw";
import { AccountKeys, buildCipherRequest, cipherKeyFor, decryptCipher } from "../src/background/vault-crypto";
import { VaultService } from "../src/background/vault-service";
import { accountPolicies } from "../src/shared/policies";
import { CipherType, ItemView } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const rejects = async (p: Promise<unknown>) => p.then(() => false, () => true);
/** Rejects with an error message containing `part` (refused for the right reason). */
const rejectsWith = async (p: Promise<unknown>, part: string) => p.then(() => false, (e) => String(e?.message ?? e).includes(part));
const keysOf = (userKey: SymKey): AccountKeys => ({ userKey, orgKeys: new Map() });

const A = "a.test|user-a";
const B = "b.test|user-b";
const C = "c.test|user-c";
const FILE = new TextEncoder().encode("Kontoauszug 2026 – geheim");
const PK8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg-test-private-key";

function account(key: string, host: string, policies?: any) {
  const id = key.split("|")[1];
  return {
    id,
    key,
    email: id + "@" + host,
    server: "selfhosted",
    urls: { base: `https://${host}`, webVault: `https://${host}`, api: `https://${host}/api`, identity: `https://${host}/identity` },
    kdf: { kdf: 0, iterations: 600000 },
    salt: id + "@" + host,
    encUserKey: "x",
    accessToken: "token-" + id,
    accessTokenExp: Date.now() / 1000 + 86400,
    refreshToken: "r",
    clientId: "browser",
    color: "#336699",
    order: 0,
    addedAt: 0,
    policies,
  };
}

/** Every EncString inside an object (recursively). */
function encStrings(o: any, out: string[] = []): string[] {
  if (typeof o === "string" && isEncString(o)) out.push(o);
  else if (Array.isArray(o)) o.forEach((x) => encStrings(x, out));
  else if (o && typeof o === "object") Object.values(o).forEach((x) => encStrings(x, out));
  return out;
}

(async () => {
  const keyA = generateCbcHmacKey();
  const keyB = generateCbcHmacKey();
  const keyC = generateCbcHmacKey();

  // --- source item in account A: login, URIs with match settings, TOTP, custom fields, history, passkey, attachment
  const srcView: ItemView = {
    id: "",
    accountKey: A,
    organizationId: null,
    folderId: "fA",
    collectionIds: [],
    type: CipherType.Login,
    name: "Hausbank",
    notes: "Notiz mit Ümlauten",
    favorite: true,
    reprompt: 1,
    edit: true,
    viewPassword: true,
    login: {
      username: "alex",
      password: "s3cret-PW",
      totp: "otpauth://totp/Bank?secret=JBSWY3DPEHPK3PXP",
      uris: [
        { uri: "https://bank.example/login", match: 3 },
        { uri: "https://app.bank.example", match: null },
      ],
      passwordRevisionDate: "2026-01-02T03:04:05.000Z",
      autofillOnPageLoad: true,
      passkeys: 0,
    },
    fields: [
      { name: "Kundennummer", value: "12345", type: 0, linkedId: null },
      { name: "PIN", value: "9876", type: 1, linkedId: null },
      { name: "Aktiv", value: "true", type: 2, linkedId: null },
      { name: "Verknüpft", value: "", type: 3, linkedId: 100 },
    ],
    passwordHistory: [{ password: "old-pw-1", lastUsedDate: "2025-12-01T00:00:00.000Z" }],
    attachments: [],
  };
  const passkey = {
    credentialId: "cred-123",
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue: PK8,
    rpId: "bank.example",
    rpName: "Bank",
    userHandle: "dXNlcg",
    userName: "alex",
    userDisplayName: "Alex",
    counter: "7",
    discoverable: "true",
    creationDate: "2026-02-03T04:05:06.000Z",
  };
  const srcReq = await buildCipherRequest(srcView, null, keysOf(keyA), "user-a", { importPasskeys: [passkey] });
  const srcCipherKey = await decryptKey(srcReq.key, keyA);
  const srcFileKey = generateCbcHmacKey();
  const srcFile = await encryptFileData(FILE, srcFileKey);
  const srcCipher = {
    ...srcReq,
    id: "src1",
    revisionDate: "2026-03-01T00:00:00.000Z",
    creationDate: "2026-01-01T00:00:00.000Z",
    edit: true,
    viewPassword: true,
    collectionIds: [],
    attachments: [
      {
        id: "att1",
        key: await encryptKey(srcFileKey, srcCipherKey),
        fileName: await encryptString("auszug.pdf", srcCipherKey),
        size: String(srcFile.length),
        sizeName: "1 KB",
      },
    ],
  };
  // org item whose password the organization hides (read-only, "hide passwords")
  const hiddenReq = await buildCipherRequest(
    { ...srcView, reprompt: 0, login: { ...srcView.login!, passkeys: 0 } },
    null,
    keysOf(keyA),
    "user-a",
  );
  const hiddenCipher = { ...hiddenReq, id: "hidden1", name: await encryptString("Versteckt", await decryptKey(hiddenReq.key, keyA)), edit: false, viewPassword: false, collectionIds: [], attachments: [] };
  const trashedCipher = { ...hiddenReq, id: "trash1", edit: true, viewPassword: true, deletedDate: "2026-04-01T00:00:00.000Z", collectionIds: [], attachments: [] };

  const syncA = {
    profile: { id: "user-a", email: "user-a@a.test", organizations: [] },
    folders: [{ id: "fA", name: await encryptString("Banking", keyA) }],
    collections: [],
    ciphers: [srcCipher, hiddenCipher, trashedCipher],
    policies: [],
  };
  const syncB = {
    profile: { id: "user-b", email: "user-b@b.test", organizations: [] },
    folders: [
      { id: "fB1", name: await encryptString("Privat", keyB) },
      { id: "fB2", name: await encryptString("Banking", keyB) },
    ],
    collections: [],
    ciphers: [] as any[],
    policies: [],
  };
  // account C: member of an organization with "Remove individual vault" (data ownership)
  const syncC = {
    profile: {
      id: "user-c",
      email: "user-c@c.test",
      organizations: [{ id: "orgC", name: "Firma", type: 2, status: 2, enabled: true, usePolicies: true }],
    },
    folders: [],
    collections: [],
    ciphers: [],
    policies: [{ organizationId: "orgC", type: 5, enabled: true, data: null }],
  };

  localData.accounts = [account(A, "a.test"), account(B, "b.test"), account(C, "c.test", accountPolicies(syncC))];
  localData["sync:" + A] = syncA;
  localData["sync:" + B] = syncB;
  localData["sync:" + C] = syncC;
  sessionData["uk:" + A] = serializeKey(keyA);
  sessionData["uk:" + B] = serializeKey(keyB);
  sessionData["uk:" + C] = serializeKey(keyC);

  // --- network stub: two servers; B stores created ciphers and attachments
  const requests: { method: string; url: string; body?: any }[] = [];
  let created: any = null;
  let attachmentReq: any = null;
  let uploaded: Uint8Array | null = null;
  let failDownload = false;
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    let body: any = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    requests.push({ method, url, body });
    const p = new URL(url).pathname;
    if (url.startsWith("https://a.test")) {
      if (method === "GET" && p === "/api/ciphers/src1/attachment/att1") return json({ id: "att1", url: "https://a.test/files/att1" });
      if (method === "GET" && p === "/files/att1")
        return failDownload ? new Response("nope", { status: 500 }) : new Response(srcFile.slice().buffer as ArrayBuffer, { status: 200 });
      return json({ message: "unexpected " + method + " " + p }, 500);
    }
    if (url.startsWith("https://b.test")) {
      if (method === "POST" && p === "/api/ciphers") {
        created = { ...body, id: "new1", revisionDate: "2026-05-01T00:00:00.000Z", creationDate: "2026-05-01T00:00:00.000Z", attachments: [] };
        return json(created);
      }
      if (method === "POST" && p === "/api/ciphers/new1/attachment/v2") {
        attachmentReq = body;
        return json({ attachmentId: "natt1", fileUploadType: 0, url: "https://b.test/api/ciphers/new1/attachment/natt1" });
      }
      if (method === "POST" && p === "/api/ciphers/new1/attachment/natt1") {
        uploaded = new Uint8Array(await (body as FormData).get("data")!.arrayBuffer() as ArrayBuffer);
        created = {
          ...created,
          revisionDate: "2026-05-01T00:00:01.000Z",
          attachments: [{ id: "natt1", key: attachmentReq.key, fileName: attachmentReq.fileName, size: String(uploaded.length) }],
        };
        return json({});
      }
      if (method === "GET" && p === "/api/ciphers/new1/details") return json(created);
      if (method === "GET" && p === "/api/sync") return json({ ...syncB, ciphers: created ? [created] : [] });
      return json({ message: "unexpected " + method + " " + p }, 500);
    }
    return json({ message: "unexpected host" }, 500);
  };

  const svc = new VaultService(() => {});
  await svc.ready;
  const copy = (svc as any).copyItemToAccount?.bind(svc);
  check("copyItemToAccount exists", typeof copy === "function");
  if (typeof copy !== "function") {
    console.log(`${failed + 1} FAILED`);
    process.exit(1);
  }

  // --- the copy
  const res = await copy(A, "src1", B, "fB2").catch((e: any) => ({ error: e?.message ?? String(e) }));
  check("copy succeeds", res?.id === "new1" && Array.isArray(res.attachmentsFailed) && !res.attachmentsFailed.length, res);
  check("cipher created in the personal vault of B", !!created && created.organizationId === null && created.folderId === "fB2", created?.folderId);
  check("encryptedFor = target user", created?.encryptedFor === "user-b", created?.encryptedFor);

  const view = await decryptCipher(B, { ...created, attachments: [] }, keysOf(keyB));
  check("name decrypts with B", view.name === "Hausbank", view.name);
  check("notes", view.notes === srcView.notes, view.notes);
  check("favorite + reprompt kept", view.favorite === true && view.reprompt === 1, [view.favorite, view.reprompt]);
  check("username/password", view.login?.username === "alex" && view.login?.password === "s3cret-PW", view.login);
  check("totp", view.login?.totp === srcView.login!.totp, view.login?.totp);
  check(
    "URIs incl. match settings",
    JSON.stringify(view.login?.uris) === JSON.stringify(srcView.login!.uris),
    view.login?.uris,
  );
  check("passwordRevisionDate + autofillOnPageLoad", view.login?.passwordRevisionDate === srcView.login!.passwordRevisionDate && view.login?.autofillOnPageLoad === true);
  check(
    "custom fields (text, hidden, boolean, linked)",
    JSON.stringify(view.fields.map((f) => [f.name, f.value, f.type, f.linkedId])) ===
      JSON.stringify(srcView.fields.map((f) => [f.name, f.value, f.type, f.linkedId])),
    view.fields,
  );
  check("password history", view.passwordHistory.length === 1 && view.passwordHistory[0].password === "old-pw-1", view.passwordHistory);
  check("passkey metadata", view.login?.passkeys === 1 && view.login?.fido2?.[0]?.credentialId === "cred-123" && view.login.fido2[0].counter === 7, view.login?.fido2);
  const newCipherKey = await cipherKeyFor(created, keysOf(keyB));
  const fido = created.login.fido2Credentials[0];
  check("passkey private key re-encrypted for B", (await decryptString(fido.keyValue, newCipherKey)) === PK8);
  check("passkey creationDate kept", fido.creationDate === passkey.creationDate, fido.creationDate);

  // nothing in the request opens with the source keys
  const encs = encStrings({ ...created, attachments: undefined });
  let leaked = 0;
  for (const s of encs)
    for (const k of [keyA, srcCipherKey]) if (!(await rejects(decryptString(s, k)))) leaked++;
  check("no field decryptable with source keys", encs.length > 20 && leaked === 0, { encs: encs.length, leaked });
  check("new item has its own cipher key", !(await rejects(decryptKey(created.key, keyB))) && (await rejects(decryptKey(created.key, keyA))));

  // attachment re-uploaded, encrypted for B
  check("attachment announced", !!attachmentReq && isEncString(attachmentReq.key) && isEncString(attachmentReq.fileName));
  if (attachmentReq && uploaded) {
    check("attachment name decrypts with B", (await decryptString(attachmentReq.fileName, newCipherKey)) === "auszug.pdf");
    const fk = await decryptKey(attachmentReq.key, newCipherKey);
    const plain = await decryptFileData(uploaded, fk);
    check("attachment content decrypts with B", new TextDecoder().decode(plain) === new TextDecoder().decode(FILE));
    check("attachment not decryptable with source file key", await rejects(decryptFileData(uploaded, srcFileKey)));
    check("attachment file key not the source one", await rejects(decryptKey(attachmentReq.key, srcCipherKey)));
  } else check("attachment uploaded", false);

  // source untouched, target synced
  check(
    "no write to the source account",
    !requests.some((r) => r.url.startsWith("https://a.test") && r.method !== "GET"),
    requests.filter((r) => r.url.startsWith("https://a.test")).map((r) => r.method + " " + r.url),
  );
  check("target synced afterwards", requests.some((r) => r.url === "https://b.test/api/sync?excludeDomains=false"));
  check("copy visible in target vault", !!(await svc.findItem(B, "new1")));
  check("original still in source vault", (await svc.findItem(A, "src1"))?.name === "Hausbank");

  // --- failing attachment: item stays, failure reported
  failDownload = true;
  created = null;
  attachmentReq = null;
  const r2 = await copy(A, "src1", B, null).catch((e: any) => ({ error: e?.message ?? String(e) }));
  check(
    "attachment failure reported, item kept",
    r2?.id === "new1" && JSON.stringify(r2.attachmentsFailed) === JSON.stringify(["auszug.pdf"]),
    r2,
  );
  check("no folder → folderId null", created?.folderId === null, created?.folderId);
  failDownload = false;

  // --- refusals
  const before = requests.length;
  check("hidden password refused", await rejectsWith(copy(A, "hidden1", B, null), "verborgen"));
  check("trashed item refused", await rejectsWith(copy(A, "trash1", B, null), "Papierkorb"));
  check("same account refused", await rejectsWith(copy(A, "src1", A, null), "anderes Konto"));
  check("target with 'remove individual vault' policy refused", await rejectsWith(copy(A, "src1", C, null), "Richtlinie"));
  check("unknown target folder refused", await rejectsWith(copy(A, "src1", B, "fA"), "Ordner"));
  await svc.lock(B);
  check("locked target refused", await rejectsWith(copy(A, "src1", B, null), "gesperrt"));
  check("refusals sent nothing", requests.slice(before).every((r) => r.method === "GET"), requests.slice(before).map((r) => r.method + " " + r.url));

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
