// Vault export (Bitwarden JSON / CSV / encrypted JSON) and decryption of encrypted Bitwarden exports
// for the import. Same file formats as the official clients, so the files can be moved between them.
import { decryptString, deriveKeyFromPassword, encryptString, KdfConfig, stretchKey, SymKey } from "../crypto/bw";
import { b64encode, newGuid, randomBytes } from "../crypto/utils";
import { t } from "../shared/i18n";
import { CipherType, FolderView, ItemView } from "../shared/types";
import { AccountKeys, cipherKeyFor, decryptCipher } from "./vault-crypto";

export type ExportFormat = "json" | "csv" | "encrypted_json" | "password_json";

export interface ExportContext {
  accountKey: string;
  kdf: KdfConfig;
  keys: AccountKeys;
  /** raw sync data (encrypted ciphers and folders) */
  raw: any;
  items: ItemView[];
  folders: FolderView[];
}

const PASSKEY_FIELDS = [
  "credentialId",
  "keyType",
  "keyAlgorithm",
  "keyCurve",
  "keyValue",
  "rpId",
  "userHandle",
  "userName",
  "counter",
  "rpName",
  "userDisplayName",
  "discoverable",
];

async function plainPasskeys(raw: any, keys: AccountKeys): Promise<any[] | undefined> {
  const list = raw?.login?.fido2Credentials;
  if (!Array.isArray(list) || !list.length) return undefined;
  const key = await cipherKeyFor(raw, keys);
  const out: any[] = [];
  for (const f of list) {
    const o: any = {};
    for (const k of PASSKEY_FIELDS) o[k] = f[k] ? await decryptString(f[k], key).catch(() => "") : k === "discoverable" ? "false" : "";
    o.creationDate = f.creationDate ?? new Date().toISOString();
    out.push(o);
  }
  return out;
}

const nn = (v: string | undefined | null) => (v === undefined || v === "" ? null : v);

/** Unencrypted Bitwarden JSON item (CipherWithIdExport). */
export function exportItem(i: ItemView, passkeys?: any[]): any {
  const o: any = {
    passwordHistory: i.passwordHistory?.length
      ? i.passwordHistory.map((p) => ({ lastUsedDate: p.lastUsedDate, password: p.password }))
      : null,
    revisionDate: i.revisionDate ?? null,
    creationDate: i.creationDate ?? null,
    deletedDate: i.deletedDate ?? null,
    archivedDate: i.archivedDate ?? null,
    id: i.id,
    organizationId: null,
    folderId: i.folderId ?? null,
    type: i.type,
    reprompt: i.reprompt ?? 0,
    name: i.name,
    notes: nn(i.notes),
    favorite: !!i.favorite,
  };
  if (i.fields?.length)
    o.fields = i.fields.map((f) => ({ name: nn(f.name), value: nn(f.value), type: f.type, linkedId: f.linkedId ?? null }));
  const obj = (src: Record<string, string | undefined> | undefined) => {
    const r: any = {};
    for (const [k, v] of Object.entries(src ?? {})) r[k] = nn(v);
    return r;
  };
  switch (i.type) {
    case CipherType.Login:
      o.login = {
        fido2Credentials: passkeys ?? [],
        uris: (i.login?.uris ?? []).map((u) => ({ match: u.match ?? null, uri: u.uri })),
        username: nn(i.login?.username),
        password: nn(i.login?.password),
        totp: nn(i.login?.totp),
      };
      break;
    case CipherType.SecureNote:
      o.secureNote = { type: i.secureNote?.type ?? 0 };
      break;
    case CipherType.Card:
      o.card = obj(i.card);
      break;
    case CipherType.Identity:
      o.identity = obj(i.identity);
      break;
    case CipherType.SshKey:
      o.sshKey = obj(i.sshKey);
      break;
    case CipherType.BankAccount:
      o.bankAccount = obj(i.extra);
      break;
    case CipherType.DriversLicense:
      o.driversLicense = obj(i.extra);
      break;
    case CipherType.Passport:
      o.passport = obj(i.extra);
      break;
  }
  o.collectionIds = null;
  return o;
}

