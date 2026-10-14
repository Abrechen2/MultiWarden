// Browser test of the 1.1 features with the real extension (Chromium, Playwright):
// security-key 2FA (virtual authenticator), attachments, PIN, save-login bar, passkeys, SSO.
// Needs: tests/reset-servers.sh, tests/serve.mjs (:9000), a key registered by tests/webauthn-setup.ts.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? SP + "/shots";
const PW = "Test-Passwort-123!";
const theme = process.env.THEME ?? "light";
const cred = JSON.parse(readFileSync(SP + "/webauthn-cred.json", "utf8"));
mkdirSync(SHOTS, { recursive: true });
const profile = SP + "/profile5";
rmSync(profile, { recursive: true, force: true });

let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  colorScheme: theme,
  acceptDownloads: true,
  locale: "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
  viewport: { width: 1100, height: 760 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const shot = (p, name) => p.screenshot({ path: `${SHOTS}/${theme}-${name}.png` }).catch(() => {});

const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/popup.html`);
const rpc = async (name, args = {}) => {
  const r = await ext.evaluate(([n, a]) => chrome.runtime.sendMessage({ rpc: n, args: a }), [name, args]);
  if (!r?.ok) throw new Error(name + ": " + r?.error);
  return r.data;
};

async function waitFor(fn, timeout = 20000, step = 250) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(step);
  }
}
const findPage = (pred) => waitFor(async () => ctx.pages().find((p) => pred(p.url())));

async function openPopup(query = "") {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html${query}`);
  await p.waitForTimeout(500);
  return p;
}

// --------------------------------------------------------------------------------------------
// 1. login with security key (WebAuthn 2FA) through the UI
{
  // virtual authenticator holding the registered key, attached to the ceremony tab as soon as it opens
  let ceremony = null;
  ctx.on("page", async (p) => {
    for (let i = 0; i < 40 && !p.url().includes("#mw-security-key"); i++) await sleep(50);
    if (!p.url().includes("#mw-security-key")) return;
    ceremony = p;
    try {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send("WebAuthn.enable", { enableUI: false });
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "usb",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: cred.credentialId,
          isResidentCredential: false,
          rpId: cred.rpId,
          privateKey: cred.privateKey,
          signCount: 1,
        },
      });
      await sleep(600);
      await shot(p, "f01-security-key-tab");
      // if the automatic first attempt was too early: "Jetzt bestätigen" (keyboard reaches the closed shadow root)
      await p.keyboard.press("Tab").catch(() => {});
      await p.keyboard.press("Enter").catch(() => {});
    } catch {
      /* tab already closed after success */
    }
  });
  const pop = await openPopup();
  await pop.getByRole("button", { name: "Eigener Server" }).click();
  await pop.fill('input[name="server-url"]', "http://localhost:8002");
  await pop.fill('input[name="email"]', "alex@firma.test");
  await pop.fill('input[name="master-password"]', PW);
  await pop.click('[data-testid="login-submit"]');
  await pop.waitForSelector('[data-testid="flow-twofactor"]', { timeout: 30000 });
  await shot(pop, "f02-twofactor-security-key");
  check("2FA step offers security key", (await pop.locator('[data-testid="twofactor-external"]').count()) === 1);
  await pop.click('[data-testid="twofactor-external"]');
  const st = await waitFor(async () => {
    const s = await rpc("getState");
    return s.accounts.length === 1 && s.accounts[0].status === "unlocked" ? s : undefined;
  }, 40000);
  check("login with security key", !!st, JSON.stringify(await rpc("loginGet")));
  check("ceremony ran on vault origin", !!ceremony && ceremony.url().startsWith("http://localhost:8002/"));
  const lw = ctx.pages().find((p) => p.url().includes("popup.html?popout=1"));
  if (lw) await lw.close();
  await pop.close();
}

