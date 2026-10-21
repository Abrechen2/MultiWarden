// Decrypting synced vault data, and encrypting items for upload.
import {
  decryptBytes,
  decryptKey,
  decryptString,
  encryptKey,
  encryptString,
  generateCbcHmacKey,
  isEncString,
  makePrivateKey,
  PrivateKeyHandle,
  rsaDecryptKey,
  sha256,
  SymKey,
  b64encode,
} from "../crypto/bw";
import { utf8 } from "../crypto/utils";
import { CipherType, CollectionView, FieldView, FolderView, ItemView, LoginUriView, OrganizationView, PasskeyMeta } from "../shared/types";

import { t } from "../shared/i18n";
/** A passkey in plain form, as it is encrypted into the vault (Bitwarden's Fido2Credential). */
export interface PasskeyPlain {
  credentialId: string;
  keyValue: string; // base64url PKCS#8
  rpId: string;
  rpName?: string;
  userHandle?: string;
  userName?: string;
  userDisplayName?: string;
  counter: number;
  discoverable: boolean;
  creationDate: string;
}

export async function encryptPasskey(p: PasskeyPlain, key: SymKey): Promise<any> {
  const e = (v: string | undefined) => (v == null || v === "" ? Promise.resolve(null) : encryptString(v, key));
  return {
    credentialId: await e(p.credentialId),
    keyType: await e("public-key"),
    keyAlgorithm: await e("ECDSA"),
    keyCurve: await e("P-256"),
    keyValue: await e(p.keyValue),
    rpId: await e(p.rpId),
    rpName: await e(p.rpName),
    userHandle: await e(p.userHandle),
    userName: await e(p.userName),
    userDisplayName: await e(p.userDisplayName),
    counter: await e(String(p.counter)),
    discoverable: await e(p.discoverable ? "true" : "false"),
    creationDate: p.creationDate,
  };
}

export interface AccountKeys {
  userKey: SymKey;
  privateKey?: PrivateKeyHandle;
  orgKeys: Map<string, SymKey>;
}

export interface DecryptedVault {
  items: ItemView[];
  folders: FolderView[];
  collections: CollectionView[];
  organizations: OrganizationView[];
  equivalentDomains: string[][];
}

const DEC_FAIL = "\u0000decrypt-failed";
/** Visible replacement for texts that cannot be decrypted. */
const decFailText = () => t("[Entschlüsselung fehlgeschlagen]");

export async function deriveAccountKeys(sync: any, userKey: SymKey): Promise<AccountKeys> {
  const keys: AccountKeys = { userKey, orgKeys: new Map() };
  const profile = sync?.profile ?? {};
  const encPriv: string | undefined = profile.accountKeys?.publicKeyEncryptionKeyPair?.wrappedPrivateKey ?? profile.privateKey ?? undefined;
  if (encPriv) {
    try {
      const der = (await decryptBytes(encPriv, userKey)).bytes;
      keys.privateKey = makePrivateKey(der);
    } catch (e) {
      console.warn("private key decryption failed", e);
    }
  }
  if (keys.privateKey) {
    for (const org of profile.organizations ?? []) {
      if (!org.key) continue;
      try {
        keys.orgKeys.set(org.id, await rsaDecryptKey(org.key, keys.privateKey));
      } catch (e) {
        console.warn("org key decryption failed", org.id, e);
      }
    }
  }
  return keys;
}

async function dec(s: string | null | undefined, key: SymKey): Promise<string | undefined> {
  if (s == null || s === "") return undefined;
  // every vault field is encrypted; plaintext here can only come from a tampering server
  if (!isEncString(s)) return DEC_FAIL;
  try {
    return await decryptString(s, key);
  } catch {
    return DEC_FAIL;
  }
}

async function decObj(o: any, key: SymKey, skip: string[] = []): Promise<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  if (!o || typeof o !== "object") return out;
  await Promise.all(
    Object.entries(o).map(async ([k, v]) => {
      if (skip.includes(k) || v == null) return;
      if (typeof v === "string") out[k] = await dec(v, key);
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }),
  );
  return out;
}

