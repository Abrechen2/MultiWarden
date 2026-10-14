// Bitwarden-compatible cryptography: keys, EncStrings (v1 AES-CBC-HMAC, v2 COSE_Encrypt0), RSA, KDF.
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { gcm, ecb } from "@noble/ciphers/aes";
import { argon2id } from "hash-wasm";
import { cborDecode, cborEncode, CborMap, CborTagged, CborValue } from "./cbor";
import { b64decode, b64encode, buf, concat, equalBytes, fromUtf8, randomBytes, utf8 } from "./utils";

const subtle = globalThis.crypto.subtle;

// ---------------------------------------------------------------------------------------------
// Keys

export const ALG_XCHACHA20_POLY1305 = -70000;
export const ALG_XAES_256_GCM = -70010;
export const ALG_A256GCM = 3;

export type SymKey =
  | { t: "cbc-hmac"; enc: Uint8Array; mac: Uint8Array }
  | { t: "cbc"; enc: Uint8Array }
  | { t: "cose"; alg: number; key: Uint8Array; kid: Uint8Array };

export type SerializedKey = { t: "cbc-hmac"; k: string } | { t: "cbc"; k: string } | { t: "cose"; alg: number; k: string; kid: string };

export function serializeKey(k: SymKey): SerializedKey {
  if (k.t === "cbc-hmac") return { t: "cbc-hmac", k: b64encode(concat(k.enc, k.mac)) };
  if (k.t === "cbc") return { t: "cbc", k: b64encode(k.enc) };
  return { t: "cose", alg: k.alg, k: b64encode(k.key), kid: b64encode(k.kid) };
}

export function deserializeKey(s: SerializedKey): SymKey {
  if (s.t === "cose") return { t: "cose", alg: s.alg, key: b64decode(s.k), kid: b64decode(s.kid) };
  return symKeyFromBytes(b64decode(s.k));
}

export function makeCbcHmacKey(bytes: Uint8Array): SymKey {
  if (bytes.length !== 64) throw new Error("Invalid key length " + bytes.length);
  return { t: "cbc-hmac", enc: bytes.slice(0, 32), mac: bytes.slice(32, 64) };
}

export function generateCbcHmacKey(): SymKey {
  return makeCbcHmacKey(randomBytes(64));
}

/** Interpret raw decrypted key bytes ("BitwardenLegacyKey" encoding). */
export function symKeyFromBytes(bytes: Uint8Array): SymKey {
  if (bytes.length === 64) return makeCbcHmacKey(bytes);
  if (bytes.length === 32) return { t: "cbc", enc: bytes.slice() };
  if (bytes.length > 64) {
    const pad = bytes[bytes.length - 1];
    if (pad === 0 || pad > bytes.length) throw new Error("Invalid key padding");
    return parseCoseKey(bytes.subarray(0, bytes.length - pad));
  }
  throw new Error("Invalid key length " + bytes.length);
}

/** Encode a key the way Bitwarden does before wrapping it ("BitwardenLegacyKey" bytes). */
export function symKeyToBytes(k: SymKey): Uint8Array {
  if (k.t === "cbc-hmac") return concat(k.enc, k.mac);
  if (k.t === "cbc") return k.enc.slice();
  const cose = encodeCoseKey(k);
  // pad so it is distinguishable from 64-byte legacy keys (min length 65)
  const min = 65;
  const pad = Math.max(1, min - cose.length);
  const out = new Uint8Array(Math.max(min, cose.length + 1));
  out.set(cose);
  out.fill(pad, cose.length);
  return out;
}

function mapGet(m: CborValue, k: number): CborValue {
  if (!(m instanceof Map)) return undefined;
  return m.get(k);
}

export function parseCoseKey(bytes: Uint8Array): SymKey {
  let m = cborDecode(bytes);
  if (m instanceof CborTagged) m = m.value;
  if (!(m instanceof Map)) throw new Error("Invalid COSE key");
  const alg = mapGet(m, 3);
  const k = mapGet(m, -1);
  const kid = mapGet(m, 2);
  if (typeof alg !== "number" || !(k instanceof Uint8Array)) throw new Error("Invalid COSE key");
  if (k.length !== 32) throw new Error("Unsupported COSE key size");
  return { t: "cose", alg, key: k, kid: kid instanceof Uint8Array ? kid : new Uint8Array(0) };
}

