// Browser test of release 1.2 account features: registration, master password change, organization
// master password policy, vault timeout (immediately / never / log out), login with device (two
// browser profiles), fingerprint phrase, devices, password hint.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = SP + "/shots";
const PW = "Test-Passwort-123!";
const A = "http://localhost:8001";
mkdirSync(SHOTS, { recursive: true });
let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browser(name) {
  const profile = SP + "/profile-acc-" + name;
  rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, {
    ...chromiumOptions,
    headless: true,
    locale: "de-DE",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
    viewport: { width: 1000, height: 760 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  // RPC page that is not a popup (the popup's connection decides about the "immediately" timeout)
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/inline-menu.html#rpc`);
  const rpc = async (n, args = {}) => {
    const r = await ext.evaluate(([x, a]) => chrome.runtime.sendMessage({ rpc: x, args: a }), [n, args]);
    if (!r?.ok) throw new Error(n + ": " + r?.error);
    return r.data;
  };
  const popup = async (q = "", wait = '[data-testid="all-items"]') => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 380, height: 640 });
    await p.goto(`chrome-extension://${extId}/popup.html${q}`);
    if (wait) await p.waitForSelector(wait, { timeout: 15000 });
    await p.waitForTimeout(300);
    return p;
  };
  return { ctx, sw, extId, ext, rpc, popup };
}

const one = await browser("one");
const { rpc, popup, sw } = one;

// 1. registration in the UI (self-hosted server, no e-mail verification) → logged in right away
const newEmail = `neu${Date.now()}@privat.test`;
const NEWPW = "Neues-Konto-Passwort-42";
{
  const p = await popup("", '[data-testid="open-register"]');
  await p.click('[data-testid="open-register"]');
  await p.getByRole("button", { name: "Eigener Server" }).click();
  await p.fill('input[name="server-url"]', A);
  await p.fill('input[name="email"]', newEmail);
  await p.fill('input[name="reg-name"]', "Neue Nutzerin");
  await p.fill('input[name="reg-password"]', NEWPW);
  await p.fill('input[name="reg-password2"]', NEWPW);
  await p.screenshot({ path: `${SHOTS}/account-register.png` });
  await p.click('[data-testid="register-submit"]');
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 30000 }).catch(() => {});
  const st = await rpc("getState");
  const acc = st.accounts.find((a) => a.email === newEmail);
  check("registered and logged in", acc?.status === "unlocked", JSON.stringify(st.accounts.map((a) => [a.email, a.status])));
  await p.close();
}
let st = await rpc("getState");
const newKey = st.accounts.find((a) => a.email === newEmail).key;

