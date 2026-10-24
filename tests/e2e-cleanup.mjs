// Browser test of the cleanup assistant against Vaultwarden (servers A and B, see tests/reset-servers.sh)
// and the test site (tests/serve.mjs on :9000): login outcomes learned on real login forms, the question
// for conflicting entries, evidence and "Bereinigen" in the duplicate check across accounts, the
// "Aufräumen" tab, and moving an organization item into the own personal vault.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? TMP + "/shots";
const PW = "Test-Passwort-123!";
const SITE = "http://localhost:9000";
mkdirSync(SHOTS, { recursive: true });
const profile = TMP + "/profile-cleanup";
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
for (const [base, email] of [
  ["http://localhost:8001", "alex@privat.test"],
  ["http://localhost:8002", "alex@firma.test"],
]) {
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: base, email, password: PW });
  check("login " + email, f.step === "done", JSON.stringify(f));
  await rpc("loginAck");
}
await rpc("setSettings", { language: "de", theme: "light" });
const accounts = (await rpc("getState")).accounts;
const A = accounts.find((a) => a.email === "alex@privat.test").key;
const B = accounts.find((a) => a.email === "alex@firma.test").key;
await waitFor(async () => (await rpc("getVault")).items.length > 3);

const newLogin = async (accountKey, name, username, password, uris) => {
  const r = await rpcRaw("saveItem", {
    accountKey,
    isNew: true,
    item: {
      id: "",
      accountKey,
      type: 1,
      name,
      favorite: false,
      reprompt: 0,
      edit: true,
      viewPassword: true,
      collectionIds: [],
      fields: [],
      passwordHistory: [],
      attachments: [],
      login: { username, password, uris: uris.map((uri) => ({ uri, match: null })), passkeys: 0 },
    },
  });
  if (!r?.ok) throw new Error("saveItem " + name + ": " + r?.error);
};
const itemNamed = async (name) => (await rpc("getVault")).items.find((i) => i.name === name && !i.deletedDate);
const evidence = () => rpc("usageEvidence");

async function popup() {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 640 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
async function leaveField(page) {
  await page.waitForTimeout(800);
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => !document.querySelector("mw-inline-menu"), null, { timeout: 5000 }).catch(() => {});
}
async function submitLogin(site, page, email, pw) {
  await site.goto(`${SITE}/${page}`);
  await site.fill("#email", email);
  await site.fill("#pw", pw);
  await leaveField(site);
  await site.click("button[type=submit]");
}
const notifyFrame = (site, ms = 8000) => waitFor(async () => site.frames().find((f) => f.url().includes("/notification.html")), ms);

// ------------------------------------------------------------------------------ login outcomes
// the same login three times with different passwords, in both accounts
const USER = "out@shop.test";
await newLogin(A, "Shop A", USER, "Richtig-1", [SITE + "/"]);
await newLogin(B, "Shop B", USER, "Falsch-2", [SITE + "/"]);
await newLogin(A, "Shop C", USER, "Dritt-3", [SITE + "/"]);
const itemA = await itemNamed("Shop A");
const itemB = await itemNamed("Shop B");
const itemC = await itemNamed("Shop C");
check("three conflicting logins created", !!itemA && !!itemB && !!itemC);
{
  const site = await ctx.newPage();
  // B's password: the login page comes back with its password field → failure (after the re-check)
  await site.goto(`${SITE}/login.html`);
  await site.fill("#u", USER);
  await site.fill("#p", "Falsch-2");
  await leaveField(site);
  await site.click("button[type=submit]");
  const failRec = await waitFor(async () => (await evidence()).outcomes[B]?.[itemB.id], 15000);
  check("failed login recorded for B", failRec?.ok === false, JSON.stringify(failRec));
  check("no question after a clear failure", !(await notifyFrame(site, 1500)));

  // A's password: the shop navigates to its welcome page → success, silently
  await sleep(1100);
  await submitLogin(site, "signup.html", USER, "Richtig-1");
  await site.waitForURL("**/welcome.html");
  const okRec = await waitFor(async () => (await evidence()).outcomes[A]?.[itemA.id], 15000);
  check("successful login recorded for A", okRec?.ok === true, JSON.stringify(okRec));
  check("no question after a clear success", !(await notifyFrame(site, 2500)));

  // C's password on a page whose result cannot be told (it still asks for the e-mail) → the question
  await sleep(1100);
  await submitLogin(site, "relogin.html", USER, "Dritt-3");
  await site.waitForURL("**/step1.html");
  const fr = await notifyFrame(site, 15000);
  check("question shown for an unclear login of a conflicting entry", !!fr);
  if (fr) {
    await fr.waitForSelector('[data-testid="notify-outcome-yes"]', { timeout: 10000 });
    await site.waitForTimeout(400);
    await site.screenshot({ path: `${SHOTS}/cleanup-outcome-question.png` });
    check("question names the entry", ((await fr.textContent("body")) ?? "").includes("Shop C"));
    await fr.click('[data-testid="notify-outcome-yes"]');
  }
  const cRec = await waitFor(async () => (await evidence()).outcomes[A]?.[itemC.id], 10000);
  check("answer recorded for C", cRec?.ok === true, JSON.stringify(cRec));

  // asked once: the same unclear login again brings no question
  await sleep(1100);
  await submitLogin(site, "relogin.html", USER, "Dritt-3");
  await site.waitForURL("**/step1.html");
  check("not asked a second time", !(await notifyFrame(site, 6000)));

  // a normal login without a conflicting entry never asks
  await newLogin(A, "Einzeln", "solo@shop.test", "Solo-1", [SITE + "/"]);
  await sleep(1100);
  await submitLogin(site, "relogin.html", "solo@shop.test", "Solo-1");
  await site.waitForURL("**/step1.html");
  check("no question for an entry without duplicates", !(await notifyFrame(site, 6000)));
  const ev = await evidence();
  const json = JSON.stringify(ev) + JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null)));
  check("no password stored for the outcomes", !["Richtig-1", "Falsch-2", "Dritt-3", "Solo-1"].some((p) => json.includes(p)));
  await site.close();
}