function encodeCoseKey(k: Extract<SymKey, { t: "cose" }>): Uint8Array {
  const m = new CborMap();
  m.set(1, 4); // kty: Symmetric
  m.set(2, k.kid);
  m.set(3, k.alg);
  m.set(4, [3, 4, 5, 6]); // key_ops: encrypt, decrypt, wrapKey, unwrapKey
  m.set(-1, k.key);
  return cborEncode(m);
}

// WebCrypto key cache
const cryptoKeyCache = new WeakMap<object, { enc?: CryptoKey; mac?: CryptoKey }>();

async function aesKey(k: SymKey): Promise<CryptoKey> {
  const c = cryptoKeyCache.get(k) ?? {};
  if (!c.enc) {
    const raw = k.t === "cose" ? k.key : k.enc;
    c.enc = await subtle.importKey("raw", buf(raw), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
    cryptoKeyCache.set(k, c);
  }
  return c.enc;
}

async function hmacKey(k: Extract<SymKey, { t: "cbc-hmac" }>): Promise<CryptoKey> {
  const c = cryptoKeyCache.get(k) ?? {};
  if (!c.mac) {
    c.mac = await subtle.importKey("raw", buf(k.mac), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    cryptoKeyCache.set(k, c);
  }
  return c.mac;
}

// ---------------------------------------------------------------------------------------------
// EncString

export enum EncType {
  AesCbc256_B64 = 0,
  AesCbc128_HmacSha256_B64 = 1,
  AesCbc256_HmacSha256_B64 = 2,
  Rsa2048_OaepSha256_B64 = 3,
  Rsa2048_OaepSha1_B64 = 4,
  Rsa2048_OaepSha256_HmacSha256_B64 = 5,
  Rsa2048_OaepSha1_HmacSha256_B64 = 6,
  CoseEncrypt0 = 7,
}

export interface ParsedEncString {
  type: EncType;
  iv?: Uint8Array;
  data: Uint8Array;
  mac?: Uint8Array;
}

export function isEncString(s: unknown): s is string {
  return typeof s === "string" && /^[0-7]\.[A-Za-z0-9+/=_-]+(\|[A-Za-z0-9+/=_-]*)*$/.test(s);
}

export function parseEncString(s: string): ParsedEncString {
  let type: number;
  let parts: string[];
  const dot = s.indexOf(".");
  if (dot === 1) {
    type = parseInt(s[0], 10);
    parts = s.slice(2).split("|");
  } else {
    parts = s.split("|");
    type = parts.length === 3 ? EncType.AesCbc128_HmacSha256_B64 : EncType.AesCbc256_B64;
  }
  switch (type) {
    case EncType.AesCbc256_B64:
      if (parts.length !== 2) throw new Error("Malformed EncString");
      return { type, iv: b64decode(parts[0]), data: b64decode(parts[1]) };
    case EncType.AesCbc256_HmacSha256_B64:
    case EncType.AesCbc128_HmacSha256_B64:
      if (parts.length !== 3) throw new Error("Malformed EncString");
      return { type, iv: b64decode(parts[0]), data: b64decode(parts[1]), mac: b64decode(parts[2]) };
    case EncType.Rsa2048_OaepSha256_B64:
    case EncType.Rsa2048_OaepSha1_B64:
      return { type, data: b64decode(parts[0]) };
    case EncType.Rsa2048_OaepSha256_HmacSha256_B64:
    case EncType.Rsa2048_OaepSha1_HmacSha256_B64:
      return { type, data: b64decode(parts[0]), mac: parts[1] ? b64decode(parts[1]) : undefined };
    case EncType.CoseEncrypt0:
      return { type, data: b64decode(parts[0]) };
  }
  throw new Error("Unsupported EncString type " + type);
}

export class DecryptError extends Error {}

/** Content formats carried by COSE protected headers. */
const CT_PADDED_UTF8 = "application/x.bitwarden.utf8-padded";
const CT_LEGACY_KEY = "application/x.bitwarden.legacy-key";
export const CT_SPKI = "application/x.bitwarden.spki-public-key";
export const CT_PKCS8 = 284; // CoAP content format application/pkcs8
export const CT_OCTET_STREAM = 42;
const CONTENT_FORMAT_COSE_KEY = 101; // CoAP content format application/cose-key

export interface DecryptResult {
  bytes: Uint8Array;
  contentType?: string | number;
}

export async function decryptBytes(encStr: string, key: SymKey): Promise<DecryptResult> {
  const p = parseEncString(encStr);
  if (p.type === EncType.AesCbc256_HmacSha256_B64) {
    if (key.t !== "cbc-hmac") throw new DecryptError("Key type mismatch (expected AES-CBC-HMAC)");
    const mk = await hmacKey(key);
    const mac = new Uint8Array(await subtle.sign("HMAC", mk, buf(concat(p.iv!, p.data))));
    if (!equalBytes(mac, p.mac!)) throw new DecryptError("MAC mismatch");
    const ak = await aesKey(key);
    const pt = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: buf(p.iv!) }, ak, buf(p.data)));
    return { bytes: pt };
  }
  if (p.type === EncType.AesCbc256_B64) {
    if (key.t === "cose") throw new DecryptError("Key type mismatch");
    const ak = await aesKey(key);
    const pt = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: buf(p.iv!) }, ak, buf(p.data)));
    return { bytes: pt };
  }
  if (p.type === EncType.CoseEncrypt0) {
    if (key.t !== "cose") throw new DecryptError("Key type mismatch (expected COSE key)");
    return coseDecrypt0(p.data, key);
  }
  throw new DecryptError("Unsupported symmetric EncString type " + p.type);
}