async function uriChecksumValid(uri: string, checksum: string | null | undefined, key: SymKey): Promise<boolean> {
  if (!checksum) return false;
  try {
    const remote = await decryptString(checksum, key);
    const local = b64encode(await sha256(utf8(uri)));
    return remote === local;
  } catch {
    return false;
  }
}

export async function cipherKeyFor(c: any, keys: AccountKeys): Promise<SymKey> {
  const owner = c.organizationId ? keys.orgKeys.get(c.organizationId) : keys.userKey;
  if (!owner) throw new Error(t("Schlüssel der Organisation fehlt"));
  if (c.key) return decryptKey(c.key, owner);
  return owner;
}

async function decryptPasskeyMeta(list: any, key: SymKey): Promise<PasskeyMeta[] | undefined> {
  if (!Array.isArray(list) || !list.length) return undefined;
  const out: PasskeyMeta[] = [];
  for (const f of list) {
    try {
      const credentialId = await decryptString(f.credentialId, key);
      const rpId = await decryptString(f.rpId, key);
      if (!credentialId || !rpId) continue;
      const opt = async (v: any) => (v ? await decryptString(v, key).catch(() => undefined) : undefined);
      const counter = Number(await opt(f.counter));
      out.push({
        credentialId,
        rpId: rpId.toLowerCase(),
        rpName: await opt(f.rpName),
        userName: await opt(f.userName),
        userDisplayName: await opt(f.userDisplayName),
        userHandle: await opt(f.userHandle),
        discoverable: (await opt(f.discoverable)) === "true",
        counter: Number.isFinite(counter) ? counter : 0,
        creationDate: f.creationDate ?? undefined,
      });
    } catch {
      /* undecryptable passkey: ignore */
    }
  }
  return out;
}

/** Replaces the internal failure marker by a readable (translated) text. */
function markFailures<T>(v: T): T {
  if (typeof v === "string") return (v === DEC_FAIL ? decFailText() : v) as T;
  if (Array.isArray(v)) return v.map(markFailures) as T;
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) (v as any)[k] = markFailures((v as any)[k]);
  }
  return v;
}

export async function decryptCipher(accountKey: string, c: any, keys: AccountKeys): Promise<ItemView> {
  return markFailures(await decryptCipherRaw(accountKey, c, keys));
}