// account A via RPC
{
  const r = await rpc("loginStart", { server: "selfhosted", baseUrl: "http://localhost:8001", email: "alex@privat.test", password: PW });
  check("login A", r.step === "done", JSON.stringify(r));
  await rpc("loginAck");
}
const state = await rpc("getState");
const keyOf = (email) => state.accounts.find((a) => a.email === email).key;
const A = keyOf("alex@privat.test");
const B = keyOf("alex@firma.test");

// --------------------------------------------------------------------------------------------
// 2. attachment download
{
  const pop = await openPopup();
  await pop.fill('[data-testid="search"]', "Server-Notizen");
  await pop.waitForTimeout(300);
  await pop.locator('[data-testid="item-row"][data-name="Server-Notizen"]').first().click();
  await pop.waitForSelector('[data-testid="attachment"]');
  await pop.waitForTimeout(300);
  await shot(pop, "f03-attachment");
  const [dl] = await Promise.all([pop.waitForEvent("download", { timeout: 15000 }), pop.click('[data-testid="attachment-download"]')]);
  const file = SP + "/dl-" + dl.suggestedFilename();
  await dl.saveAs(file);
  const text = readFileSync(file, "utf8");
  check("attachment downloaded + decrypted", dl.suggestedFilename() === "backup-plan.txt" && text.includes("NAS → Cloud"), text);
  await pop.close();
}

// --------------------------------------------------------------------------------------------
// 3. PIN unlock
{
  const pop = await openPopup();
  await pop.getByRole("button", { name: "Einstellungen" }).click();
  await pop.locator('[data-testid="pin-row"] label.switch').click();
  await pop.fill('input[name="new-pin"]', "4711");
  await pop.fill('input[name="new-pin-2"]', "4711");
  await shot(pop, "f04-pin-setup");
  await pop.click('[data-testid="pin-save"]');
  await pop.waitForTimeout(800);
  const s = await rpc("getState");
  check(
    "PIN enabled for both accounts",
    s.settings.pinEnabled && s.accounts.every((a) => a.pinUnlock),
    JSON.stringify(s.accounts.map((a) => a.pinUnlock)),
  );
  await rpc("lock", {});
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('input[name="pin"]', { timeout: 10000 });
  await shot(pop, "f05-lock-pin");
  await pop.fill('input[name="pin"]', "4711");
  await pop.keyboard.press("Enter");
  await pop.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  check(
    "unlocked with PIN",
    (await rpc("getState")).accounts.every((a) => a.status === "unlocked"),
  );
  await pop.close();
}

/** The inline menu of a focused field can cover buttons below it: click into an empty spot first, like a user would. */
async function leaveField(page) {
  await page.waitForTimeout(800);
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => !document.querySelector("mw-inline-menu"), null, { timeout: 5000 }).catch(() => {});
}