export async function decryptString(encStr: string, key: SymKey): Promise<string> {
  const r = await decryptBytes(encStr, key);
  return fromUtf8(r.bytes);
}

/** Decrypt a wrapped symmetric key. */
export async function decryptKey(encStr: string, key: SymKey): Promise<SymKey> {
  const r = await decryptBytes(encStr, key);
  if (r.contentType === CONTENT_FORMAT_COSE_KEY) return parseCoseKey(r.bytes);
  return symKeyFromBytes(r.bytes);
}

export async function encryptBytes(data: Uint8Array, key: SymKey, contentType: string | number = CT_PADDED_UTF8): Promise<string> {
  if (key.t === "cbc-hmac") {
    const iv = randomBytes(16);
    const ak = await aesKey(key);
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, ak, buf(data)));
    const mk = await hmacKey(key);
    const mac = new Uint8Array(await subtle.sign("HMAC", mk, buf(concat(iv, ct))));
    return `2.${b64encode(iv)}|${b64encode(ct)}|${b64encode(mac)}`;
  }
  if (key.t === "cose") {
    return "7." + b64encode(coseEncrypt0(data, key, contentType));
  }
  throw new Error("Refusing to encrypt with unauthenticated AES-CBC key");
}

export async function encryptString(s: string, key: SymKey): Promise<string> {
  return encryptBytes(utf8(s), key, CT_PADDED_UTF8);
}

export async function encryptKey(toWrap: SymKey, wrappingKey: SymKey): Promise<string> {
  return encryptBytes(symKeyToBytes(toWrap), wrappingKey, CT_LEGACY_KEY);
}

// ---------------------------------------------------------------------------------------------
// COSE_Encrypt0

function padBytes(b: Uint8Array, block: number): Uint8Array {
  const min = block * (1 + Math.floor(b.length / block));
  const pad = Math.max(1, min - b.length);
  const out = new Uint8Array(Math.max(min, b.length + 1));
  out.set(b);
  out.fill(pad, b.length);
  return out;
}

function unpadBytes(b: Uint8Array): Uint8Array {
  const pad = b[b.length - 1];
  if (!pad || pad > b.length) throw new DecryptError("Invalid padding");
  return b.subarray(0, b.length - pad);
}

function encStructure(protectedBytes: Uint8Array): Uint8Array {
  return cborEncode(["Encrypt0", protectedBytes, new Uint8Array(0)]);
}