async function decryptCipherRaw(accountKey: string, c: any, keys: AccountKeys): Promise<ItemView> {
  const base: ItemView = {
    id: c.id,
    accountKey,
    organizationId: c.organizationId ?? null,
    folderId: c.folderId ?? null,
    collectionIds: c.collectionIds ?? [],
    type: c.type,
    name: "",
    favorite: !!c.favorite,
    reprompt: c.reprompt ?? 0,
    edit: c.edit !== false,
    viewPassword: c.viewPassword !== false,
    fields: [],
    passwordHistory: [],
    attachments: [],
    creationDate: c.creationDate,
    revisionDate: c.revisionDate,
    deletedDate: c.deletedDate ?? null,
    archivedDate: c.archivedDate ?? null,
  };
  let key: SymKey;
  try {
    key = await cipherKeyFor(c, keys);
  } catch (e: any) {
    base.name = DEC_FAIL;
    base.decryptError = e?.message ?? String(e);
    return base;
  }
  if (!c.name && c.data) {
    base.name = t("[Neues Eintragsformat – noch nicht unterstützt]");
    base.decryptError = "unsupported blob format";
    return base;
  }
  base.name = (await dec(c.name, key)) ?? "";
  if (base.name === DEC_FAIL) base.decryptError = "name";
  base.notes = await dec(c.notes, key);

  switch (c.type as CipherType) {
    case CipherType.Login: {
      const l = c.login ?? {};
      const uris: LoginUriView[] = [];
      for (const u of l.uris ?? []) {
        const uri = await dec(u.uri, key);
        if (!uri || uri === DEC_FAIL) continue;
        if (c.key && !(await uriChecksumValid(uri, u.uriChecksum, key))) continue; // tamper protection (as official client)
        uris.push({ uri, match: u.match ?? null });
      }
      base.login = {
        username: await dec(l.username, key),
        password: await dec(l.password, key),
        totp: await dec(l.totp, key),
        uris,
        passwordRevisionDate: l.passwordRevisionDate ?? null,
        autofillOnPageLoad: l.autofillOnPageLoad ?? null,
        passkeys: Array.isArray(l.fido2Credentials) ? l.fido2Credentials.length : 0,
        fido2: await decryptPasskeyMeta(l.fido2Credentials, key),
      };
      break;
    }
    case CipherType.SecureNote:
      base.secureNote = { type: c.secureNote?.type ?? 0 };
      break;
    case CipherType.Card:
      base.card = await decObj(c.card, key);
      break;
    case CipherType.Identity:
      base.identity = await decObj(c.identity, key);
      break;
    case CipherType.SshKey:
      base.sshKey = await decObj(c.sshKey, key);
      break;
    default: {
      const sub = c.bankAccount ?? c.driversLicense ?? c.passport ?? null;
      base.extra = await decObj(sub, key);
    }
  }

  base.fields = await Promise.all(
    (c.fields ?? []).map(async (f: any): Promise<FieldView> => ({
      name: (await dec(f.name, key)) ?? "",
      value: (await dec(f.value, key)) ?? "",
      type: f.type ?? 0,
      linkedId: f.linkedId ?? null,
    })),
  );
  base.passwordHistory = await Promise.all(
    (c.passwordHistory ?? []).map(async (p: any) => ({
      password: (await dec(p.password, key)) ?? "",
      lastUsedDate: p.lastUsedDate,
    })),
  );
  base.attachments = await Promise.all(
    (c.attachments ?? []).map(async (a: any) => {
      let fileName = DEC_FAIL;
      try {
        // attachment names are encrypted with the cipher key
        fileName = (await dec(a.fileName, key)) ?? "";
      } catch {
        /* ignore */
      }
      return { id: a.id, fileName, size: a.size, sizeName: a.sizeName };
    }),
  );
  return base;
}

export async function decryptVault(accountKey: string, sync: any, keys: AccountKeys): Promise<DecryptedVault> {
  const folders: FolderView[] = await Promise.all(
    (sync.folders ?? []).map(async (f: any) => ({
      id: f.id,
      accountKey,
      name: markFailures((await dec(f.name, keys.userKey)) ?? ""),
    })),
  );
  const organizations: OrganizationView[] = (sync.profile?.organizations ?? [])
    .filter((o: any) => keys.orgKeys.has(o.id))
    .map((o: any) => ({ id: o.id, accountKey, name: o.name ?? "Organisation" }));
  const collections: CollectionView[] = [];
  for (const c of sync.collections ?? []) {
    const ok = keys.orgKeys.get(c.organizationId);
    if (!ok) continue;
    collections.push({
      id: c.id,
      accountKey,
      organizationId: c.organizationId,
      name: markFailures((await dec(c.name, ok)) ?? ""),
      readOnly: !!c.readOnly,
      manage: !!c.manage,
    });
  }
  // decrypt ciphers in parallel batches
  const ciphers: any[] = sync.ciphers ?? [];
  const items: ItemView[] = [];
  const BATCH = 50;
  for (let i = 0; i < ciphers.length; i += BATCH) {
    const part = await Promise.all(ciphers.slice(i, i + BATCH).map((c) => decryptCipher(accountKey, c, keys)));
    items.push(...part);
  }
  const eq: string[][] = [];
  const d = sync.domains;
  if (d) {
    for (const g of d.equivalentDomains ?? []) if (Array.isArray(g)) eq.push(g.map((x: string) => x.toLowerCase()));
    for (const g of d.globalEquivalentDomains ?? [])
      if (!g.excluded && Array.isArray(g.domains)) eq.push(g.domains.map((x: string) => x.toLowerCase()));
  }
  return { items, folders, collections, organizations, equivalentDomains: eq };
}

// ---------------------------------------------------------------------------------------------
// Encryption for create/update

