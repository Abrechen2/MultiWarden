// Browser test of release 1.2 organization features against Vaultwarden (server A, owner account):
// event logs (ORG_EVENTS_ENABLED), policies password generator / remove PIN / restricted item types,
// and – injected into the service, as Vaultwarden lacks them or exempts owners – data ownership,
// maximum vault timeout and the export policy.
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

const profile = SP + "/profile-org";
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

const f = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "alex@privat.test", password: PW });
await rpc("loginAck");
const key = f.accountKey;
let vault = await rpc("getVault");
for (let i = 0; i < 30 && !vault.items.length; i++) {
  await sleep(200);
  vault = await rpc("getVault");
}
const orgId = vault.organizations.find((o) => o.accountKey === key).id;
const api = (method, p, body) =>
  sw.evaluate(([k, m, pa, b]) => globalThis.__mwTest.svc.api(globalThis.__mwTest.svc.account(k)).send(m, pa, b), [key, method, p, body]);
const setPolicy = (type, enabled, data = null) => api("PUT", `/organizations/${orgId}/policies/${type}`, { policy: { enabled, data } });
const syncNow = async () => {
  await rpc("sync", { accountKey: key });
  await sleep(300);
};

// 1. event logs: viewing / revealing an organization item is logged, personal items are not
{
  const netflix = vault.items.find((i) => i.name === "Netflix");
  const visa = vault.items.find((i) => i.name === "Visa Privat");
  const st = await rpc("getState");
  check("organization uses event logs", true);
  const p = await popup();
  await p.fill('[data-testid="search"]', "Netflix");
  await p.click('[data-testid="item-row"][data-name="Netflix"]');
  await p.waitForSelector('[data-testid="detail-name"]');
  await p.locator('[aria-label="Anzeigen"]').first().click();
  await p.waitForTimeout(300);
  await p.click('[aria-label="Zurück"]');
  await p.fill('[data-testid="search"]', "Visa");
  await p.click('[data-testid="item-row"][data-name="Visa Privat"]');
  await p.waitForSelector('[data-testid="detail-name"]');
  await p.waitForTimeout(300);
  await p.close();
  const q = (await rpc("pendingEvents")).events[key] ?? [];
  check("viewed event queued", q.some((e) => e.type === 1107 && e.cipherId === netflix.id && e.organizationId === orgId), JSON.stringify(q));
  check("password reveal event queued", q.some((e) => e.type === 1108 && e.cipherId === netflix.id), JSON.stringify(q));
  check("personal item not logged", !q.some((e) => e.cipherId === visa.id));
  await sw.evaluate(() => globalThis.__mwTest.svc.events.upload());
  const left = (await rpc("pendingEvents")).events[key] ?? [];
  check("events uploaded", left.length === 0, JSON.stringify(left));
  const start = new Date(Date.now() - 3600_000).toISOString();
  const end = new Date(Date.now() + 3600_000).toISOString();
  const ev = await api("GET", `/organizations/${orgId}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  const list = ev.data ?? [];
  check(
    "server recorded the client events",
    list.some((e) => e.type === 1107 && e.cipherId === netflix.id) && list.some((e) => e.type === 1108 && e.cipherId === netflix.id),
    JSON.stringify(list.map((e) => [e.type, e.cipherId])),
  );
}

// 2. password generator policy: passphrase with at least 6 capitalized words
{
  await setPolicy(2, true, {
    overridePasswordType: "passphrase",
    minLength: 0,
    useUpper: false,
    useLower: false,
    useNumbers: false,
    minNumbers: 0,
    useSpecial: false,
    minSpecial: 0,
    minNumberWords: 6,
    capitalize: true,
    includeNumber: true,
  });
  await syncNow();
  const gp = await sw.evaluate(async () => (await chrome.storage.local.get("generatorPolicy")).generatorPolicy);
  check("generator policy stored", gp?.overrideType === "passphrase" && gp.minNumberWords === 6, JSON.stringify(gp));
  const p = await popup();
  await p.getByRole("button", { name: "Generator" }).click();
  await p.waitForSelector('[data-testid="gen-policy"]');
  let value = "";
  for (let i = 0; i < 20 && !value; i++) {
    value = ((await p.textContent('[data-testid="generated"] .v')) ?? "").trim();
    if (!value) await p.waitForTimeout(150);
  }
  const words = value.split("-");
  check("passphrase forced", words.length >= 6 && words.every((w) => /^[A-ZÄÖÜ]/.test(w)) && /\d/.test(value), value);
  check("password type disabled", await p.locator('[data-testid="gen-mode-password"]').isDisabled());
  await p.screenshot({ path: `${SHOTS}/org-generator-policy.png` });
  await p.close();
  await setPolicy(2, false, null);
  await syncNow();
  const gp2 = await sw.evaluate(async () => (await chrome.storage.local.get("generatorPolicy")).generatorPolicy);
  check("generator policy removed", !gp2);
}

// 3. remove unlock with PIN
{
  await rpc("setPin", { pin: "4711", lockAfterRestart: false });
  await sleep(300);
  let st = await rpc("getState");
  check("PIN set up", st.accounts.find((a) => a.key === key)?.pinUnlock === true);
  await setPolicy(14, true, null);
  await syncNow();
  st = await rpc("getState");
  check("policy removes PIN unlock", st.accounts.find((a) => a.key === key)?.pinUnlock === false && !!st.accounts.find((a) => a.key === key)?.policies?.removePin);
  const p = await popup();
  await p.getByRole("button", { name: "Einstellungen" }).click();
  const desc = await p.locator('[data-testid="pin-row"]').textContent();
  check("settings explain the policy", /Richtlinie/.test(desc), desc);
  await p.close();
  await setPolicy(14, false, null);
  await syncNow();
  await rpc("disablePin");
}

// 4. restricted item types: cards hidden and not creatable
{
  await setPolicy(15, true, null);
  await syncNow();
  let v = await rpc("getVault");
  check("cards hidden", !v.items.some((i) => i.type === 3), v.items.filter((i) => i.type === 3).map((i) => i.name).join());
  const p = await popup();
  await p.click('[data-testid="add"]');
  await p.waitForTimeout(300);
  const menu = await p.locator(".popover").textContent().catch(() => "");
  check("card type not offered", !!menu && !/Karte/.test(menu) && /Login/.test(menu), menu);
  await p.close();
  await setPolicy(15, false, null);
  await syncNow();
  v = await rpc("getVault");
  check("cards back without the policy", v.items.some((i) => i.name === "Visa Privat"));
}

// 5. policies Vaultwarden does not offer / exempts owners from (injected)
{
  await rpc("setSettings", { vaultTimeout: "never" });
  await sw.evaluate(
    async ([k, o]) => {
      const svc = globalThis.__mwTest.svc;
      svc.account(k).policies = {
        dataOwnership: { orgIds: [o] },
        maxTimeout: { type: "custom", minutes: 15, action: "logOut", orgName: "Familie Beispiel" },
        disableExport: true,
      };
      await svc.applyPolicies();
    },
    [key, orgId],
  );
  const st = await rpc("getState");
  check("timeout clamped to the policy", st.settings.vaultTimeout === 15, JSON.stringify(st.settings.vaultTimeout));
  await rpc("setSettings", { vaultTimeout: 240 });
  check("longer timeout refused", (await rpc("getState")).settings.vaultTimeout === 15);
  let p = await popup();
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.waitForSelector('[data-testid="timeout-policy"]');
  check("'never' not selectable", await p.locator('[data-testid="vault-timeout"] option[value="never"]').isDisabled());
  await p.screenshot({ path: `${SHOTS}/org-timeout-policy.png` });
  await p.close();
  // new item: personal vault not allowed
  p = await popup("?popout=1&add=1", '[data-testid="edit-owner"]');
  await p.waitForTimeout(300);
  check("owner defaults to the organization", (await p.locator('[data-testid="edit-owner"]').inputValue()) === orgId);
  const opts = await p.$$eval('[data-testid="edit-owner"] option', (os) => os.map((o) => [o.value, o.disabled, o.textContent]));
  check("personal vault disabled", opts.some(([v, d]) => v === "" && d), JSON.stringify(opts));
  await p.screenshot({ path: `${SHOTS}/org-ownership-policy.png` });
  await p.close();
  // export blocked
  p = await popup();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]');
  await p.evaluate(() => {});
  const r = await rpc("exportVault", { accountKey: key, format: "json", mode: "mp", secret: PW }).then(
    () => "ok",
    (e) => e.message,
  );
  check("export refused by policy", r !== "ok" && /Richtlinie|policy/.test(r), r);
  await p.close();
  // timeout action of the policy: log out instead of lock
  await sw.evaluate(() => globalThis.__mwTest.svc.timeoutAction());
  const st2 = await rpc("getState");
  check("policy action 'log out' applied", st2.accounts.find((a) => a.key === key)?.status === "loggedOut", JSON.stringify(st2.accounts.map((a) => a.status)));
}

await ctx.close();
console.log(failed ? `${failed} FAILED` : "ORG E2E ALL PASSED");
process.exit(failed ? 1 : 0);
