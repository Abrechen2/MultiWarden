// Registers a security key (WebAuthn 2FA) for alex@firma.test on Vaultwarden B, using a software
// authenticator. Prints the credential (id + PKCS#8 key) as JSON for the browser test, which loads
// it into a virtual authenticator.
import { loginUi } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { prelogin } from "../src/background/api";
import { deriveMasterKey, masterPasswordHash } from "../src/crypto/bw";
import { attestationObject, b64urlToBytes, buildAuthData, bytesToB64url, clientDataJSON, createKeyPair } from "../src/crypto/fido2";
import { b64encode } from "../src/crypto/utils";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:8002";
const EMAIL = "alex@firma.test";
const PW = "Test-Passwort-123!";

(async () => {
  const svc = new VaultService(() => {});
  await svc.ready;
  const flows = new LoginFlows(svc, loginUi);
  const f = await flows.startPassword({ server: "selfhosted", baseUrl: BASE, email: EMAIL, password: PW });
  if (f.step !== "done") throw new Error("login failed: " + JSON.stringify(f));
  const token = svc.accounts[0].accessToken!;
  const pre = await prelogin(svc.accounts[0].urls, EMAIL);
  const hash = await masterPasswordHash(await deriveMasterKey(PW, pre.salt, pre.kdf), PW);
  const h = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const post = async (path: string, body: any, method = "POST") => {
    const r = await fetch(BASE + "/api" + path, { method, headers: h, body: JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(path + " " + r.status + " " + t);
    return JSON.parse(t);
  };
  const g = await post("/two-factor/get-webauthn", { masterPasswordHash: hash });
  const ch = await post("/two-factor/get-webauthn-challenge", { userVerificationToken: g.userVerificationToken });
  const opts = ch.options;
  const kp = await createKeyPair();
  const credId = crypto.getRandomValues(new Uint8Array(32));
  const rpId = opts.rp.id;
  const authData = await buildAuthData({
    rpId,
    counter: 0,
    userPresence: true,
    userVerification: false,
    backup: false,
    attested: { credentialId: credId, x: kp.x, y: kp.y },
  });
  const cdj = clientDataJSON("webauthn.create", bytesToB64url(b64urlToBytes(opts.challenge)), new URL(BASE).origin);
  await post(
    "/two-factor/webauthn",
    {
      id: 1,
      name: "Test-Sicherheitsschlüssel",
      userVerificationToken: g.userVerificationToken,
      deviceResponse: {
        id: bytesToB64url(credId),
        rawId: bytesToB64url(credId),
        type: "public-key",
        response: { attestationObject: bytesToB64url(attestationObject(authData)), clientDataJson: bytesToB64url(cdj) },
      },
    },
    "PUT",
  );
  const out = { rpId, credentialId: b64encode(credId), privateKey: b64encode(kp.pkcs8) };
  writeFileSync(process.argv[2] ?? "webauthn-cred.json", JSON.stringify(out));
  console.log("registered security key for", EMAIL, "rpId", rpId);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