// --------------------------------------------------------------------------------------------
// 4. "Login speichern?" / "Passwort aktualisieren?"
async function submitSignup(site, email, pw, viaEnter = false) {
  await site.goto("http://localhost:9000/signup.html");
  await site.fill("#email", email);
  await site.fill("#pw", pw);
  if (viaEnter) await site.press("#pw", "Enter");
  else {
    await leaveField(site);
    await site.click("button[type=submit]");
  }
  await site.waitForURL("**/welcome.html");
}
const notifyFrame = (site) => waitFor(async () => site.frames().find((f) => f.url().includes("/notification.html")), 10000);
{
  const site = await ctx.newPage();
  await submitSignup(site, "neu@shop.test", "Shop-Passwort-1");
  let fr = await notifyFrame(site);
  check("save bar shown after login", !!fr);
  await fr.waitForSelector('[data-testid="notify-save"]');
  await site.waitForTimeout(400);
  await shot(site, "f06-save-login-bar");
  await fr.selectOption('[data-testid="notify-account"]', B);
  await fr.click('[data-testid="notify-save"]');
  await fr.waitForSelector("text=Login gespeichert", { timeout: 10000 });
  let v = await rpc("getVault");
  const saved = v.items.find((i) => i.login?.username === "neu@shop.test");
  check(
    "login saved in chosen account",
    saved?.accountKey === B && saved.login.password === "Shop-Passwort-1" && saved.name === "localhost",
    JSON.stringify(saved),
  );

  await submitSignup(site, "neu@shop.test", "Shop-Passwort-2", true);
  fr = await notifyFrame(site);
  await fr?.waitForSelector('[data-testid="notify-update"]', { timeout: 10000 });
  await site.waitForTimeout(400);
  await shot(site, "f07-update-password-bar");
  await fr.click('[data-testid="notify-update"]');
  await fr.waitForSelector("text=Passwort aktualisiert", { timeout: 10000 });
  v = await rpc("getVault");
  const upd = v.items.find((i) => i.login?.username === "neu@shop.test");
  check(
    "password updated",
    upd?.login.password === "Shop-Passwort-2" && upd.passwordHistory[0]?.password === "Shop-Passwort-1",
    JSON.stringify(upd?.login),
  );

  await submitSignup(site, "neu@shop.test", "Shop-Passwort-2", true);
  await site.waitForTimeout(4000);
  check("no bar for known login", !site.frames().some((f) => f.url().includes("/notification.html")));
  await site.close();
}

// --------------------------------------------------------------------------------------------
// 5. passkeys
{
  const rp = await ctx.newPage();
  await rp.goto("http://localhost:9000/passkey.html");
  await rp.fill("#user", "alex");
  await leaveField(rp);
  await rp.click("#register");
  let dlg = await findPage((u) => u.includes("/fido2.html"));
  check("passkey dialog opens (create)", !!dlg);
  await dlg.waitForSelector('[data-testid="fido2-save"]');
  await dlg.setViewportSize({ width: 440, height: 600 }).catch(() => {});
  await dlg.fill('input[name="master-password"]', PW);
  await shot(dlg, "f08-passkey-save");
  await dlg.click('[data-testid="fido2-save"]');
  await rp.waitForSelector('#status[data-state="registered"]', { timeout: 15000 }).catch(() => {});
  check("passkey registered at RP", (await rp.getAttribute("#status", "data-state")) === "registered", await rp.textContent("#status"));
  const v = await rpc("getVault");
  const pkItem = v.items.find((i) => i.login?.fido2?.[0]?.rpId === "localhost");
  check(
    "passkey stored in vault",
    !!pkItem && pkItem.login.fido2[0].userName === "alex" && pkItem.login.fido2[0].discoverable,
    JSON.stringify(pkItem?.login),
  );

  await rp.click("#login");
  dlg = await findPage((u) => u.includes("/fido2.html"));
  await dlg.waitForSelector('[data-testid="fido2-candidate"]');
  await dlg.fill('input[name="master-password"]', PW);
  await shot(dlg, "f09-passkey-signin");
  await dlg.click('[data-testid="fido2-signin"]');
  await rp.waitForSelector('#status[data-state="loggedin"]', { timeout: 15000 }).catch(() => {});
  const t1 = await rp.textContent("#status");
  check("signed in with passkey (signature valid, UV)", /Signatur gültig, UV=true/.test(t1) && t1.includes("demo-alex"), t1);
  await rp.screenshot({ path: `${SHOTS}/${theme}-f10-passkey-rp.png` });

  // conditional mediation: passkey offered in the inline menu
  await rp.reload();
  await rp.click("#conditional");
  await rp.waitForTimeout(300);
  await rp.click("#user");
  const menu = await waitFor(async () => rp.frames().find((f) => f.url().includes("/inline-menu.html")), 10000);
  check("inline menu for passkey field", !!menu);
  await menu?.waitForSelector('[data-testid="inline-passkey"]', { timeout: 10000 });
  await rp.waitForTimeout(300);
  await shot(rp, "f11-passkey-inline-menu");
  await menu.click('[data-testid="inline-passkey"]');
  await rp.waitForSelector('#status[data-state="loggedin"]', { timeout: 15000 }).catch(() => {});
  const t2 = await rp.textContent("#status");
  check("autofill passkey sign-in", /Autofill.*Signatur gültig, UV=false/.test(t2), t2);

  // item detail shows the passkey
  const pop = await openPopup();
  await pop.fill('[data-testid="search"]', "Passkey-Demo");
  await pop.waitForTimeout(300);
  await pop.locator('[data-testid="item-row"]').first().click();
  await pop.waitForSelector('[data-testid="detail-passkey"]');
  await shot(pop, "f12-item-with-passkey");
  check("item detail shows passkey", (await pop.textContent('[data-testid="detail-passkey"]')).includes("localhost"));
  await pop.close();
  await rp.close();
}