async function coseDecrypt0(bytes: Uint8Array, key: Extract<SymKey, { t: "cose" }>): Promise<DecryptResult> {
  let msg = cborDecode(bytes);
  if (msg instanceof CborTagged) msg = msg.value;
  if (!Array.isArray(msg) || msg.length < 3) throw new DecryptError("Invalid COSE_Encrypt0");
  const [protBytes, unprot, ciphertext] = msg as [Uint8Array, CborValue, Uint8Array];
  if (!(protBytes instanceof Uint8Array) || !(ciphertext instanceof Uint8Array)) throw new DecryptError("Invalid COSE_Encrypt0");
  const prot = protBytes.length ? cborDecode(protBytes) : new CborMap();
  const alg = (mapGet(prot, 1) as number) ?? key.alg;
  const contentType = mapGet(prot, 3) as string | number | undefined;
  const iv = (mapGet(unprot, 5) ?? mapGet(prot, 5)) as Uint8Array | undefined;
  if (!(iv instanceof Uint8Array)) throw new DecryptError("COSE: missing IV");
  const aad = encStructure(protBytes);
  let pt: Uint8Array;
  try {
    pt = aeadDecrypt(alg, key.key, iv, ciphertext, aad);
  } catch (e) {
    throw new DecryptError("COSE decryption failed");
  }
  if (contentType === CT_PADDED_UTF8) pt = unpadBytes(pt).slice();
  return { bytes: pt, contentType };
}

function aeadDecrypt(alg: number, key: Uint8Array, nonce: Uint8Array, ct: Uint8Array, aad: Uint8Array): Uint8Array {
  switch (alg) {
    case ALG_XCHACHA20_POLY1305:
      return xchacha20poly1305(key, nonce, aad).decrypt(ct);
    case ALG_A256GCM:
      return gcm(key, nonce, aad).decrypt(ct);
    case ALG_XAES_256_GCM: {
      const [k, n] = xaesDerive(key, nonce);
      return gcm(k, n, aad).decrypt(ct);
    }
  }
  throw new DecryptError("Unsupported COSE algorithm " + alg);
}

function aeadEncrypt(alg: number, key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, aad: Uint8Array): Uint8Array {
  switch (alg) {
    case ALG_XCHACHA20_POLY1305:
      return xchacha20poly1305(key, nonce, aad).encrypt(pt);
    case ALG_A256GCM:
      return gcm(key, nonce, aad).encrypt(pt);
    case ALG_XAES_256_GCM: {
      const [k, n] = xaesDerive(key, nonce);
      return gcm(k, n, aad).encrypt(pt);
    }
  }
  throw new Error("Unsupported COSE algorithm " + alg);
}

function nonceLength(alg: number): number {
  return alg === ALG_A256GCM ? 12 : 24;
}

/** XAES-256-GCM key/nonce derivation (C2SP). */
function xaesDerive(key: Uint8Array, nonce: Uint8Array): [Uint8Array, Uint8Array] {
  if (nonce.length !== 24) throw new Error("XAES: bad nonce");
  const aes = (block: Uint8Array) => ecb(key, { disablePadding: true }).encrypt(block);
  const L = aes(new Uint8Array(16));
  const k1 = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const v = (L[i] << 1) | carry;
    carry = L[i] >> 7;
    k1[i] = v & 0xff;
  }
  if (L[0] & 0x80) k1[15] ^= 0x87;
  const m1 = concat(new Uint8Array([0, 1, 0x58, 0]), nonce.subarray(0, 12));
  const m2 = concat(new Uint8Array([0, 2, 0x58, 0]), nonce.subarray(0, 12));
  for (let i = 0; i < 16; i++) {
    m1[i] ^= k1[i];
    m2[i] ^= k1[i];
  }
  return [concat(aes(m1), aes(m2)), nonce.subarray(12, 24)];
}

function coseEncrypt0(data: Uint8Array, key: Extract<SymKey, { t: "cose" }>, contentType: string | number): Uint8Array {
  const prot = new CborMap();
  prot.set(1, key.alg);
  prot.set(3, contentType);
  if (key.kid.length) prot.set(4, key.kid);
  const protBytes = cborEncode(prot);
  const nonce = randomBytes(nonceLength(key.alg));
  const unprot = new CborMap();
  unprot.set(5, nonce);
  const pt = contentType === CT_PADDED_UTF8 ? padBytes(data, 32) : data;
  const ct = aeadEncrypt(key.alg, key.key, nonce, pt, encStructure(protBytes));
  return cborEncode([protBytes, unprot, ct]);
}

// ---------------------------------------------------------------------------------------------
// RSA

