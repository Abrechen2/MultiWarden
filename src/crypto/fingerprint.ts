// Bitwarden fingerprint phrase (used to verify device approval requests).
import { EFF_WORDS } from "../shared/eff-wordlist";
import { hkdfExpand32, sha256 } from "./bw";

export async function fingerprintPhrase(material: string, publicKey: Uint8Array): Promise<string> {
  // HMAC hashes keys longer than the block size, so using sha256(publicKey) as PRK equals the SDK's
  // HKDF::from_prk(publicKey).
  const prk = await sha256(publicKey);
  const userFp = await hkdfExpand32(prk, material);
  let n = 0n;
  for (const b of userFp) n = (n << 8n) | BigInt(b);
  const words: string[] = [];
  const len = BigInt(EFF_WORDS.length);
  const numWords = Math.ceil(64 / Math.log2(EFF_WORDS.length));
  for (let i = 0; i < numWords; i++) {
    words.push(EFF_WORDS[Number(n % len)]);
    n = n / len;
  }
  return words.join("-");
}
