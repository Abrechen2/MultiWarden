// 2FA login flow against Vaultwarden (authenticator + remember-device token)
import { localData as local, loginUi, resetStorage } from "./chrome-stub";
import { LoginFlows } from "../src/background/login-flow";
import { VaultService } from "../src/background/vault-service";
import { deriveMasterKey, masterPasswordHash, KdfType } from "../src/crypto/bw";
import { generateTotp } from "../src/crypto/totp";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const PW = "Test-Passwort-123!";
const BASE = "http://localhost:8002",
  EMAIL = "alex@firma.test";

(async () => {
  let svc = new VaultService(() => {});
  await svc.ready;
  let flows = new LoginFlows(svc, loginUi);
  const start = () => flows.startPassword({ server: "selfhosted", baseUrl: BASE, email: EMAIL, password: PW });
  let r = await start();
  check("login before 2FA", r.step === "done", r);
  await flows.ack();
  const token = svc.accounts[0].accessToken!;
  const mk = await deriveMasterKey(PW, EMAIL, { kdf: KdfType.Argon2id, iterations: 3, memory: 64, parallelism: 4 });
  const hash = await masterPasswordHash(mk, PW);
  const h = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const g = await (
    await fetch(BASE + "/api/two-factor/get-authenticator", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ masterPasswordHash: hash }),
    })
  ).json();
  const key = g.authenticator.key;
  const code = (await generateTotp(key))!.code;
  const act = await fetch(BASE + "/api/two-factor/authenticator", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ key, token: code, userVerificationToken: g.userVerificationToken }),
  });
  check("authenticator enabled", act.ok, await act.text());

  // fresh install
  resetStorage();
  svc = new VaultService(() => {});
  await svc.ready;
  flows = new LoginFlows(svc, loginUi);
  r = await start();
  check("2FA required", r.step === "twoFactor" && !!r.twoFactor?.providers.includes(0), r);
  r = await flows.submitTwoFactor({ provider: 0, token: "000000", remember: true });
  check("wrong code rejected", r.step === "twoFactor" && !!r.error, r);
  const next = (await generateTotp(key, Date.now() + 30_000))!.code;
  r = await flows.submitTwoFactor({ provider: 0, token: next, remember: true });
  check("login with TOTP", r.step === "done", r);
  await flows.ack();
  check("remember token stored", Object.keys(local.twoFactorRemember ?? {}).length === 1, local.twoFactorRemember);
  await svc.logout(svc.accounts[0].key);
  r = await start();
  check("re-login uses remembered device", r.step === "done", r);
  await flows.ack();
  const v = await svc.getVault();
  check("vault after 2FA login", v.items.length >= 5, v.items.length);
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