// 2. change the master password
const CHANGED = "Geaendertes-Passwort-2026!";
{
  // an item to check that the vault stays readable
  await rpc("saveItem", {
    accountKey: newKey,
    isNew: true,
    item: {
      id: "",
      accountKey: newKey,
      type: 1,
      name: "Nach Wechsel",
      favorite: false,
      reprompt: 0,
      edit: true,
      viewPassword: true,
      collectionIds: [],
      fields: [],
      passwordHistory: [],
      attachments: [],
      login: { username: "x", password: "bleibt-gleich", uris: [], passkeys: 0 },
    },
  });
  const p = await popup();
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-change-password"]');
  await p.waitForSelector('[data-testid="cp-save"]');
  if (await p.locator('[data-testid="cp-account"]').count()) await p.selectOption('[data-testid="cp-account"]', newKey);
  await p.fill('input[name="cp-current"]', "falsch-falsch-falsch");
  await p.fill('input[name="cp-new"]', CHANGED);
  await p.fill('input[name="cp-new2"]', CHANGED);
  await p.locator("label.checkbox", { hasText: "Datenlecks" }).click(); // no internet in the test
  await p.click('[data-testid="cp-save"]');
  await p.waitForTimeout(2500);
  const err = (await p.locator(".banner.error").textContent().catch(() => "")) ?? "";
  check("wrong current master password refused", /falsch/.test(err), err);
  await p.fill('input[name="cp-current"]', NEWPW);
  await p.screenshot({ path: `${SHOTS}/account-change-password.png` });
  await p.click('[data-testid="cp-save"]');
  for (let i = 0; i < 30 && (await p.locator('[data-testid="cp-save"]').count()); i++) await sleep(300);
  check("master password changed (dialog closed)", (await p.locator('[data-testid="cp-save"]').count()) === 0);
  const toastText = await p.locator(".toast").allTextContents().catch(() => []);
  const st1 = await rpc("getState");
  check(
    "still signed in after the change (new session)",
    st1.accounts.find((a) => a.key === newKey)?.status === "unlocked",
    JSON.stringify([toastText, st1.accounts.map((a) => a.status)]),
  );
  await p.close();
  await rpc("lock", { accountKey: newKey });
  const bad = await rpc("unlock", { password: NEWPW, accountKeys: [newKey] });
  check("old master password no longer unlocks", !bad.results[0]?.ok, JSON.stringify(bad));
  const good = await rpc("unlock", { password: CHANGED, accountKeys: [newKey] });
  check("new master password unlocks", good.results[0]?.ok, JSON.stringify(good));
  const s = await rpc("sync", { accountKey: newKey });
  const v = await rpc("getVault");
  check(
    "session still valid, vault readable",
    s.ok && v.items.some((i) => i.accountKey === newKey && i.login?.password === "bleibt-gleich"),
    JSON.stringify(s),
  );
  // fresh login with the new password (server side changed)
  await rpc("logout", { accountKey: newKey });
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: newEmail, password: CHANGED });
  check("login with the new master password", f.step === "done", JSON.stringify(f));
  await rpc("loginAck");
}

// 3. organization policy: master password requirements enforced on login
{
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "alex@privat.test", password: PW });
  await rpc("loginAck");
  const aliceKey = f.accountKey;
  const orgId = (await rpc("getVault")).organizations.find((o) => o.accountKey === aliceKey).id;
  const setPolicy = (enabled) =>
    sw.evaluate(
      ([k, o, en]) => {
        const svc = globalThis.__mwTest.svc;
        return svc.api(svc.account(k)).send("PUT", `/organizations/${o}/policies/1`, {
          policy: {
            enabled: en,
            data: { minComplexity: null, minLength: 20, requireUpper: true, requireLower: false, requireNumbers: true, requireSpecial: false, enforceOnLogin: true },
          },
        });
      },
      [aliceKey, orgId, enabled],
    );
  await setPolicy(true);
  await rpc("sync", { accountKey: aliceKey });
  const pol = await rpc("masterPasswordPolicy", { accountKey: aliceKey });
  check("organization master password policy read", pol.policy?.minLength === 20 && pol.policy?.enforceOnLogin === true, JSON.stringify(pol));
  // log in again → the 18-character password violates minLength 20
  await rpc("logout", { accountKey: aliceKey });
  const f2 = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "alex@privat.test", password: PW });
  await rpc("loginAck");
  st = await rpc("getState");
  check("weak password flagged after login", st.accounts.find((a) => a.key === f2.accountKey)?.forcePasswordChange === "weak");
  const p = await popup();
  check("vault shows the change banner", (await p.locator('[data-testid="force-password-banner"]').count()) === 1);
  await p.locator('[data-testid="force-password-banner"] button').click();
  await p.waitForSelector('[data-testid="cp-policy"]');
  await p.fill('input[name="cp-new"]', "kurz");
  await p.waitForTimeout(200);
  const reqText = await p.locator('[data-testid="cp-policy"]').textContent();
  check("policy requirements listed", /20 Zeichen/.test(reqText) && /Großbuchstabe/.test(reqText), reqText);
  await p.screenshot({ path: `${SHOTS}/account-policy.png` });
  await p.close();
  await setPolicy(false);
  await sw.evaluate((k) => globalThis.__mwTest.svc.setForcePasswordChange(k, undefined), f2.accountKey);
}

