// Regression tests for the security hardening of this fork: a malicious server must not be able to
// downgrade authenticated encryption, inject plaintext into encrypted fields or weaken the KDF.
import "./chrome-stub";
import {
  decryptBytes,
  decryptFileData,
  deriveKeyFromPassword,
  encryptString,
  generateCbcHmacKey,
  b64encode,
  KdfType,
  SymKey,
} from "../src/crypto/bw";
import { decryptCipher } from "../src/background/vault-crypto";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const rejects = async (p: Promise<unknown>) => p.then(() => false, () => true);

/** AES-256-CBC without MAC (EncString type 0) under the encryption half of a CBC-HMAC key. */
async function cbcNoMac(plain: Uint8Array, key: SymKey) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ak = await crypto.subtle.importKey("raw", (key as any).enc, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, ak, plain));
  return { iv, ct };
}

(async () => {
  const key = generateCbcHmacKey();
  const plain = new TextEncoder().encode("geheim");

  // H1: type-0 downgrade
  const { iv, ct } = await cbcNoMac(plain, key);
  check("type-0 EncString rejected for a MAC key", await rejects(decryptBytes(`0.${b64encode(iv)}|${b64encode(ct)}`, key)));
  const file = new Uint8Array(1 + 16 + ct.length);
  file.set(iv, 1);
  file.set(ct, 17);
  check("type-0 file data rejected for a MAC key", await rejects(decryptFileData(file, key)));
  const good = await encryptString("geheim", key);
  check("type-2 EncString still decrypts", new TextDecoder().decode((await decryptBytes(good, key)).bytes) === "geheim");

  // H2: plaintext injected into encrypted fields
  const cipher = {
    id: "c1",
    type: 1,
    name: await encryptString("Bank", key),
    login: {
      username: "injected-user",
      password: "injected-pass",
      uris: [{ uri: "https://evil.example", match: null }],
    },
  };
  const view = await decryptCipher("acc", cipher, { userKey: key, orgKeys: new Map() });
  check("plaintext URI not accepted", !view.login?.uris?.some((u) => u.uri === "https://evil.example"), view.login?.uris);
  check("plaintext password not accepted", view.login?.password !== "injected-pass", view.login?.password);
  check("plaintext username not accepted", view.login?.username !== "injected-user", view.login?.username);
  check("encrypted name still decrypts", view.name === "Bank", view.name);

  // M1: Argon2id parameter floor (Bitwarden minimums: t>=2, m>=16 MiB, p>=1)
  const argon = (iterations: number, memory: number, parallelism: number) =>
    deriveKeyFromPassword("pw", "salt@example.com", { kdf: KdfType.Argon2id, iterations, memory, parallelism });
  check("argon2 t=1 rejected", await rejects(argon(1, 64, 4)));
  check("argon2 m=1 MiB rejected", await rejects(argon(3, 1, 4)));
  check("argon2 p=0 rejected", await rejects(argon(3, 64, 0)));
  check("argon2 m=2048 MiB rejected", await rejects(argon(3, 2048, 4)));
  check("argon2 defaults accepted", !(await rejects(argon(3, 64, 4))));

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