const enc = async (v: string | undefined | null, key: SymKey) => (v == null || v === "" ? null : encryptString(v, key));

const CARD_FIELDS = ["cardholderName", "brand", "number", "expMonth", "expYear", "code"];
const IDENTITY_FIELDS = [
  "title",
  "firstName",
  "middleName",
  "lastName",
  "address1",
  "address2",
  "address3",
  "city",
  "state",
  "postalCode",
  "country",
  "company",
  "email",
  "phone",
  "ssn",
  "username",
  "passportNumber",
  "licenseNumber",
];
const SSH_FIELDS = ["privateKey", "publicKey", "keyFingerprint"];

export const BANK_FIELDS = [
  "bankName",
  "nameOnAccount",
  "accountType",
  "accountNumber",
  "routingNumber",
  "branchNumber",
  "pin",
  "swiftCode",
  "iban",
  "bankContactPhone",
];
export const DRIVERS_LICENSE_FIELDS = [
  "firstName",
  "middleName",
  "lastName",
  "dateOfBirth",
  "licenseNumber",
  "issuingCountry",
  "issuingState",
  "issueDate",
  "expirationDate",
  "issuingAuthority",
  "licenseClass",
];
export const PASSPORT_FIELDS = [
  "surname",
  "givenName",
  "dateOfBirth",
  "sex",
  "birthPlace",
  "nationality",
  "issuingCountry",
  "passportNumber",
  "passportType",
  "nationalIdentificationNumber",
  "issuingAuthority",
  "issueDate",
  "expirationDate",
];

async function encFields(src: Record<string, string | undefined> | undefined, names: string[], key: SymKey) {
  const out: Record<string, string | null> = {};
  for (const n of names) out[n] = await enc(src?.[n], key);
  return out;
}

/**
 * Build a CipherRequest body. `original` is the raw (encrypted) cipher from the last sync, if the
 * item already exists — needed to keep its cipher key, passkeys and attachment metadata.
 */