async function unencryptedJson(ctx: ExportContext): Promise<string> {
  const rawById = new Map<string, any>((ctx.raw.ciphers ?? []).map((c: any) => [c.id, c]));
  const items = [];
  for (const i of ctx.items) {
    if (i.organizationId || i.deletedDate) continue;
    items.push(exportItem(i, i.type === CipherType.Login ? await plainPasskeys(rawById.get(i.id), ctx.keys) : undefined));
  }
  return JSON.stringify({ encrypted: false, folders: ctx.folders.map((f) => ({ id: f.id, name: f.name })), items }, null, "  ");
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csv(ctx: ExportContext): string {
  const folderName = new Map(ctx.folders.map((f) => [f.id, f.name]));
  const cols = [
    "folder",
    "favorite",
    "type",
    "name",
    "notes",
    "fields",
    "reprompt",
    "archivedDate",
    "login_uri",
    "login_username",
    "login_password",
    "login_totp",
  ];
  const rows = [cols.join(",")];
  for (const i of ctx.items) {
    if (i.organizationId || i.deletedDate) continue;
    if (i.type !== CipherType.Login && i.type !== CipherType.SecureNote) continue;
    const login = i.type === CipherType.Login;
    rows.push(
      [
        i.folderId ? folderName.get(i.folderId) : null,
        i.favorite ? 1 : null,
        login ? "login" : "note",
        i.name,
        i.notes,
        i.fields.length ? i.fields.map((f) => (f.name || "") + ": " + f.value).join("\n") : null,
        i.reprompt ?? 0,
        i.archivedDate ?? null,
        login ? i.login!.uris.map((u) => u.uri).join(",") : null,
        login ? i.login!.username : null,
        login ? i.login!.password : null,
        login ? i.login!.totp : null,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\r\n");
}

/** Account-restricted export: the encrypted data as stored on the server. */
async function accountEncryptedJson(ctx: ExportContext): Promise<string> {
  const pick = (c: any, ks: string[]) => Object.fromEntries(ks.map((k) => [k, c?.[k] ?? null]));
  const items = [];
  for (const c of ctx.raw.ciphers ?? []) {
    if (c.organizationId || c.deletedDate) continue;
    const o: any = {
      passwordHistory: c.passwordHistory?.length ? c.passwordHistory.map((p: any) => pick(p, ["lastUsedDate", "password"])) : null,
      revisionDate: c.revisionDate ?? null,
      creationDate: c.creationDate ?? null,
      deletedDate: null,
      archivedDate: c.archivedDate ?? null,
      id: c.id,
      organizationId: null,
      folderId: c.folderId ?? null,
      type: c.type,
      reprompt: c.reprompt ?? 0,
      name: c.name,
      notes: c.notes ?? null,
      favorite: !!c.favorite,
      key: c.key ?? null,
    };
    if (c.fields?.length) o.fields = c.fields.map((f: any) => pick(f, ["name", "value", "type", "linkedId"]));
    if (c.type === CipherType.Login && c.login)
      o.login = {
        fido2Credentials: c.login.fido2Credentials ?? [],
        uris: (c.login.uris ?? []).map((u: any) => pick(u, ["match", "uri", "uriChecksum"])),
        username: c.login.username ?? null,
        password: c.login.password ?? null,
        totp: c.login.totp ?? null,
      };
    for (const k of ["secureNote", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"]) if (c[k]) o[k] = c[k];
    o.collectionIds = null;
    items.push(o);
  }
  const folders = (ctx.raw.folders ?? []).map((f: any) => ({ id: f.id, name: f.name }));
  return JSON.stringify(
    { encrypted: true, encKeyValidation_DO_NOT_EDIT: await encryptString(newGuid(), ctx.keys.userKey), folders, items },
    null,
    "  ",
  );
}

async function passwordKey(password: string, salt: string, kdf: KdfConfig): Promise<SymKey> {
  return stretchKey(await deriveKeyFromPassword(password, salt, kdf));
}

export async function buildExport(ctx: ExportContext, format: ExportFormat, password?: string): Promise<string> {
  switch (format) {
    case "csv":
      return csv(ctx);
    case "encrypted_json":
      return accountEncryptedJson(ctx);
    case "password_json": {
      if (!password) throw new Error(t("Bitte ein Dateipasswort eingeben"));
      const salt = b64encode(randomBytes(16));
      const key = await passwordKey(password, salt, ctx.kdf);
      const doc: any = {
        encrypted: true,
        passwordProtected: true,
        salt,
        kdfType: ctx.kdf.kdf,
        kdfIterations: ctx.kdf.iterations,
        encKeyValidation_DO_NOT_EDIT: await encryptString(newGuid(), key),
        data: await encryptString(await unencryptedJson(ctx), key),
      };
      if (ctx.kdf.kdf === 1) {
        doc.kdfMemory = ctx.kdf.memory;
        doc.kdfParallelism = ctx.kdf.parallelism;
      }
      return JSON.stringify(doc, null, "  ");
    }
    default:
      return unencryptedJson(ctx);
  }
}

/**
 * Encrypted Bitwarden export → unencrypted export document (for the import).
 * Password-protected files need the file password, account-restricted ones the account's keys.
 */
export async function decryptExport(ctx: ExportContext, doc: any, password?: string): Promise<any> {
  if (!doc?.encrypted) return doc;
  if (doc.passwordProtected) {
    if (!password) throw new Error(t("Diese Datei ist mit einem Passwort geschützt"));
    const kdf: KdfConfig = {
      kdf: doc.kdfType ?? 0,
      iterations: doc.kdfIterations ?? 600000,
      memory: doc.kdfMemory ?? undefined,
      parallelism: doc.kdfParallelism ?? undefined,
    };
    const key = await passwordKey(password, doc.salt, kdf);
    try {
      await decryptString(doc.encKeyValidation_DO_NOT_EDIT, key);
    } catch {
      throw new Error(t("Falsches Dateipasswort"));
    }
    return JSON.parse(await decryptString(doc.data, key));
  }
  try {
    await decryptString(doc.encKeyValidation_DO_NOT_EDIT, ctx.keys.userKey);
  } catch {
    throw new Error(t("Diese verschlüsselte Datei gehört zu einem anderen Konto"));
  }
  const folders = [];
  for (const f of doc.folders ?? []) folders.push({ id: f.id, name: await decryptString(f.name, ctx.keys.userKey).catch(() => "") });
  const items = [];
  for (const c of doc.items ?? []) {
    const view = await decryptCipher(ctx.accountKey, { ...c, organizationId: null }, ctx.keys);
    items.push(exportItem(view, c.type === CipherType.Login ? await plainPasskeys(c, ctx.keys) : undefined));
  }
  return { encrypted: false, folders, items };
}