export interface PrivateKeyHandle {
  der: Uint8Array;
  sha1?: CryptoKey;
  sha256?: CryptoKey;
}

export function makePrivateKey(pkcs8: Uint8Array): PrivateKeyHandle {
  return { der: pkcs8 };
}

async function rsaKey(h: PrivateKeyHandle, hash: "SHA-1" | "SHA-256"): Promise<CryptoKey> {
  const prop = hash === "SHA-1" ? "sha1" : "sha256";
  if (!h[prop]) {
    h[prop] = await subtle.importKey("pkcs8", buf(h.der), { name: "RSA-OAEP", hash }, false, ["decrypt"]);
  }
  return h[prop]!;
}

export async function rsaDecrypt(encStr: string, h: PrivateKeyHandle): Promise<Uint8Array> {
  const p = parseEncString(encStr);
  let hash: "SHA-1" | "SHA-256";
  switch (p.type) {
    case EncType.Rsa2048_OaepSha1_B64:
    case EncType.Rsa2048_OaepSha1_HmacSha256_B64:
      hash = "SHA-1";
      break;
    case EncType.Rsa2048_OaepSha256_B64:
    case EncType.Rsa2048_OaepSha256_HmacSha256_B64:
      hash = "SHA-256";
      break;
    default:
      throw new DecryptError("Not an RSA EncString");
  }
  const k = await rsaKey(h, hash);
  return new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, k, buf(p.data)));
}

export async function rsaDecryptKey(encStr: string, h: PrivateKeyHandle): Promise<SymKey> {
  return symKeyFromBytes(await rsaDecrypt(encStr, h));
}

export async function rsaEncrypt(data: Uint8Array, spki: Uint8Array): Promise<string> {
  const k = await subtle.importKey("spki", buf(spki), { name: "RSA-OAEP", hash: "SHA-1" }, false, ["encrypt"]);
  const ct = new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, k, buf(data)));
  return "4." + b64encode(ct);
}

export async function generateRsaKeyPair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const kp = await subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-1" },
    true,
    ["encrypt", "decrypt"],
  );
  const pub = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const priv = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
  return { publicKey: pub, privateKey: priv };
}

// ---------------------------------------------------------------------------------------------
// KDF / master key

export enum KdfType {
  PBKDF2_SHA256 = 0,
  Argon2id = 1,
}

export interface KdfConfig {
  kdf: KdfType;
  iterations: number;
  memory?: number; // MiB
  parallelism?: number;
}

export async function pbkdf2(password: Uint8Array, salt: Uint8Array, iterations: number, len = 32): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buf(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations }, k, len * 8);
  return new Uint8Array(bits);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", buf(data)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, buf(data)));
}

export async function deriveMasterKey(password: string, salt: string, cfg: KdfConfig): Promise<Uint8Array> {
  // Bitwarden always normalises the salt (email) this way, also for server-provided salts.
  return deriveKeyFromPassword(password, salt.trim().toLowerCase(), cfg);
}

/** KDF with the salt exactly as given (e.g. the random salt of password-protected exports). */
export async function deriveKeyFromPassword(password: string, salt: string, cfg: KdfConfig): Promise<Uint8Array> {
  const pw = utf8(password);
  const s = utf8(salt);
  if (cfg.kdf === KdfType.PBKDF2_SHA256) {
    if (cfg.iterations < 5000) throw new Error("PBKDF2-Iterationen zu niedrig");
    return pbkdf2(pw, s, cfg.iterations);
  }
  if (cfg.kdf === KdfType.Argon2id) {
    const saltHash = await sha256(s);
    const out = await argon2id({
      password: pw,
      salt: saltHash,
      parallelism: cfg.parallelism ?? 4,
      iterations: cfg.iterations,
      memorySize: (cfg.memory ?? 64) * 1024,
      hashLength: 32,
      outputType: "binary",
    });
    return out;
  }
  throw new Error("Unbekannter KDF-Typ " + cfg.kdf);
}

/** HKDF-Expand(SHA-256) with L=32 (single block). */
export async function hkdfExpand32(prk: Uint8Array, info: string): Promise<Uint8Array> {
  return hmacSha256(prk, concat(utf8(info), new Uint8Array([1])));
}