export async function buildCipherRequest(
  item: ItemView,
  original: any | null,
  keys: AccountKeys,
  userId: string,
  opts: { newPasskey?: PasskeyPlain; share?: boolean; importPasskeys?: Record<string, string>[] } = {},
): Promise<any> {
  const ownerKey = item.organizationId ? keys.orgKeys.get(item.organizationId) : keys.userKey;
  if (!ownerKey) throw new Error(t("Kein Schlüssel für den gewählten Besitzer"));

  let wrappedCipherKey: string | null = null;
  let key: SymKey;
  let movedPasskeys: any[] | null = null;
  if (original && (original.organizationId ?? null) !== (item.organizationId ?? null)) {
    if (!opts.share || original.organizationId)
      throw new Error(t("Der Besitzer eines bestehenden Eintrags kann hier nicht geändert werden"));
    // personal item → organization: the item key is wrapped with the organization key from now on
    if (original.key) {
      const ck = await decryptKey(original.key, keys.userKey);
      wrappedCipherKey = await encryptKey(ck, ownerKey);
      key = ck;
    } else {
      if (original.attachments?.length)
        throw new Error(t("Ältere Einträge mit Anhängen können nicht in eine Organisation verschoben werden"));
      // older item without own key: give it one; passkeys are re-encrypted with it
      const ck = generateCbcHmacKey();
      wrappedCipherKey = await encryptKey(ck, ownerKey);
      key = ck;
      if (original.login?.fido2Credentials?.length)
        movedPasskeys = await Promise.all(original.login.fido2Credentials.map((f: any) => reencryptObj(f, keys.userKey, ck)));
    }
  } else if (original) {
    // keep the existing key situation so passkeys and attachments stay decryptable
    if (original.key) {
      wrappedCipherKey = original.key;
      key = await decryptKey(original.key, ownerKey);
    } else {
      key = ownerKey;
    }
  } else {
    // new items get their own item key, like current official clients
    const ck = generateCbcHmacKey();
    wrappedCipherKey = await encryptKey(ck, ownerKey);
    key = ck;
  }

  const req: any = {
    type: item.type,
    folderId: item.folderId || null,
    organizationId: item.organizationId || null,
    name: await enc(item.name || t("(ohne Namen)"), key),
    notes: await enc(item.notes, key),
    favorite: !!item.favorite,
    reprompt: item.reprompt ?? 0,
    key: wrappedCipherKey,
    encryptedFor: userId,
    lastKnownRevisionDate: original?.revisionDate ?? null,
    fields: await Promise.all(
      (item.fields ?? [])
        .filter((f) => f.name || f.value)
        .map(async (f) => ({
          type: f.type ?? 0,
          name: await enc(f.name, key),
          value: await enc(f.value, key),
          linkedId: f.linkedId ?? null,
        })),
    ),
    passwordHistory: await Promise.all(
      (item.passwordHistory ?? []).slice(0, 5).map(async (p) => ({ password: await enc(p.password, key), lastUsedDate: p.lastUsedDate })),
    ),
  };

  switch (item.type) {
    case CipherType.Login: {
      const l = item.login ?? { uris: [], passkeys: 0 };
      req.login = {
        username: await enc(l.username, key),
        password: await enc(l.password, key),
        totp: await enc(l.totp, key),
        passwordRevisionDate: l.passwordRevisionDate ?? null,
        autofillOnPageLoad: l.autofillOnPageLoad ?? null,
        uris: await Promise.all(
          (l.uris ?? [])
            .filter((u) => u.uri && u.uri.trim())
            .map(async (u) => ({
              uri: await enc(u.uri.trim(), key),
              match: u.match ?? null,
              uriChecksum: await encryptString(b64encode(await sha256(utf8(u.uri.trim()))), key),
            })),
        ),
        // passkeys stay as they are (same key) unless a new one replaces them or the user removed them
        fido2Credentials: opts.newPasskey
          ? [await encryptPasskey(opts.newPasskey, key)]
          : opts.importPasskeys?.length
            ? await Promise.all(opts.importPasskeys.map((p) => encryptPlainObj(p, key, ["creationDate"])))
            : l.passkeys === 0
              ? null
              : (movedPasskeys ?? original?.login?.fido2Credentials ?? null),
      };
      break;
    }
    case CipherType.SecureNote:
      req.secureNote = { type: item.secureNote?.type ?? 0 };
      break;
    case CipherType.Card:
      req.card = await encFields(item.card, CARD_FIELDS, key);
      break;
    case CipherType.Identity:
      req.identity = await encFields(item.identity, IDENTITY_FIELDS, key);
      break;
    case CipherType.SshKey:
      req.sshKey = await encFields(item.sshKey, SSH_FIELDS, key);
      break;
    case CipherType.BankAccount:
      req.bankAccount = await encFields(item.extra, BANK_FIELDS, key);
      break;
    case CipherType.DriversLicense:
      req.driversLicense = await encFields(item.extra, DRIVERS_LICENSE_FIELDS, key);
      break;
    case CipherType.Passport:
      req.passport = await encFields(item.extra, PASSPORT_FIELDS, key);
      break;
    default:
      throw new Error(t("Dieser Eintragstyp kann hier nicht bearbeitet werden"));
  }
  return req;
}

/** Encrypt all string fields of a plain object (imported passkeys), except `keep`. */
async function encryptPlainObj(o: Record<string, string>, key: SymKey, keep: string[]): Promise<any> {
  const out: any = {};
  for (const [k, v] of Object.entries(o ?? {}))
    out[k] = keep.includes(k) ? v : v == null || v === "" ? null : await encryptString(String(v), key);
  return out;
}

/** Re-encrypt every EncString of an object (e.g. a passkey) from one key to another. */
async function reencryptObj(o: any, from: SymKey, to: SymKey): Promise<any> {
  const out: any = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (typeof v === "string" && isEncString(v)) out[k] = await encryptString(await decryptString(v, from), to);
    else out[k] = v;
  }
  return out;
}

export async function encryptFolderName(name: string, keys: AccountKeys) {
  return encryptString(name, keys.userKey);
}
