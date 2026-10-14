// Bitwarden Send: key derivation, encryption of Sends and conversion of the server format.
// Each Send has 16 random bytes of key material. They are stored encrypted with the user key; the
// actual encryption key is derived from them (HMAC-SHA256 with "bitwarden-send", then HKDF-Expand
// with info "send" to 64 bytes = AES key + MAC key). The share link carries the material, so the
// server never sees it. A password is stored as PBKDF2-SHA256(password, material, 100 000) only.
import { CT_OCTET_STREAM, decryptBytes, decryptString, encryptBytes, encryptString, hmacSha256, pbkdf2, SymKey } from "../crypto/bw";
import { b64encode, b64urlencode, concat, randomBytes, utf8 } from "../crypto/utils";
import { SendAuthType, SendEdit, SendType, SendView } from "../shared/sends";
import type { AccountRecord } from "../shared/types";

export const SEND_PBKDF2_ITERATIONS = 100_000;

/** HKDF-Expand (SHA-256) for any length. */
async function hkdfExpand(prk: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let prev = new Uint8Array(0);
  let off = 0;
  for (let i = 1; off < length; i++) {
    prev = new Uint8Array(await hmacSha256(prk, concat(prev, utf8(info), new Uint8Array([i]))));
    out.set(prev.subarray(0, Math.min(prev.length, length - off)), off);
    off += prev.length;
  }
  return out;
}

/** Bitwarden's "shareable key": HMAC-SHA256(key "bitwarden-<name>", secret) → HKDF-Expand(info) → 64 bytes. */
export async function shareableKey(secret: Uint8Array, name: string, info?: string): Promise<SymKey> {
  const prk = await hmacSha256(utf8("bitwarden-" + name), secret);
  const k = await hkdfExpand(prk, info ?? "", 64);
  return { t: "cbc-hmac", enc: k.slice(0, 32), mac: k.slice(32) };
}

export function sendKeyFromMaterial(material: Uint8Array): Promise<SymKey> {
  return shareableKey(material, "send", "send");
}

export async function sendPasswordHash(password: string, material: Uint8Array): Promise<string> {
  return b64encode(await pbkdf2(utf8(password), material, SEND_PBKDF2_ITERATIONS, 32));
}

/** Base of the share links ("…/#/send/" or the vanity URL of the US cloud), as the official clients build it. */
export function sendUrlBase(acc: Pick<AccountRecord, "server" | "urls">): string {
  if (acc.server === "us") return "https://send.bitwarden.com/#";
  const vault = (acc.urls.webVault || acc.urls.base || "").replace(/\/+$/, "");
  return vault + "/#/send/";
}

export function sendLink(base: string, accessId: string, material: Uint8Array): string {
  return base + accessId + "/" + b64urlencode(material);
}

function sizeOf(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Decrypt a Send of the sync / API response (camelCase). */
export async function decryptSend(raw: any, accountKey: string, userKey: SymKey, linkBase: string): Promise<SendView> {
  const authType: SendAuthType =
    typeof raw.authType === "number"
      ? raw.authType
      : raw.password
        ? SendAuthType.Password
        : raw.emails
          ? SendAuthType.Email
          : SendAuthType.None;
  const base: SendView = {
    id: raw.id,
    accountKey,
    accessId: raw.accessId,
    type: raw.type,
    name: "",
    link: "",
    hasPassword: !!raw.password || authType === SendAuthType.Password,
    authType,
    emails: raw.emails
      ? String(raw.emails)
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean)
      : undefined,
    maxAccessCount: raw.maxAccessCount ?? null,
    accessCount: raw.accessCount ?? 0,
    disabled: !!raw.disabled,
    hideEmail: !!raw.hideEmail,
    revisionDate: raw.revisionDate,
    deletionDate: raw.deletionDate,
    expirationDate: raw.expirationDate ?? null,
  };
  try {
    const material = (await decryptBytes(raw.key, userKey)).bytes;
    const key = await sendKeyFromMaterial(material);
    base.link = sendLink(linkBase, raw.accessId, material);
    base.name = raw.name ? await decryptString(raw.name, key) : "";
    if (raw.notes) base.notes = await decryptString(raw.notes, key);
    if (raw.type === SendType.Text && raw.text) {
      base.text = raw.text.text ? await decryptString(raw.text.text, key) : "";
      base.hidden = !!raw.text.hidden;
    }
    if (raw.type === SendType.File && raw.file) {
      base.file = {
        id: raw.file.id,
        fileName: raw.file.fileName ? await decryptString(raw.file.fileName, key) : "",
        size: sizeOf(raw.file.size),
        sizeName: raw.file.sizeName,
      };
    }
  } catch (e: any) {
    base.decryptError = e?.message ?? String(e);
  }
  return base;
}

export interface SendRequestParts {
  body: any;
  material: Uint8Array;
  key: SymKey;
}

/**
 * Request body for POST /sends, POST /sends/file/v2 and PUT /sends/{id}.
 * `original` is the stored (encrypted) Send when editing; its key material is kept.
 */
export async function buildSendRequest(edit: SendEdit, userKey: SymKey, original?: any, fileName?: string): Promise<SendRequestParts> {
  const material = original ? (await decryptBytes(original.key, userKey)).bytes : randomBytes(16);
  const key = await sendKeyFromMaterial(material);
  const hasPassword = !!edit.newPassword || (!!original && (!!original.password || original.authType === SendAuthType.Password));
  const body: any = {
    type: edit.type,
    authType: hasPassword ? SendAuthType.Password : SendAuthType.None,
    name: await encryptString(edit.name, key),
    notes: edit.notes ? await encryptString(edit.notes, key) : null,
    key: original?.key ?? (await encryptBytes(material, userKey, CT_OCTET_STREAM)),
    maxAccessCount: edit.maxAccessCount ?? null,
    expirationDate: edit.expirationDate ?? null,
    deletionDate: edit.deletionDate,
    password: edit.newPassword ? await sendPasswordHash(edit.newPassword, material) : null,
    emails: null,
    disabled: !!edit.disabled,
    hideEmail: !!edit.hideEmail,
  };
  // keep an e-mail verification set up in another client (MultiWarden does not create those)
  if (!hasPassword && original?.emails) {
    body.emails = original.emails;
    body.authType = SendAuthType.Email;
  }
  if (edit.type === SendType.Text) {
    body.text = { text: await encryptString(edit.text ?? "", key), hidden: !!edit.hidden };
  } else if (original?.file) {
    body.file = original.file;
  } else {
    body.file = { fileName: await encryptString(fileName ?? "datei", key) };
  }
  if (original?.id) body.id = original.id;
  return { body, material, key };
}
