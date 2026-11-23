// Browser test against Vaultwarden (server A, see tests/reset-servers.sh) and the test site (:9000):
// after filling an entry that is stored for another address, the save/update bar belongs to that entry
// (not to the other logins of the page with the same username), and "Ausfüllen und speichern" in the
// popup fills and adds the page's address to the entry.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? TMP + "/shots";
const PW = "Test-Passwort-123!";
const SITE = "http://localhost:9000";
mkdirSync(SHOTS, { recursive: true });
const profile = TMP + "/profile-fill-save";
rmSync(profile, { recursive: true, force: true });

let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(200);
  }
  return undefined;
};

const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  locale: "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
  viewport: { width: 1100, height: 760 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/inline-menu.html#rpc`);
const rpcRaw = (name, args = {}) => ext.evaluate(([n, a]) => chrome.runtime.sendMessage({ rpc: n, args: a }), [name, args]);
const rpc = async (name, args = {}) => {
  const r = await rpcRaw(name, args);
  if (!r?.ok) throw new Error(name + ": " + r?.error);
  return r.data;
};
const f = await rpc("loginStart", { server: "selfhosted", baseUrl: "http://localhost:8001", email: "alex@privat.test", password: PW });
check("login", f.step === "done", JSON.stringify(f));
await rpc("loginAck");
await rpc("setSettings", { language: "de", theme: "light", promptSave: true, promptUpdate: true });
const A = (await rpc("getState")).accounts[0].key;

const USER = "dev@geraet.test";
const newLogin = async (name, password, uri) => {
  const r = await rpcRaw("saveItem", {
    accountKey: A,
    isNew: true,
    item: {
      id: "",
      accountKey: A,
      type: 1,
      name,
      favorite: false,
      reprompt: 0,
      edit: true,
      viewPassword: true,
      collectionIds: [],
      fields: [],
      notes: "",
      folderId: null,
      organizationId: null,
      login: { username: USER, password, totp: "", uris: [{ uri, match: null }], passkeys: 0 },
    },
  });
  if (!r?.ok) throw new Error("saveItem " + name + ": " + r?.error);
};
// the right entry is stored for another address; three stale ones match the page with the same username
await newLogin("Geraet richtig", "Richtig-1", "http://device.example.test");
for (const n of [1, 2, 3]) await newLogin("Geraet alt " + n, "Alt-" + n, SITE);
const itemNamed = async (name) => (await rpc("getVault")).items.find((i) => i.name === name && !i.deletedDate);
const right = await itemNamed("Geraet richtig");

const notifyFrame = (site, ms = 8000) => waitFor(async () => site.frames().find((fr) => fr.url().includes("/notification.html")), ms);
async function openSite() {
  const p = await ctx.newPage();
  await p.goto(`${SITE}/login.html`);
  await p.waitForTimeout(500);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0]?.id, `${SITE}/login.html`);
  return { p, tabId };
}
async function submit(p) {
  await p.waitForTimeout(800);
  await p.mouse.click(5, 5);
  await p.click("button[type=submit]");
}

// 1. fill the right entry (explicit choice), log in unchanged: no bar at all (before: "update" for the 3 stale ones)
{
  const { p, tabId } = await openSite();
  const r = await rpcRaw("autofill", { accountKey: A, itemId: right.id, tabId, force: true });
  check("forced fill ok", r?.ok && r.data.ok, JSON.stringify(r));
  check("password filled", (await p.inputValue("#p")) === "Richtig-1");
  await submit(p);
  check("no save/update bar after filling and logging in", !(await notifyFrame(p, 6000)));
  await p.close();
}

// 2. fill the right entry, then type a new password: the bar offers only that entry
{
  const { p, tabId } = await openSite();
  await rpcRaw("autofill", { accountKey: A, itemId: right.id, tabId, force: true });
  await p.fill("#p", "Neu-2");
  await submit(p);
  const fr = await notifyFrame(p, 10000);
  check("update bar shown", !!fr);
  if (fr) {
    await fr.waitForSelector('[data-testid="notify-update"]', { timeout: 10000 });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${SHOTS}/fill-save-update-bar.png` });
    const body = (await fr.textContent("body")) ?? "";
    check("bar names the filled entry", body.includes("Geraet richtig"), body);
    check("bar names none of the stale entries", !body.includes("Geraet alt"), body);
    await fr.click('[data-testid="notify-update"]');
    const pw = await waitFor(async () => ((await itemNamed("Geraet richtig"))?.login.password === "Neu-2" ? true : undefined), 10000);
    check("filled entry updated", !!pw);
    const stale = await itemNamed("Geraet alt 1");
    check("stale entry untouched", stale?.login.password === "Alt-1");
  }
  await p.close();
}

// 3. "Ausfüllen und speichern" in the popup (opened as its own window, so the site stays the active tab)
{
  const { p } = await openSite();
  const popupPromise = ctx.waitForEvent("page");
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 400, height: 640 }), `chrome-extension://${extId}/popup.html`);
  const pop = await popupPromise;
  await pop.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await pop.waitForTimeout(500);
  const row = pop.locator('[data-testid="item-row"][data-name="Geraet richtig"]');
  await row.locator('button[aria-label="Weitere Optionen"]').click();
  const entry = pop.locator('[data-testid="menu-fill-save"]');
  check("menu offers Ausfüllen und speichern", (await entry.count()) === 1);
  // a matching entry does not offer it
  if ((await entry.count()) === 1) {
    await entry.click();
    const msg = (await pop.textContent('[role="dialog"]')) ?? "";
    check("confirmation names the address", msg.includes(SITE), msg);
    await pop.screenshot({ path: `${SHOTS}/fill-save-confirm.png` });
    await pop.click('[data-testid="confirm-ok"]');
    const uris = await waitFor(async () => {
      const it = await itemNamed("Geraet richtig");
      return it?.login.uris.length === 2 ? it.login.uris.map((u) => u.uri) : undefined;
    }, 10000);
    check("page address added to the entry", JSON.stringify(uris) === JSON.stringify(["http://device.example.test", SITE]), JSON.stringify(uris));
    check("filled after saving", (await p.inputValue("#p")) === "Neu-2");
    const m = await rpc("getPageMatches", { url: `${SITE}/login.html` });
    check("entry now suggested for the page", m.itemIds.includes(`${A}::${right.id}`), JSON.stringify(m));
  }
  if (!pop.isClosed()) await pop.close();
  await p.close();
}

await ctx.close();
console.log(failed ? `E2E ${failed} FAILED` : "E2E ALL PASSED");
process.exit(failed ? 1 : 0);