// ------------------------------------------------------------------------------ duplicate check
{
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-duplicates"]');
  check("all accounts by default", (await p.inputValue('[data-testid="tool-account"]')) === "*");
  await p.waitForTimeout(1000);
  const group = p.locator('[data-testid="dup-group"]', { hasText: "Shop A" });
  check("group spans both accounts", (await group.locator('[data-testid="dup-item"]').count()) === 3);
  const row = (name) => group.locator(`[data-testid="dup-item"][data-name="${name}"]`);
  check("C (newest success) recommended", ((await row("Shop C").textContent()) ?? "").includes("vermutlich aktuell"));
  check("A shows its success", ((await row("Shop A").textContent()) ?? "").includes("Anmeldung erfolgreich"));
  check("B shows its failure", ((await row("Shop B").textContent()) ?? "").includes("Anmeldung fehlgeschlagen"));
  await p.screenshot({ path: `${SHOTS}/cleanup-duplicates-evidence.png`, fullPage: true });
  await group.locator('[data-testid="dup-clean"]').click();
  const msg = (await p.textContent('[role="dialog"]')) ?? "";
  check("Bereinigen offers only the failed B", msg.includes("Shop B") && !msg.includes("„Shop A“") && !msg.includes("„Shop C“"), msg);
  await p.screenshot({ path: `${SHOTS}/cleanup-bereinigen-confirm.png` });
  await p.click('[data-testid="confirm-ok"]');
  await p.waitForTimeout(1500);
  const v = await rpc("getVault");
  const live = (n) => v.items.some((i) => i.name === n && !i.deletedDate);
  check("B in the trash, A and C kept", !live("Shop B") && live("Shop A") && live("Shop C"));
  await p.close();
}

// ------------------------------------------------------------------------------ "Aufräumen" tab
{
  await newLogin(A, "Ohne Website", "nosite", "x-1", []);
  await newLogin(A, "NAS", "admin", "x-2", ["http://10.0.0.5"]);
  await newLogin(A, "NAS mit Port", "admin", "x-3", ["http://10.0.0.5:5000"]);
  await newLogin(A, "Reuse A", "r", "Reuse-PW-9", ["https://reuse-a.test"]);
  await newLogin(B, "Reuse B", "r", "Reuse-PW-9", ["https://reuse-b.test"]);
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-cleanup"]');
  await p.waitForSelector('[data-testid="cleanup"]');
  await p.waitForTimeout(800);
  const section = async (id) => {
    const s = p.locator(`[data-testid="cleanup-${id}"]`);
    const head = s.locator("button.report-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
    await p.waitForTimeout(200);
    return (await s.textContent()) ?? "";
  };
  const nosite = await section("nosite");
  check("entry without website listed", nosite.includes("Ohne Website"), nosite);
  const noport = await section("noport");
  check("IP without port listed, with port not", noport.includes("NAS") && !noport.includes("NAS mit Port"), noport);
  const reuse = await section("reuse");
  check("password reused across accounts listed", reuse.includes("Reuse A") && reuse.includes("Reuse B"), reuse);
  const stale = await section("stale");
  check("never-used hint instead of a list on a young device", (await p.locator('[data-testid="cleanup-stale-young"]').count()) === 1, stale);
  await p.screenshot({ path: `${SHOTS}/cleanup-tab.png`, fullPage: true });
  await p.locator('[data-testid="cleanup-noport"] [data-testid="cleanup-item"]', { hasText: "NAS" }).first().click();
  await p.waitForTimeout(500);
  check("row opens the item", ((await p.textContent("body")) ?? "").includes("10.0.0.5"));
  await p.close();
}

// ------------------------------------------------------------------------------ move into the personal vault
{
  const before = (await rpc("getVault")).items.find((i) => i.name === "Netflix" && i.organizationId && !i.deletedDate);
  check("organization item present", !!before);
  const p = await popup();
  await p.fill('[data-testid="search"]', "Netflix");
  await p.waitForTimeout(400);
  await p.locator('[data-testid="item-row"]', { hasText: "Netflix" }).first().click();
  await p.click('[data-testid="detail-more"]');
  await p.click('[data-testid="menu-move-personal"]');
  await p.waitForSelector('[data-testid="move-personal-dialog"]');
  await p.screenshot({ path: `${SHOTS}/cleanup-move-dialog.png` });
  await p.click('[data-testid="move-ok"]');
  await p.waitForSelector("text=In deinen persönlichen Tresor verschoben", { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(800);
  const v = await rpc("getVault");
  const copy = v.items.find((i) => i.name === "Netflix" && !i.organizationId && !i.deletedDate);
  const orig = v.items.find((i) => i.id === before?.id);
  check("personal copy in the same account", copy?.accountKey === before?.accountKey && copy?.login?.password === before?.login?.password, JSON.stringify(copy?.login));
  check("original in the organization's trash", !!orig?.deletedDate, JSON.stringify(orig?.deletedDate));
  check("copy opened after the move", ((await p.textContent("body")) ?? "").includes("Netflix"));
  await p.close();
}

await ctx.close();
console.log(failed ? `E2E ${failed} FAILED` : "E2E ALL PASSED");
process.exit(failed ? 1 : 0);
