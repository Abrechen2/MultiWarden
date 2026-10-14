// FIDO2 / WebAuthn authenticator primitives, compatible with Bitwarden's passkey storage format.
import { getDomain } from "tldts";
import { cborEncode, CborMap } from "./cbor";
import { b64decode, b64urlencode, buf, concat, utf8 } from "./utils";

const subtle = globalThis.crypto.subtle;

/** Bitwarden's AAGUID, so relying parties show the same authenticator name as for the official client. */
export const AAGUID = new Uint8Array([0xd5, 0x48, 0x82, 0x6e, 0x79, 0xb4, 0xdb, 0x40, 0xa3, 0xd8, 0x11, 0x11, 0x6f, 0x7e, 0x83, 0x49]);

export function b64urlToBytes(s: string): Uint8Array {
  return b64decode(s);
}

export function bytesToB64url(b: Uint8Array): string {
  return b64urlencode(b);
}

// ---------------------------------------------------------------------------------------------
// Credential IDs: Bitwarden stores them as GUID strings, or "b64.<base64url>" for foreign IDs

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guidToBytes(guid: string): Uint8Array {
  if (!GUID_RE.test(guid)) throw new TypeError("invalid GUID");
  const hex = guid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToGuid(b: Uint8Array): string {
  if (b.length !== 16) throw new TypeError("invalid length");
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function parseCredentialId(stored: string): Uint8Array | null {
  try {
    if (stored.startsWith("b64.")) return b64urlToBytes(stored.slice(4));
    return guidToBytes(stored);
  } catch {
    return null;
  }
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// RP ID validation (WebAuthn §5.1.4: rpId must be the origin's host or a registrable suffix of it)

export function isValidRpId(rpId: string, origin: string): boolean {
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost")) return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  const rp = rpId.toLowerCase();
  if (rp === host) return true;
  if (!host.endsWith("." + rp)) return false;
  // rpId must not be a public suffix: it has to be (a parent of) the registrable domain
  const reg = getDomain(host, { allowPrivateDomains: true });
  if (!reg) return false;
  return rp === reg || rp.endsWith("." + reg);
}

// ---------------------------------------------------------------------------------------------
// Keys & signatures

export interface NewKeyPair {
  pkcs8: Uint8Array;
  spki: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
}

export async function createKeyPair(): Promise<NewKeyPair> {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", kp.privateKey));
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const jwk = await subtle.exportKey("jwk", kp.publicKey);
  return { pkcs8, spki, x: b64urlToBytes(jwk.x!), y: b64urlToBytes(jwk.y!) };
}

/** ECDSA P1363 (r||s) → ASN.1 DER, as WebAuthn expects. */
export function p1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const enc = (int: Uint8Array) => {
    let i = 0;
    while (i < int.length - 1 && int[i] === 0) i++;
    let v = int.subarray(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const r = enc(sig.subarray(0, half));
  const s = enc(sig.subarray(half));
  const body = concat(r, s);
  return concat(new Uint8Array([0x30, body.length]), body);
}

export async function signWithPkcs8(pkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("pkcs8", buf(pkcs8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(data)));
  return p1363ToDer(sig);
}

// ---------------------------------------------------------------------------------------------
// Authenticator data

export interface AuthDataParams {
  rpId: string;
  counter: number;
  userPresence: boolean;
  userVerification: boolean;
  attested?: { credentialId: Uint8Array; x: Uint8Array; y: Uint8Array };
  /** backup eligible + backed up (synced passkey); default true */
  backup?: boolean;
}

export async function buildAuthData(p: AuthDataParams): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await subtle.digest("SHA-256", buf(utf8(p.rpId))));
  let flags = 0;
  if (p.userPresence) flags |= 0x01;
  if (p.userVerification) flags |= 0x04;
  if (p.backup !== false) flags |= 0x08 | 0x10; // backup eligible + backed up (synced vault)
  if (p.attested) flags |= 0x40;
  const c = p.counter >>> 0;
  const counter = new Uint8Array([(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]);
  const parts = [rpIdHash, new Uint8Array([flags]), counter];
  if (p.attested) {
    const id = p.attested.credentialId;
    const cose = new CborMap();
    cose.set(1, 2); // kty: EC2
    cose.set(3, -7); // alg: ES256
    cose.set(-1, 1); // crv: P-256
    cose.set(-2, p.attested.x);
    cose.set(-3, p.attested.y);
    parts.push(AAGUID, new Uint8Array([(id.length >> 8) & 0xff, id.length & 0xff]), id, cborEncode(cose));
  }
  return concat(...parts);
}

export function attestationObject(authData: Uint8Array): Uint8Array {
  const m = new CborMap();
  m.set("fmt", "none");
  m.set("attStmt", new CborMap());
  m.set("authData", authData);
  return cborEncode(m);
}

export function clientDataJSON(
  type: "webauthn.get" | "webauthn.create",
  challengeB64url: string,
  origin: string,
  crossOrigin = false,
): Uint8Array {
  // property order as browsers (and the official client) produce it
  return utf8(JSON.stringify({ type, challenge: challengeB64url, origin, crossOrigin }));
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", buf(data)));
}
