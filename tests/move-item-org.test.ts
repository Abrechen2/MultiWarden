// "Move into my personal vault" end to end with a real organization cipher: the copy in the own personal
// vault opens with the user key only (fields, passkey, attachment), carries no organization data, and the
// original goes to the organization's trash only after a complete copy of its current server version.
// Read-only items and items changed on the server meanwhile are not moved. Runs offline (fetch is stubbed).
import { localData, sessionData } from "./chrome-stub";
import {
  decryptFileData,
  decryptKey,
  decryptString,
  encryptBytes,
  encryptFileData,
  encryptKey,
  encryptString,
  generateCbcHmacKey,
  generateRsaKeyPair,
  rsaEncryptKey,
  serializeKey,
} from "../src/crypto/bw";
import { buildCipherRequest, cipherKeyFor, decryptCipher } from "../src/background/vault-crypto";
import { VaultService } from "../src/background/vault-service";
import { CipherType, ItemView } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const rejects = async (p: Promise<unknown>) => p.then(() => false, () => true);

const A = "a.test|user-a";
const FILE = new TextEncoder().encode("Netzplan – intern");
const PK8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg-org-test-key";

(async () => {
  const userKey = generateCbcHmacKey();
  const orgKey = generateCbcHmacKey();
  const rsa = await generateRsaKeyPair();
  const keys = { userKey, orgKeys: new Map([["org1", orgKey]]) };

  const view: ItemView = {
    id: "",
    accountKey: A,
    organizationId: "org1",
    folderId: null,
    collectionIds: ["col1"],
    type: CipherType.Login,
    name: "Router",
    notes: "Admin-Zugang",
    favorite: false,
    reprompt: 0,
    edit: true,
    viewPassword: true,
    login: { username: "admin", password: "r0uter-PW", totp: "", uris: [{ uri: "https://10.0.0.1", match: null }], passkeys: 0 },
    fields: [{ name: "Seriennummer", value: "SN-42", type: 0, linkedId: null }],
    passwordHistory: [{ password: "alt-PW", lastUsedDate: "2025-12-01T00:00:00.000Z" }],
    attachments: [],
  };
  const passkey = {
    credentialId: "cred-org",
    keyType: "public-key",
    keyAlgorithm: "ECDSA",
    keyCurve: "P-256",
    keyValue: PK8,
    rpId: "10.0.0.1",
    rpName: "Router",
    userHandle: "dXNlcg",
    userName: "admin",
    userDisplayName: "Admin",
    counter: "0",
    discoverable: "true",
    creationDate: "2026-02-03T04:05:06.000Z",
  };
  const req = await buildCipherRequest(view, null, keys, "user-a", { importPasskeys: [passkey] });
  const orgCipherKey = await decryptKey(req.key, orgKey);
  const fileKey = generateCbcHmacKey();
  const file = await encryptFileData(FILE, fileKey);
  const base = {
    ...req,
    organizationId: "org1",
    collectionIds: ["col1"],
    revisionDate: "2026-03-01T00:00:00.000Z",
    creationDate: "2026-01-01T00:00:00.000Z",
    viewPassword: true,
    attachments: [
      {
        id: "att1",
        key: await encryptKey(fileKey, orgCipherKey),
        fileName: await encryptString("netzplan.pdf", orgCipherKey),
        size: String(file.length),
        sizeName: "1 KB",
      },
    ],
  };
  const orgItem = { ...base, id: "org-item", edit: true };
  const readOnly = { ...base, id: "ro-item", edit: false };

  const profile = {
    id: "user-a",
    email: "user-a@a.test",
    privateKey: await encryptBytes(rsa.privateKey, userKey),
    organizations: [{ id: "org1", name: "Firma", key: await rsaEncryptKey(orgKey, rsa.publicKey), type: 2, status: 2, enabled: true }],
  };
  const syncA = { profile, folders: [], collections: [], ciphers: [orgItem, readOnly], policies: [] as any[] };
  localData.accounts = [
    {
      id: "user-a",
      key: A,
      email: "user-a@a.test",
      server: "selfhosted",
      urls: { base: "https://a.test", webVault: "https://a.test", api: "https://a.test/api", identity: "https://a.test/identity" },
      kdf: { kdf: 0, iterations: 600000 },
      salt: "user-a@a.test",
      encUserKey: "x",
      accessToken: "token-a",
      accessTokenExp: Date.now() / 1000 + 86400,
      refreshToken: "r",
      clientId: "browser",
      color: "#336699",
      order: 0,
      addedAt: 0,
    },
  ];
  localData["sync:" + A] = syncA;
  sessionData["uk:" + A] = serializeKey(userKey);

  // --- server stub: the org item may change on the server ("changedOnServer"), deletes are recorded
  const requests: { method: string; path: string; body?: any }[] = [];
  let created: any = null;
  let attachmentReq: any = null;
  let uploaded: Uint8Array | null = null;
  let changedOnServer = false;
  let changeDuringCopy = false;
  const trashed = new Set<string>();
  const serverCiphers = () =>
    [orgItem, readOnly]
      .filter((c) => !trashed.has(c.id))
      .map((c) => (changedOnServer && c.id === "org-item" ? { ...c, revisionDate: "2026-06-01T00:00:00.000Z" } : c))
      .concat(created ? [created] : []);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    let body: any = init.body;
    if (typeof body === "string") body = JSON.parse(body);
    const p = url.pathname;
    requests.push({ method, path: p, body });
    if (method === "GET" && p === "/api/sync") return json({ ...syncA, ciphers: serverCiphers() });
    if (method === "GET" && /^\/api\/ciphers\/[^/]+\/attachment\/att1$/.test(p)) return json({ id: "att1", url: "https://a.test/files/att1" });
    if (method === "GET" && p === "/files/att1") return new Response(file.slice().buffer as ArrayBuffer, { status: 200 });
    if (method === "POST" && p === "/api/ciphers") {
      if (changeDuringCopy) changedOnServer = true;
      created = { ...body, id: "new1", revisionDate: "2026-05-01T00:00:00.000Z", creationDate: "2026-05-01T00:00:00.000Z", edit: true, viewPassword: true, attachments: [] };
      return json(created);
    }
    if (method === "POST" && p === "/api/ciphers/new1/attachment/v2") {
      attachmentReq = body;
      return json({ attachmentId: "natt1", fileUploadType: 0, url: "https://a.test/api/ciphers/new1/attachment/natt1" });
    }
    if (method === "POST" && p === "/api/ciphers/new1/attachment/natt1") {
      uploaded = new Uint8Array((await (body as FormData).get("data")!.arrayBuffer()) as ArrayBuffer);
      created = { ...created, attachments: [{ id: "natt1", key: attachmentReq.key, fileName: attachmentReq.fileName, size: String(uploaded.length) }] };
      return json({});
    }
    if (method === "GET" && p === "/api/ciphers/new1/details") return json(created);
    const del = /^\/api\/ciphers\/([^/]+)\/delete$/.exec(p);
    if (method === "PUT" && del) {
      trashed.add(del[1]);
      return json({});
    }
    return json({ message: "unexpected " + method + " " + p }, 500);
  };

  const svc = new VaultService(() => {});
  await svc.ready;

  // --- complete move
  const r = await svc.moveItemToPersonal(A, "org-item", null).catch((e: any) => ({ error: e?.message ?? String(e) }) as any);
  check("move succeeds and removes the original", r?.id === "new1" && r.originalRemoved === true, r);
  check("copy carries no organization data", !!created && !created.organizationId && !(created.collectionIds ?? []).length, created && { org: created.organizationId, cols: created.collectionIds });
  check("copy's key opens with the user key", !(await rejects(decryptKey(created.key, userKey))));
  check("copy's key does not open with the org key", await rejects(decryptKey(created.key, orgKey)));
  const copyView = await decryptCipher(A, { ...created, attachments: [] }, { userKey, orgKeys: new Map() });
  check(
    "fields, notes and history copied",
    copyView.login?.password === "r0uter-PW" && copyView.notes === "Admin-Zugang" && copyView.fields[0]?.value === "SN-42" && copyView.passwordHistory[0]?.password === "alt-PW",
    copyView,
  );
  const newKey = await cipherKeyFor(created, { userKey, orgKeys: new Map() });
  check("passkey private key re-encrypted for the personal copy", (await decryptString(created.login.fido2Credentials[0].keyValue, newKey)) === PK8);
  if (attachmentReq && uploaded) {
    const fk = await decryptKey(attachmentReq.key, newKey);
    check("attachment re-encrypted for the personal copy", new TextDecoder().decode(await decryptFileData(uploaded, fk)) === new TextDecoder().decode(FILE));
  } else check("attachment uploaded", false);
  const delIdx = requests.findIndex((x) => x.method === "PUT" && x.path === "/api/ciphers/org-item/delete");
  const lastCopyIdx = requests.map((x) => x.method).lastIndexOf("POST");
  check("original trashed only after the copy is complete", delIdx > lastCopyIdx && lastCopyIdx >= 0, requests.map((x) => x.method + " " + x.path));
  check("original trashed, not deleted permanently", !requests.some((x) => x.method === "DELETE"));

  // --- changed on the server before the move: the copy is made from the current server version
  trashed.clear();
  created = null;
  requests.length = 0;
  changedOnServer = true; // edited by someone else after our last sync
  const r2 = await svc.moveItemToPersonal(A, "org-item", null).catch((e: any) => ({ error: e?.message ?? String(e) }) as any);
  const firstSync = requests.findIndex((x) => x.method === "GET" && x.path === "/api/sync");
  const firstPost = requests.findIndex((x) => x.method === "POST");
  check("synced before copying", firstSync >= 0 && firstSync < firstPost, requests.map((x) => x.method + " " + x.path));
  check("then moved", r2?.originalRemoved === true, r2);

  // --- changed on the server while copying: the original stays
  trashed.clear();
  created = null;
  requests.length = 0;
  changedOnServer = false;
  await svc.sync(A);
  changeDuringCopy = true;
  const r3 = await svc.moveItemToPersonal(A, "org-item", null).catch((e: any) => ({ error: e?.message ?? String(e) }) as any);
  check("change during the copy keeps the original", r3?.id === "new1" && r3.originalRemoved === false && /geändert/.test(r3.removeError ?? ""), r3);
  check("change during the copy: nothing trashed", !requests.some((x) => x.method === "PUT" && x.path.endsWith("/delete")));
  changeDuringCopy = false;
  changedOnServer = false;

  // --- read-only item: refused before anything is written
  trashed.clear();
  created = null;
  requests.length = 0;
  const r4 = await svc.moveItemToPersonal(A, "ro-item", null).then(
    (v) => ({ ok: true, v }),
    (e: any) => ({ ok: false, error: String(e?.message ?? e) }),
  );
  check("read-only item refused", r4.ok === false && /Bearbeitungsrecht/.test((r4 as any).error), r4);
  check("read-only refusal writes nothing", requests.every((x) => x.method === "GET"), requests.map((x) => x.method + " " + x.path));

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
