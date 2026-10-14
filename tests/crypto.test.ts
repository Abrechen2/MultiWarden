// Crypto unit tests. The test vectors (KDF hashes, the V2 test account, the XChaCha20 COSE message and the
// fingerprint key) come from the official Bitwarden SDK, https://github.com/bitwarden/sdk-internal
// (crates bitwarden-crypto, bitwarden-core and bitwarden-wasm-internal; "GPL-3.0-only OR Bitwarden SDK License",
// used here under the GPL-3.0).
import {
  deriveMasterKey,
  masterPasswordHash,
  KdfType,
  decryptUserKeyWithMasterKey,
  parseCoseKey,
  decryptBytes,
  decryptKey,
  encryptString,
  decryptString,
  encryptKey,
  generateCbcHmacKey,
  b64decode,
  b64encode,
  ALG_XCHACHA20_POLY1305,
  ALG_XAES_256_GCM,
  SymKey,
  symKeyFromBytes,
  symKeyToBytes,
} from "../src/crypto/bw";
import { generateTotp } from "../src/crypto/totp";
import { fingerprintPhrase } from "../src/crypto/fingerprint";
import { encryptFileData, decryptFileData } from "../src/crypto/bw";
import {
  guidToBytes,
  bytesToGuid,
  parseCredentialId,
  createKeyPair,
  buildAuthData,
  signWithPkcs8,
  isValidRpId,
  attestationObject,
} from "../src/crypto/fido2";
import { cborDecode } from "../src/crypto/cbor";
import { cborEncode } from "../src/crypto/cbor";
import { hex } from "../src/crypto/utils";
import { gcm } from "@noble/ciphers/aes";

let failed = 0;
function check(name: string, ok: boolean, info = "") {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " " + info));
  if (!ok) failed++;
}

