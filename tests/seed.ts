// Seeds local Vaultwarden instances with test accounts, folders, items and an organization.
// Usage: node seed.cjs
import {
  deriveMasterKey,
  masterPasswordHash,
  stretchMasterKey,
  generateCbcHmacKey,
  encryptKey,
  encryptString,
  encryptBytes,
  encryptFileData,
  generateRsaKeyPair,
  rsaEncrypt,
  symKeyToBytes,
  KdfType,
  KdfConfig,
  SymKey,
  b64encode,
  sha256,
} from "../src/crypto/bw";
import { utf8 } from "../src/crypto/utils";

const PW = "Test-Passwort-123!";

async function j(url: string, init: any = {}) {
  const r = await fetch(url, init);
  const t = await r.text();
  let body: any = t;
  try {
    body = JSON.parse(t);
  } catch {}
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${r.status} ${t.slice(0, 300)}`);
  return body;
}

interface Session {
  base: string;
  token: string;
  userKey: SymKey;
  userId: string;
  publicKey: Uint8Array;
}

async function register(base: string, email: string, kdf: KdfConfig, name: string) {
  const mk = await deriveMasterKey(PW, email, kdf);
  const hash = await masterPasswordHash(mk, PW);
  const userKey = generateCbcHmacKey();
  const encUserKey = await encryptKey(userKey, await stretchMasterKey(mk));
  const kp = await generateRsaKeyPair();
  const encPriv = await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key");
  const tok = await j(base + "/identity/accounts/register/send-verification-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, name }),
  });
  await j(base + "/identity/accounts/register/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      emailVerificationToken: tok,
      masterPasswordHash: hash,
      masterPasswordHint: null,
      userSymmetricKey: encUserKey,
      userAsymmetricKeys: { publicKey: b64encode(kp.publicKey), encryptedPrivateKey: encPriv },
      kdf: kdf.kdf,
      kdfIterations: kdf.iterations,
      kdfMemory: kdf.memory,
      kdfParallelism: kdf.parallelism,
    }),
  });
  return { mk, hash, userKey, publicKey: kp.publicKey };
}

async function login(base: string, email: string, hash: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "password",
    username: email,
    password: hash,
    scope: "api offline_access",
    client_id: "web",
    deviceType: "9",
    deviceIdentifier: crypto.randomUUID(),
    deviceName: "seed",
  });
  const r = await j(base + "/identity/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.access_token;
}

async function api(s: Session, method: string, path: string, body?: any) {
  return j(s.base + "/api" + path, {
    method,
    headers: { Authorization: "Bearer " + s.token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const e = (v: string | undefined, k: SymKey) => (v ? encryptString(v, k) : Promise.resolve(null));

async function makeCipher(s: Session, ownerKey: SymKey, c: any, orgId?: string, collectionIds?: string[]) {
  const ck = generateCbcHmacKey();
  const body: any = {
    type: c.type,
    folderId: c.folderId ?? null,
    organizationId: orgId ?? null,
    name: await e(c.name, ck),
    notes: await e(c.notes, ck),
    favorite: !!c.favorite,
    reprompt: 0,
    key: await encryptKey(ck, ownerKey),
    encryptedFor: s.userId,
    fields: await Promise.all(
      (c.fields ?? []).map(async (f: any) => ({ type: f.type ?? 0, name: await e(f.name, ck), value: await e(f.value, ck) })),
    ),
  };
  if (c.type === 1) {
    body.login = {
      username: await e(c.username, ck),
      password: await e(c.password, ck),
      totp: await e(c.totp, ck),
      uris: await Promise.all(
        (c.uris ?? []).map(async (u: string) => ({
          uri: await e(u, ck),
          match: null,
          uriChecksum: await encryptString(b64encode(await sha256(utf8(u))), ck),
        })),
      ),
    };
  }
  if (c.type === 2) body.secureNote = { type: 0 };
  if (c.type === 3)
    body.card = Object.fromEntries(await Promise.all(Object.entries(c.card).map(async ([k, v]) => [k, await e(v as string, ck)])));
  if (c.type === 4)
    body.identity = Object.fromEntries(await Promise.all(Object.entries(c.identity).map(async ([k, v]) => [k, await e(v as string, ck)])));
  if (c.type === 5)
    body.sshKey = Object.fromEntries(await Promise.all(Object.entries(c.sshKey).map(async ([k, v]) => [k, await e(v as string, ck)])));
  const res = orgId ? await api(s, "POST", "/ciphers/create", { cipher: body, collectionIds }) : await api(s, "POST", "/ciphers", body);
  return { ...res, _ck: ck };
}

/** Upload an encrypted attachment (v2 API, own attachment key like current clients). */
async function addAttachment(s: Session, cipher: any, fileName: string, content: Uint8Array) {
  const ck: SymKey = cipher._ck;
  const attKey = generateCbcHmacKey();
  const data = await encryptFileData(content, attKey);
  const r = await api(s, "POST", `/ciphers/${cipher.id}/attachment/v2`, {
    key: await encryptKey(attKey, ck),
    fileName: await encryptString(fileName, ck),
    fileSize: data.length,
    adminRequest: false,
  });
  const fd = new FormData();
  fd.append("data", new Blob([data.slice().buffer as ArrayBuffer]), "blob");
  const up = await fetch(s.base + "/api/ciphers/" + cipher.id + "/attachment/" + r.attachmentId, {
    method: "POST",
    headers: { Authorization: "Bearer " + s.token },
    body: fd,
  });
  if (!up.ok) throw new Error("attachment upload " + up.status + " " + (await up.text()));
}

async function makeLegacyCipher(s: Session, ownerKey: SymKey, c: any) {
  // item without its own cipher key (older clients)
  const body: any = {
    type: 1,
    folderId: c.folderId ?? null,
    organizationId: null,
    name: await e(c.name, ownerKey),
    notes: null,
    favorite: false,
    reprompt: 0,
    encryptedFor: s.userId,
    login: {
      username: await e(c.username, ownerKey),
      password: await e(c.password, ownerKey),
      uris: await Promise.all((c.uris ?? []).map(async (u: string) => ({ uri: await e(u, ownerKey), match: c.match ?? null }))),
    },
  };
  return api(s, "POST", "/ciphers", body);
}

async function setup(base: string, email: string, kdf: KdfConfig, name: string): Promise<Session> {
  const r = await register(base, email, kdf, name);
  const token = await login(base, email, r.hash);
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  return { base, token, userKey: r.userKey, userId: claims.sub, publicKey: r.publicKey };
}

const TEST_SITE = "http://localhost:9000";

(async () => {
  const A = "http://localhost:8001",
    B = "http://localhost:8002";
  const alice = await setup(A, "alex@privat.test", { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 }, "Alex Privat");
  const bob = await setup(B, "alex@firma.test", { kdf: KdfType.Argon2id, iterations: 3, memory: 64, parallelism: 4 }, "Alex Firma");
  const carol = await setup(A, "familie@privat.test", { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 }, "Familie");

  // folders
  const fA1 = await api(alice, "POST", "/folders", { name: await encryptString("Banking", alice.userKey) });
  const fA2 = await api(alice, "POST", "/folders", { name: await encryptString("Social Media", alice.userKey) });
  const fB1 = await api(bob, "POST", "/folders", { name: await encryptString("Infrastruktur", bob.userKey) });

  // personal items alice
  await makeCipher(alice, alice.userKey, {
    type: 1,
    name: "Test-Login (privat)",
    username: "alex.privat",
    password: "privat-geheim-1",
    uris: [TEST_SITE + "/login.html"],
    favorite: true,
    totp: "otpauth://totp/Test:alex?secret=JBSWY3DPEHPK3PXP&issuer=Test",
  });
  await makeCipher(alice, alice.userKey, {
    type: 1,
    name: "GitHub",
    username: "alex-gh",
    password: "gh-pass-xyz",
    uris: ["https://github.com/login"],
    folderId: fA2.id,
    notes: "Privater GitHub-Account",
  });
  await makeCipher(alice, alice.userKey, {
    type: 1,
    name: "Sparkasse",
    username: "12345678",
    password: "spk!pw",
    uris: ["https://www.sparkasse.de"],
    folderId: fA1.id,
    fields: [
      { name: "PIN-Hinweis", value: "steht im Safe", type: 0 },
      { name: "Geheimfrage", value: "Bello", type: 1 },
    ],
  });
  await makeCipher(alice, alice.userKey, {
    type: 3,
    name: "Visa Privat",
    card: { cardholderName: "Alex Beispiel", brand: "Visa", number: "4111111111111111", expMonth: "8", expYear: "2029", code: "123" },
    folderId: fA1.id,
  });
  await makeCipher(alice, alice.userKey, {
    type: 4,
    name: "Meine Identität",
    identity: {
      title: "Herr",
      firstName: "Alex",
      lastName: "Beispiel",
      city: "Musterstadt",
      postalCode: "12345",
      country: "DE",
      email: "alex@privat.test",
    },
  });
  await makeCipher(alice, alice.userKey, { type: 2, name: "WLAN Zuhause", notes: "SSID: Zuhause\nPasswort: wlan-pw-123" });
  await makeLegacyCipher(alice, alice.userKey, {
    name: "Altes Forum (ohne Item-Key)",
    username: "oldie",
    password: "legacy-pw",
    uris: ["forum.example.org"],
  });

  // org on server A for alice
  const orgKey = generateCbcHmacKey();
  const orgKp = await generateRsaKeyPair();
  const org = await api(alice, "POST", "/organizations", {
    name: "Familie Beispiel",
    billingEmail: "alex@privat.test",
    planType: 0,
    collectionName: await encryptString("Gemeinsam", orgKey),
    key: await rsaEncrypt(symKeyToBytes(orgKey), alice.publicKey),
    keys: {
      publicKey: b64encode(orgKp.publicKey),
      encryptedPrivateKey: await encryptBytes(orgKp.privateKey, orgKey, "application/x.bitwarden.legacy-key"),
    },
  });
  const cols = await api(alice, "GET", `/organizations/${org.id}/collections`);
  const colId = (cols.data ?? cols.Data)[0].id ?? (cols.data ?? cols.Data)[0].Id;
  const col2 = await api(alice, "POST", `/organizations/${org.id}/collections`, {
    name: await encryptString("Streaming", orgKey),
    groups: [],
    users: [],
  });
  await makeCipher(
    alice,
    orgKey,
    { type: 1, name: "Netflix", username: "familie@privat.test", password: "netflix-fam", uris: ["https://www.netflix.com"] },
    org.id,
    [col2.id],
  );
  await makeCipher(
    alice,
    orgKey,
    { type: 1, name: "Test-Login (Familie)", username: "familie-shared", password: "fam-geheim-2", uris: [TEST_SITE] },
    org.id,
    [colId],
  );

  // bob (server B)
  await makeCipher(bob, bob.userKey, {
    type: 1,
    name: "Test-Login (Firma)",
    username: "a.beispiel@firma",
    password: "firma-geheim-3",
    uris: [TEST_SITE + "/login.html"],
  });
  await makeCipher(bob, bob.userKey, {
    type: 1,
    name: "GitHub Firma",
    username: "abeispiel-corp",
    password: "gh-corp",
    uris: ["https://github.com"],
    folderId: fB1.id,
  });
  await makeCipher(bob, bob.userKey, {
    type: 1,
    name: "Proxmox",
    username: "root@pam",
    password: "pve-root",
    uris: ["https://pve.firma.test:8006"],
    folderId: fB1.id,
    totp: "JBSWY3DPEHPK3PXP",
  });
  await makeCipher(bob, bob.userKey, {
    type: 5,
    name: "Deploy-Key",
    sshKey: {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA...\n-----END OPENSSH PRIVATE KEY-----",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI test@firma",
      keyFingerprint: "SHA256:abc123",
    },
    folderId: fB1.id,
  });
  const notes = await makeCipher(bob, bob.userKey, { type: 2, name: "Server-Notizen", notes: "Backup läuft um 02:00" });
  await addAttachment(bob, notes, "backup-plan.txt", utf8("Backup-Plan\nNAS → Cloud, täglich 02:00 Uhr\n"));

  // carol (second account on server A)
  await makeCipher(carol, carol.userKey, {
    type: 1,
    name: "Test-Login (Familie-Account)",
    username: "familie",
    password: "familie-pw-4",
    uris: [TEST_SITE],
  });
  await makeCipher(carol, carol.userKey, {
    type: 1,
    name: "Amazon",
    username: "familie@privat.test",
    password: "amz",
    uris: ["https://www.amazon.de"],
  });

  console.log("seeded. password:", PW);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