export async function stretchMasterKey(masterKey: Uint8Array): Promise<SymKey> {
  const encK = await hkdfExpand32(masterKey, "enc");
  const macK = await hkdfExpand32(masterKey, "mac");
  return { t: "cbc-hmac", enc: encK, mac: macK };
}

export async function masterPasswordHash(masterKey: Uint8Array, password: string, iterations = 1): Promise<string> {
  return b64encode(await pbkdf2(masterKey, utf8(password), iterations));
}

/** Decrypt the user key with the master key (handles legacy unstretched type-0 keys). */
export async function decryptUserKeyWithMasterKey(encUserKey: string, masterKey: Uint8Array): Promise<SymKey> {
  const p = parseEncString(encUserKey);
  if (p.type === EncType.AesCbc256_B64) {
    return decryptKey(encUserKey, { t: "cbc", enc: masterKey });
  }
  return decryptKey(encUserKey, await stretchMasterKey(masterKey));
}

export async function rsaEncryptKey(key: SymKey, spki: Uint8Array): Promise<string> {
  return rsaEncrypt(symKeyToBytes(key), spki);
}

/** Stretch arbitrary 32 bytes of key material into an AES-CBC-HMAC key (as for the master key). */
export async function stretchKey(material: Uint8Array): Promise<SymKey> {
  return stretchMasterKey(material);
}

export async function argon2Key(secret: string, salt: Uint8Array, iterations = 3, memoryMiB = 64, parallelism = 4): Promise<Uint8Array> {
  return argon2id({
    password: utf8(secret),
    salt,
    parallelism,
    iterations,
    memorySize: memoryMiB * 1024,
    hashLength: 32,
    outputType: "binary",
  });
}

// ---------------------------------------------------------------------------------------------
// Encrypted files (attachments): [type][iv(16)][mac(32)][data] — "EncArrayBuffer"

export async function decryptFileData(buffer: Uint8Array, key: SymKey): Promise<Uint8Array> {
  const type = buffer[0];
  if (type === EncType.AesCbc256_HmacSha256_B64) {
    if (key.t !== "cbc-hmac") throw new DecryptError("Key type mismatch");
    const iv = buffer.subarray(1, 17);
    const mac = buffer.subarray(17, 49);
    const data = buffer.subarray(49);
    const mk = await hmacKey(key);
    const calc = new Uint8Array(await subtle.sign("HMAC", mk, buf(concat(iv, data))));
    if (!equalBytes(calc, mac)) throw new DecryptError("MAC mismatch");
    const ak = await aesKey(key);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, ak, buf(data)));
  }
  if (type === EncType.AesCbc256_B64) {
    if (key.t === "cose") throw new DecryptError("Key type mismatch");
    const iv = buffer.subarray(1, 17);
    const ak = await aesKey(key);
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: buf(iv) }, ak, buf(buffer.subarray(17))));
  }
  if (type === EncType.CoseEncrypt0) {
    if (key.t !== "cose") throw new DecryptError("Key type mismatch");
    return (await coseDecrypt0(buffer.subarray(1), key)).bytes;
  }
  throw new DecryptError("Unsupported file encryption type " + type);
}

export async function encryptFileData(data: Uint8Array, key: SymKey): Promise<Uint8Array> {
  if (key.t !== "cbc-hmac") throw new Error("Only AES-CBC-HMAC keys supported for files");
  const iv = randomBytes(16);
  const ak = await aesKey(key);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: buf(iv) }, ak, buf(data)));
  const mk = await hmacKey(key);
  const mac = new Uint8Array(await subtle.sign("HMAC", mk, buf(concat(iv, ct))));
  return concat(new Uint8Array([2]), iv, mac, ct);
}

export { b64encode, b64decode };

/** SPKI public key belonging to an RSA private key (PKCS#8). */
export async function publicKeyFromPrivate(h: PrivateKeyHandle): Promise<Uint8Array> {
  const priv = await subtle.importKey("pkcs8", buf(h.der), { name: "RSA-OAEP", hash: "SHA-1" }, true, ["decrypt"]);
  const jwk = await subtle.exportKey("jwk", priv);
  const pub = await subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP", ext: true },
    { name: "RSA-OAEP", hash: "SHA-1" },
    true,
    ["encrypt"],
  );
  return new Uint8Array(await subtle.exportKey("spki", pub));
}