(async () => {
  for (const salt of ["test@bitwarden.com", "TEST@bitwarden.com", " test@bitwarden.com"]) {
    const mk = await deriveMasterKey("asdfasdf", salt.trim().toLowerCase(), { kdf: KdfType.PBKDF2_SHA256, iterations: 100000 });
    check(
      "pbkdf2 hash " + JSON.stringify(salt),
      (await masterPasswordHash(mk, "asdfasdf")) === "wmyadRMyBZOH7P/a/ucTCbSghKgdzDpPqUnu/DAVtSw=",
    );
  }
  const mkA = await deriveMasterKey("asdfasdf", "test_salt", { kdf: KdfType.Argon2id, iterations: 4, memory: 32, parallelism: 2 });
  check("argon2id hash", (await masterPasswordHash(mkA, "asdfasdf")) === "PR6UjYmjmppTYcdyTiNbAhPJuQQOmynKbdEl1oyi/iQ=");

  const mkL = await deriveMasterKey("asdfasdfasdf", "legacy@bitwarden.com", { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 });
  const ukL = await decryptUserKeyWithMasterKey(
    "0.8UClLa8IPE1iZT7chy5wzQ==|6PVfHnVk5S3XqEtQemnM5yb4JodxmPkkWzmDRdfyHtjORmvxqlLX40tBJZ+CKxQWmS8tpEB5w39rbgHg/gqs0haGdZG4cPbywsgGzxZ7uNI=",
    mkL,
  );
  check("legacy type0 user key", ukL.t === "cbc-hmac" && Array.from((ukL as any).enc.slice(0, 4)).join(",") === "12,95,151,203");

  // v2 fixtures
  // V2 test account (sdk-internal: test_bitwarden_com_account_v2 / integration-tests v2-fixtures.ts)
  const V2_DECRYPTED_USER_KEY = "pQEEAlCxZkKFDpp70P5mWPmOjf3xAzoAARF5BIQDBAUGIFggCFcd6XLISUfLaITyU9yimrYHacdS5XhBayO2663jdSUB";
  const V2_PRIVATE_KEY =
    "7.g1gdowE6AAEReQMZARwEULFmQoUOmnvQ/mZY+Y6N/fGhBVgYe16rmgYXX3Orgo6y5U5Z8eb+JHTGfcivWQTR+1rVWtHJhEm8G/AtE78Ud3S8" +
    "qxZmstUKhC5u9xgPvx2e8Fe8QL80Dv0WoEsy0XEb+5EFd8xDlu7OBuCVv2MaoJ/XzAkbpn9IT1vMCPhvRuaktIWMNrQgJ1jnmqjTGObftA02sH" +
    "nj938tLRNfilw8ln/PBO2GBZQVzTUYfnc+mBeedGyZAxhSxyUwtFB8h3HC/t9BGtLT/bm83Df8rwTc+rGFL5r+T6vczQ+6hvF6kKpUb37XwgLE" +
    "Dsc+J4UTb+4zHaDcTioOYq6Hki8PrsN9PWL57nkhRMi3fKgfz8GDtY+pjp7D9HYV6OMuveSK9l+h16enJwiFDy6XEx+eth4aHPT5hybnOfTWbk" +
    "EIhUmPD3K2JKvUUxeL9Z6e1EtSylVitO4Lit485KYaY8VASW4MnAzPOUQVwZ4jowHr5X8g0jVtHiLeUuOwDGcqjO/q6//tkiCwjW/W79jk4eqM" +
    "tqPbOl0XelYVmM4KZCslPZ+2IYS56g/gl8Q2Oj9UGq7QJCsZvV9rBNa4wS3uC9atoWWRqO2PTWkVTurakkK3Fc9VP2bC1lJaWoWVjYpyJJVZh7" +
    "7ktpD3VrFdrT62+de0iaWUAtAr/1ALToNzoTYu3ihyGb6FZMN//XLTKk8GhZGVCluEDClHnziBxCX7Qg/0HRiU7EjsYGhpFnmG2XkvZQb9Pds8" +
    "gucTbmbUeVfjXZ/IOLm16G/tdit2VIf80zcsvhgxTYys4Cm12N+62fM3aT5L9lqWvBYOMDksy00/3uLPzWbLFWbKItaC1c+bceGS7UDrLim6Pm" +
    "/Voo2jXCi6EHpXX2/THrJybRDwqmQi7UVWXR3aPx//q9busEXxRyeu0m4lq2AjhQWhOvfPjpJzNX1hRE9Bu7UKYJhUF6DAsXFFKpob0LoARpcj" +
    "GLFLcO61yV6He2nQFAa+ULXxhrKbISzqO3Q2xMs2p3jQ4Ctm0T+03w9Y5/Yf1qNKaL6AayA2nf0thYgh+OHNEnnkFwvBnTyB5B32E+/cUy7bb3" +
    "329Pz7h+ruLo5IhGZM5GiEjF4vOSZmZJZ1t2eR4U7oxX0VTpwFPPBUQ3O7A5C2l0g/pGCFda4QlgR5qRA09kaAd9VBSJbQABGH0zWlXNPAjPQ6" +
    "M9CxxTv9lM/72RSzTvnJqjQNpWGQjYuTi++EN5QZ37Nmlcw9eSa6X1C97ADndWV46dlFowUUDXiczi+Q0bZmFtpvkRg0TWlicS/cURLIfpG7sG" +
    "wgqIis5R4haQ+RDB1+4oC0xmncWqy7vMESW6trh+icEL2PybwGPnzdngUqEIw5fG9huX3BmxbJjukSjWWk2CH8AaY2lHRXttzpOhpfP9c1cmrw" +
    "XXUuHwTFMiKdmdwSqGbgebUP25kB9priXO88Jri3Wb739KRV5M2k6/9AspCwpOqlKN6MZm2vElNI+cXSWMHeX3666p4ALr7Vu7+q7iw4s4cO09" +
    "MMJWsaiTaZBsVRhdoocsej+091JM/yJ29TVDJEMp2vEiia8HQ4k2bH9W9XCB71cpygRMYTFRDJ3Yjly4MYg7whBQnkeu8IYagCY6UZ60V73qhK" +
    "RZJKuiV6ZTC+objnMPMmi9Kd05WmYFab8ZDP8s4yhU0WJNXdZGwpX7pnoi0T+g/y94sfZNGs5QuKgNEX";
  const V2_SIGNING_KEY =
    "7.g1gcowE6AAEReQMYZQRQsWZChQ6ae9D+Zlj5jo398aEFWBj8Gg/gn4tQKWO3nq5e/2p9gkzIrKD829RYT3aEUIDOetEtnFqRuQ3Cz13693Wq" +
    "DnKHM5Buzi6LcTsxo1jphYR7vlE5nYLjCpOCAftPN1oLfs5SCNkwwMENhujpVftfDzciE99aLEJDS9A=";
  const uk2 = parseCoseKey(b64decode(V2_DECRYPTED_USER_KEY));
  check("v2 user key is XAES", uk2.t === "cose" && (uk2 as any).alg === ALG_XAES_256_GCM, JSON.stringify((uk2 as any).alg));
  check("v2 key id", hex((uk2 as any).kid) === "b16642850e9a7bd0fe6658f98e8dfdf1");
  const pk = await decryptBytes(V2_PRIVATE_KEY, uk2);
  check(
    "v2 private key decrypts to PKCS8",
    pk.bytes[0] === 0x30 && pk.bytes[1] === 0x82,
    hex(pk.bytes.slice(0, 4)) + " ct=" + pk.contentType,
  );
  const sk = await decryptBytes(V2_SIGNING_KEY, uk2);
  check("v2 signing key decrypts", sk.bytes.length > 0, String(sk.contentType));

  // XChaCha20 COSE test vector
  const kid = new Uint8Array(16).map((_, i) => i);
  const kdata = new Uint8Array(32).map((_, i) => i);
  const xk: SymKey = { t: "cose", alg: ALG_XCHACHA20_POLY1305, key: kdata, kid };
  const vec = new Uint8Array([
    131, 88, 28, 163, 1, 58, 0, 1, 17, 111, 3, 24, 42, 4, 80, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 161, 5, 88, 24, 78, 20,
    28, 157, 180, 246, 131, 220, 82, 104, 72, 73, 75, 43, 69, 139, 216, 167, 145, 220, 67, 168, 144, 173, 88, 35, 127, 234, 194, 83, 189,
    172, 65, 29, 156, 73, 98, 87, 231, 87, 129, 15, 235, 127, 125, 97, 211, 51, 212, 211, 2, 13, 36, 123, 53, 12, 31, 191, 40, 13, 175,
  ]);
  const r = await decryptBytes("7." + b64encode(vec), xk);
  check("xchacha20 COSE vector", new TextDecoder().decode(r.bytes) === "Message test vector");

  // roundtrips
  const k2 = generateCbcHmacKey();
  const e2 = await encryptString("Hällo wörld", k2);
  check("type2 roundtrip", (await decryptString(e2, k2)) === "Hällo wörld");
  for (const key of [xk, uk2]) {
    const e7 = await encryptString("geheim 🔑", key);
    check("type7 roundtrip alg " + (key as any).alg, e7.startsWith("7.") && (await decryptString(e7, key)) === "geheim 🔑");
    const wrapped = await encryptKey(k2, key);
    const unwrapped = await decryptKey(wrapped, key);
    check("type7 key wrap", unwrapped.t === "cbc-hmac" && b64encode(symKeyToBytes(unwrapped)) === b64encode(symKeyToBytes(k2)));
  }
  // cose key wrapped by cbc-hmac (padded)
  const w = await encryptKey(uk2, k2);
  const uw = await decryptKey(w, k2);
  check("COSE key wrapped in type2", uw.t === "cose" && hex((uw as any).key) === hex((uk2 as any).key));
  check("symKeyFromBytes(64)", symKeyFromBytes(new Uint8Array(64)).t === "cbc-hmac");

  // TOTP RFC6238
  const t = await generateTotp("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8", 59000);
  check("totp rfc6238", t?.code === "94287082", t?.code);
  const t2 = await generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109000);
  check("totp plain secret 6 digits", t2?.code === "081804", t2?.code);

  // fingerprint phrase (SDK test vector)
  const fpKey = new Uint8Array([
    48, 130, 1, 34, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, 3, 130, 1, 15, 0, 48, 130, 1, 10, 2, 130, 1, 1, 0, 187, 38, 44,
    241, 110, 205, 89, 253, 25, 191, 126, 84, 121, 202, 61, 223, 189, 244, 118, 212, 74, 139, 130, 97, 115, 164, 167, 106, 191, 188, 233,
    218, 196, 250, 187, 146, 125, 160, 150, 49, 198, 224, 176, 10, 0, 143, 99, 230, 232, 160, 51, 104, 154, 211, 33, 80, 170, 4, 68, 80,
    219, 115, 167, 114, 156, 227, 125, 193, 128, 123, 39, 254, 191, 124, 63, 129, 44, 63, 18, 56, 161, 48, 158, 0, 27, 146, 2, 99, 136, 75,
    21, 135, 6, 118, 12, 26, 251, 184, 172, 249, 53, 78, 210, 46, 143, 17, 104, 202, 65, 173, 229, 219, 233, 144, 163, 101, 216, 238, 152,
    54, 158, 1, 195, 50, 203, 21, 226, 12, 82, 170, 175, 170, 160, 21, 247, 248, 80, 97, 123, 0, 152, 116, 229, 126, 221, 199, 155, 194,
    192, 51, 207, 177, 240, 160, 84, 241, 41, 88, 176, 53, 111, 28, 173, 177, 232, 158, 22, 79, 133, 152, 31, 32, 12, 196, 147, 58, 57, 50,
    252, 208, 131, 150, 179, 132, 178, 150, 234, 251, 143, 125, 163, 144, 20, 46, 71, 168, 252, 164, 86, 120, 124, 56, 252, 206, 210, 236,
    212, 139, 127, 189, 236, 40, 46, 2, 238, 13, 216, 40, 48, 85, 133, 229, 181, 155, 176, 217, 241, 154, 153, 213, 112, 222, 72, 219, 197,
    3, 219, 56, 77, 109, 47, 72, 251, 131, 36, 240, 96, 169, 31, 82, 93, 166, 242, 3, 33, 213, 2, 3, 1, 0, 1,
  ]);
  const fp = await fingerprintPhrase("a09726a0-9590-49d1-a5f5-afe300b6a515", fpKey);
  check("fingerprint phrase", fp === "turban-deftly-anime-chatroom-unselfish", fp);

  // file encryption roundtrip
  const fk = generateCbcHmacKey();
  const fileData = new TextEncoder().encode("Anhang-Inhalt äöü ".repeat(100));
  const encFile = await encryptFileData(fileData, fk);
  const decFile = await decryptFileData(encFile, fk);
  check("file roundtrip", new TextDecoder().decode(decFile) === new TextDecoder().decode(fileData));
  encFile[60] ^= 1;
  let tamperOk = false;
  try {
    await decryptFileData(encFile, fk);
  } catch {
    tamperOk = true;
  }
  check("file tamper detected", tamperOk);

  // fido2 primitives
  const g = "6f4f7a43-2f5c-4c5e-9f1b-0a1b2c3d4e5f";
  check("guid roundtrip", bytesToGuid(guidToBytes(g)) === g);
  check("credential id b64", parseCredentialId("b64.AQID")!.join(",") === "1,2,3");
  const kp = await createKeyPair();
  const ad = await buildAuthData({ rpId: "example.com", counter: 0, userPresence: true, userVerification: true });
  check("authData length/flags", ad.length === 37 && ad[32] === 0x1d, String(ad[32]));
  const cdh = new Uint8Array(32).fill(7);
  const der = await signWithPkcs8(kp.pkcs8, new Uint8Array([...ad, ...cdh]));
  // DER -> raw for WebCrypto verify
  const readInt = (b: Uint8Array, o: number) => {
    const len = b[o + 1];
    let v = b.subarray(o + 2, o + 2 + len);
    while (v.length > 32) v = v.subarray(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return [out, o + 2 + len] as const;
  };
  const [rr, o1] = readInt(der, 2);
  const [sv] = readInt(der, o1);
  const raw = new Uint8Array(64);
  raw.set(rr);
  raw.set(sv, 32);
  const pub = await crypto.subtle.importKey("spki", kp.spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw, new Uint8Array([...ad, ...cdh]));
  check("passkey signature verifies (DER)", ok && der[0] === 0x30);
  const regAd = await buildAuthData({
    rpId: "example.com",
    counter: 0,
    userPresence: true,
    userVerification: false,
    attested: { credentialId: guidToBytes(g), x: kp.x, y: kp.y },
  });
  check(
    "attested authData (cose prefix)",
    hex(regAd.subarray(37 + 16 + 2 + 16, 37 + 16 + 2 + 16 + 10)) === "a5010203262001215820",
    hex(regAd.subarray(71, 81)),
  );
  check("attested flags", regAd[32] === 0x59, String(regAd[32]));
  const att = cborDecode(attestationObject(regAd)) as Map<any, any>;
  check("attestation object", att.get("fmt") === "none" && (att.get("authData") as Uint8Array).length === regAd.length);
  check("rpId valid subdomain", isValidRpId("example.com", "https://login.example.com"));
  check("rpId invalid other domain", !isValidRpId("example.org", "https://login.example.com"));
  check("rpId invalid public suffix", !isValidRpId("co.uk", "https://foo.co.uk"));
  check("rpId http rejected", !isValidRpId("example.com", "http://example.com"));
  check("rpId localhost", isValidRpId("localhost", "http://localhost:9000"));

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