// --------------------------------------------------------------------------------------------
// 6. SSO (Vaultwarden C + mock identity provider): new user sets a master password
{
  const pop = await openPopup();
  await pop.click('[data-testid="accounts-menu"]');
  await pop.getByRole("menuitem", { name: "Konto hinzufügen" }).click();
  await pop.click('[data-testid="toggle-sso"]');
  await pop.getByRole("button", { name: "Eigener Server" }).click();
  await pop.fill('input[name="server-url"]', "http://localhost:8003");
  await pop.fill('input[name="email"]', "ui@sso.test");
  await shot(pop, "f13-sso-start");
  await pop.click('[data-testid="sso-submit"]');
  const idp = await findPage((u) => u.startsWith("http://localhost:9100/authorize"));
  check("identity provider opened", !!idp);
  await idp.fill("#idp-email", "ui@sso.test");
  await shot(idp, "f14-sso-idp");
  await idp.click("#idp-login");
  const lw = await findPage((u) => u.includes("popup.html?popout=1"));
  check("login window opened", !!lw);
  await lw.waitForSelector('[data-testid="flow-set-password"]', { timeout: 20000 });
  await lw.setViewportSize({ width: 420, height: 680 }).catch(() => {});
  await lw.fill('input[name="new-master-password"]', "SSO-Master-Passwort-1");
  await lw.fill('input[name="new-master-password-2"]', "SSO-Master-Passwort-1");
  await shot(lw, "f15-sso-set-password");
  await lw.click('[data-testid="set-password-submit"]');
  const s = await waitFor(async () => {
    const st = await rpc("getState");
    return st.accounts.find((a) => a.email === "ui@sso.test" && a.status === "unlocked");
  }, 20000);
  check("SSO account added", !!s && s.sso && s.hasMasterPassword, JSON.stringify(s));
  check("IdP tab closed", !ctx.pages().some((p) => p.url().startsWith("http://localhost:9100") || p.url().includes("sso-connector")));
  await lw.waitForTimeout(800);
  await shot(lw, "f16-sso-done");
  // accounts overview with SSO info
  const acc = await openPopup();
  await acc.click('[data-testid="accounts-menu"]');
  await acc
    .getByRole("menuitem", { name: /Konten verwalten/ })
    .click()
    .catch(() => {});
  await acc.waitForTimeout(500);
  await shot(acc, "f17-accounts");
  await acc.close();
  await pop.close().catch(() => {});
}

// --------------------------------------------------------------------------------------------
// 7. settings screenshot
{
  const pop = await openPopup();
  await pop.getByRole("button", { name: "Einstellungen" }).click();
  await pop.waitForTimeout(300);
  await shot(pop, "f18-settings");
  await pop.locator("main").evaluate((m) => (m.scrollTop = 520));
  await pop.waitForTimeout(200);
  await shot(pop, "f19-settings-autofill");
  await pop.close();
}

await ctx.close();
console.log(failed ? `${failed} FAILED` : "FEATURES E2E ALL PASSED");
process.exit(failed ? 1 : 0);