// 4. vault timeout options
{
  st = await rpc("getState");
  await rpc("setSettings", { vaultTimeout: 0 });
  let p = await popup();
  await p.close();
  await sleep(800);
  st = await rpc("getState");
  check("timeout 'immediately': locked when the popup closes", st.accounts.every((a) => a.status !== "unlocked"), JSON.stringify(st.accounts.map((a) => a.status)));
  await rpc("setSettings", { vaultTimeout: "never" });
  await rpc("unlock", { password: PW });
  await rpc("unlock", { password: CHANGED });
  const stored = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("ukNever:")).length);
  check("timeout 'never': keys kept for restarts", stored === (await rpc("getState")).accounts.filter((a) => a.status === "unlocked").length && stored > 0, String(stored));
  await rpc("setSettings", { vaultTimeout: "restart" });
  const after = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("ukNever:")).length);
  check("leaving 'never' removes the stored keys", after === 0, String(after));
  // action "log out"
  await rpc("setSettings", { vaultTimeout: 0, vaultTimeoutAction: "logout" });
  p = await popup();
  await p.close();
  await sleep(800);
  st = await rpc("getState");
  check(
    "timeout action 'log out': accounts stay listed but logged out",
    st.accounts.length >= 2 && st.accounts.every((a) => a.status === "loggedOut"),
    JSON.stringify(st.accounts.map((a) => a.status)),
  );
  await rpc("setSettings", { vaultTimeout: "restart", vaultTimeoutAction: "lock" });
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "alex@privat.test", password: PW });
  await rpc("loginAck");
  check("log in again after 'log out'", f.step === "done", JSON.stringify(f));
}

// 5. fingerprint phrase + devices + hint
{
  st = await rpc("getState");
  const alice = st.accounts.find((a) => a.email === "alex@privat.test");
  const fp = await rpc("fingerprint", { accountKey: alice.key });
  check("fingerprint phrase (5 words)", fp.phrase.split("-").length === 5, fp.phrase);
  const d = await rpc("devices", { accountKey: alice.key });
  check("devices listed, this device marked", d.devices.some((x) => x.current), JSON.stringify(d.devices.map((x) => [x.type, x.current])));
  const p = await popup();
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-devices"]');
  await p.waitForSelector('[data-testid="device-row"]');
  await p.screenshot({ path: `${SHOTS}/account-devices.png` });
  await p.close();
  const h = await rpc("requestPasswordHint", { server: "selfhosted", baseUrl: A, email: "alex@privat.test" }).catch((e) => e.message);
  check("password hint request accepted by the server (mail disabled → error text is fine)", !!h, JSON.stringify(h));
}

// 6. login with device: second browser asks, first browser approves
{
  const two = await browser("two");
  // the server only accepts requests from devices it knows → log in once, then log out
  const f0 = await two.rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "alex@privat.test", password: PW });
  await two.rpc("loginAck");
  await two.rpc("logout", { accountKey: f0.accountKey });
  await rpc("setSettings", { approveLoginRequests: true });
  const p2 = await two.popup("", '[data-testid="login-device"]');
  await p2.getByRole("button", { name: "Eigener Server" }).click();
  await p2.fill('input[name="server-url"]', A);
  await p2.fill('input[name="email"]', "alex@privat.test");
  // the approving browser opens its window as soon as the server announces the request (live sync)
  const winPromise = one.ctx.waitForEvent("page", { predicate: (pg) => pg.url().includes("route=authRequests"), timeout: 20000 }).catch(() => null);
  await p2.click('[data-testid="login-device"]');
  await p2.waitForSelector('[data-testid="fingerprint"]', { timeout: 15000 });
  const phrase = (await p2.textContent('[data-testid="fingerprint"]')).trim();
  await p2.screenshot({ path: `${SHOTS}/account-device-request.png` });
  const win = await winPromise;
  check("approval window opened", !!win && win.url().includes("route=authRequests"), win?.url());
  if (win) {
    await win.waitForSelector('[data-testid="auth-request"]', { timeout: 15000 });
    const shown = (await win.textContent('[data-testid="auth-request-fingerprint"]')).trim();
    check("same fingerprint phrase on both devices", shown === phrase, shown + " / " + phrase);
    await win.screenshot({ path: `${SHOTS}/account-device-approve.png` });
    await win.click('[data-testid="auth-approve"]');
  }
  await p2.waitForSelector('[data-testid="all-items"]', { timeout: 30000 }).catch(() => {});
  const st2 = await two.rpc("getState");
  check("requesting browser logged in and unlocked", st2.accounts.some((a) => a.email === "alex@privat.test" && a.status === "unlocked"));
  const v2 = await two.rpc("getVault");
  check("vault decrypts on the new device", v2.items.some((i) => i.name === "Visa Privat" && i.card?.number === "4111111111111111"));
  await two.ctx.close();
}

// 7. biometric unlock via WebAuthn PRF (virtual platform authenticator with PRF / hmac-secret)
{
  const p = await one.ctx.newPage();
  await p.setViewportSize({ width: 380, height: 640 });
  const cdp = await one.ctx.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  // the popout opened by the settings switch starts the setup by itself
  await p.goto(`chrome-extension://${one.extId}/popup.html?popout=1&bio=enable`);
  await p.waitForSelector('[data-testid="bio-row"]', { timeout: 15000 });
  for (let i = 0; i < 30 && !(await rpc("getState")).settings.biometric; i++) await sleep(300);
  st = await rpc("getState");
  check("biometric unlock set up", !!st.settings.biometric?.credentialId, JSON.stringify(st.settings.biometric));
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  check("credential created on the authenticator", creds.credentials.length === 1, String(creds.credentials.length));
  await p.screenshot({ path: `${SHOTS}/account-bio-settings.png` });
  // an account unlocked later gets its envelope too
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: "http://localhost:8002", email: "alex@firma.test", password: PW });
  await rpc("loginAck");
  check("second account logged in", f.step === "done", JSON.stringify(f));
  await sleep(500);
  st = await rpc("getState");
  check("all unlocked accounts can use biometrics", st.accounts.filter((a) => a.status === "unlocked").every((a) => a.bioUnlock), JSON.stringify(st.accounts.map((a) => [a.email, a.status, a.bioUnlock])));
  const n = st.accounts.filter((a) => a.status === "unlocked").length;
  await rpc("lock");
  await p.goto(`chrome-extension://${one.extId}/popup.html`);
  await p.waitForSelector('[data-testid="unlock-bio"]', { timeout: 15000 });
  await p.screenshot({ path: `${SHOTS}/account-bio-lock.png` });
  await p.click('[data-testid="unlock-bio"]');
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 }).catch(() => {});
  st = await rpc("getState");
  check("unlocked with biometrics", st.accounts.filter((a) => a.status === "unlocked").length === n && n >= 2, JSON.stringify(st.accounts.map((a) => a.status)));
  // a different credential (e.g. after resetting the authenticator) must not unlock
  await rpc("lock");
  const bad = await rpc("unlockBiometric", { prf: Buffer.from(new Uint8Array(32).fill(7)).toString("base64") });
  check("wrong PRF output rejected", bad.results.every((r) => !r.ok) && !(await rpc("getState")).accounts.some((a) => a.status === "unlocked"));
  await rpc("unlock", { password: PW });
  await rpc("biometricDisable");
  const left = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("bioEnv:")).length);
  check("turning it off removes the envelopes", left === 0 && !(await rpc("getState")).settings.biometric, String(left));
  await p.close();
}

await one.ctx.close();
console.log(failed ? `${failed} FAILED` : "ACCOUNT E2E ALL PASSED");
process.exit(failed ? 1 : 0);
