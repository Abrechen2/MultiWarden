import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? TMP + "/shots";
const PW = "Test-Passwort-123!";
const theme = process.env.THEME ?? "dark";
mkdirSync(SHOTS, { recursive: true });
const profile = TMP + "/profile";
rmSync(profile, { recursive: true, force: true });

const log = (...a) => console.log("•", ...a);
let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};

const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  colorScheme: theme,
  locale: "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
  viewport: { width: 1100, height: 760 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
log("extension", extId);

async function openPopup(query = "") {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html${query}`);
  await p.waitForTimeout(400);
  return p;
}
const shot = async (p, name) => p.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });

// ---- add accounts
let pop = await openPopup();
await shot(pop, "01-welcome");
async function addAccount(p, base, email) {
  await p.getByRole("button", { name: "Eigener Server" }).click();
  await p.fill('input[name="server-url"]', base);
  await p.fill('input[name="email"]', email);
  await p.fill('input[name="master-password"]', PW);
  await p.getByRole("button", { name: /Anmelden/ }).click();
}
await addAccount(pop, "http://localhost:8001", "alex@privat.test");
await pop.waitForSelector('[data-testid="all-items"]', { timeout: 30000 });
await shot(pop, "02-vault-one-account");

for (const [base, email] of [
  ["http://localhost:8002", "alex@firma.test"],
  ["http://localhost:8001", "familie@privat.test"],
]) {
  await pop.click('[data-testid="accounts-menu"]');
  await pop.getByRole("menuitem", { name: "Konto hinzufügen" }).click();
  await addAccount(pop, base, email);
  await pop.waitForSelector('[data-testid="all-items"]', { timeout: 30000 });
  await pop.waitForTimeout(1200);
}
const rows = await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count();
check("all items of 3 accounts listed", rows === 16, String(rows));
await shot(pop, "03-vault-three-accounts");

// account filter
await pop.click('[data-testid="filter-account"]');
await pop.waitForTimeout(200);
await shot(pop, "04-account-filter-open");
await pop.getByRole("menuitem", { name: /alex@firma.test/ }).click();
await pop.waitForTimeout(300);
const rowsB = await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count();
check("account filter limits to firma (5 items)", rowsB === 5, String(rowsB));
await shot(pop, "05-account-filter-firma");
// folder filter within account
await pop.click('[data-testid="filter-folder"]');
await pop.getByRole("menuitem", { name: "Infrastruktur" }).click();
await pop.waitForTimeout(200);
const rowsF = await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count();
check("folder filter", rowsF === 3, String(rowsF));
await shot(pop, "06-folder-filter");
// reset filters via chips
await pop.click('[data-testid="filter-folder"] .clear');
await pop.click('[data-testid="filter-account"] .clear');
// vault (org) filter
await pop.click('[data-testid="filter-vault"]');
await pop.getByRole("menuitem", { name: "Familie Beispiel" }).click();
await pop.waitForTimeout(200);
check("org filter", (await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count()) === 2);
await pop.click('[data-testid="filter-collection"]');
await shot(pop, "07-collection-filter-open");
await pop.getByRole("menuitem", { name: "Streaming" }).click();
check("collection filter", (await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count()) === 1);
await pop.click('[data-testid="filter-collection"] .clear');
await pop.click('[data-testid="filter-vault"] .clear');
// type filter
await pop.click('[data-testid="filter-type"]');
await pop.getByRole("menuitem", { name: "Karte" }).click();
check("type filter", (await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count()) === 1);
await pop.click('[data-testid="filter-type"] .clear');
// search
await pop.fill('[data-testid="search"]', "github");
await pop.waitForTimeout(200);
check("search across accounts", (await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count()) === 2);
await shot(pop, "08-search");
await pop.fill('[data-testid="search"]', "");

// item detail
await pop.locator('[data-testid="item-row"][data-name="Proxmox"]').first().click();
await pop.waitForSelector('[data-testid="detail-name"]');
await pop.waitForTimeout(300);
await shot(pop, "09-item-detail");
await pop.getByRole("button", { name: "Zurück" }).click();
await pop.close();

// ---- autofill through popup window (login page active in normal window)
const site = await ctx.newPage();
await site.goto("http://localhost:9000/login.html");
await site.bringToFront();
await site.waitForTimeout(500);
const popupPagePromise = ctx.waitForEvent("page");
await sw.evaluate(async (id) => {
  await chrome.windows.create({ url: `chrome-extension://${id}/popup.html?popout=1`, type: "popup", width: 400, height: 640 });
}, extId);
const pw = await popupPagePromise;
await pw.setViewportSize({ width: 380, height: 600 });
await pw.waitForSelector('[data-testid="suggestions"]', { timeout: 15000 });
const sugg = await pw.locator('[data-testid="suggestions"] [data-testid="item-row"][data-type="1"]').count();
check("autofill suggestions from 4 logins across 3 accounts", sugg === 4, String(sugg));
await shot(pw, "10-suggestions");
await pw.locator('[data-testid="suggestions"] [data-testid="item-row"][data-name="Test-Login (Firma)"] [data-testid="fill"]').click();
await pw.waitForTimeout(800);
const u = await site.inputValue("#u"),
  p = await site.inputValue("#p");
check("popup fill username/password (firma)", u === "a.beispiel@firma" && p === "firma-geheim-3", u + " / " + p);
await site.click("button[type=submit]");
const out = await site.textContent("#out");
check("controlled-input state updated", out.includes("firma-geheim-3"), out);
await pw.close();

// ---- inline menu
await site.reload();
await site.waitForTimeout(600);
await site.click("#u");
await site.waitForTimeout(1200);
const menuFrame = site.frames().find((f) => f.url().includes("inline-menu.html"));
check("inline menu iframe shown", !!menuFrame);
await site.screenshot({ path: `${SHOTS}/${theme}-11-inline-menu.png`, clip: { x: 300, y: 40, width: 520, height: 440 } });
if (menuFrame) {
  const entries = await menuFrame.locator("button.entry").count();
  check("inline menu lists 4 entries", entries === 4, String(entries));
  await menuFrame.locator("button.entry", { hasText: "Test-Login (privat)" }).click();
  await site.waitForTimeout(800);
  check("inline fill (privat)", (await site.inputValue("#u")) === "alex.privat" && (await site.inputValue("#p")) === "privat-geheim-1");
}

// ---- iframe page
const ifr = await ctx.newPage();
await ifr.goto("http://localhost:9000/iframe.html");
await ifr.waitForTimeout(800);
const r = await sw.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.url;
});
log("active tab", r);
await ifr.close();

// ---- lock & unlock
pop = await openPopup();
await pop.click('[data-testid="accounts-menu"]');
await pop.getByRole("menuitem", { name: "Alle sperren" }).click();
await pop.waitForSelector('input[name="master-password"]');
await pop.waitForTimeout(300);
await shot(pop, "12-locked");
await pop.fill('input[name="master-password"]', PW);
await pop.keyboard.press("Enter");
await pop.waitForSelector('[data-testid="all-items"]', { timeout: 30000 });
await pop.waitForTimeout(800);
check("unlock all with one password", (await pop.locator('[data-testid="all-items"] [data-testid="item-row"]').count()) === 16);

// ---- add item into specific account
await pop.click('[data-testid="add"]');
await pop.getByRole("menuitem", { name: "Login" }).click();
const firmaVal = await pop.locator('[data-testid="edit-account"] option', { hasText: "firma" }).getAttribute("value");
await pop.selectOption('[data-testid="edit-account"]', firmaVal);
await pop.fill('[data-testid="edit-name"]', "Neuer Firmen-Login");
await pop.fill('[data-testid="edit-username"]', "neu@firma");
await pop.fill('[data-testid="edit-uri"]', "https://intranet.firma.test");
await shot(pop, "13-add-item");
await pop.click('[data-testid="save"]');
await pop.waitForSelector('[data-testid="detail-name"]');
check("created item detail", (await pop.textContent('[data-testid="detail-name"]')).includes("Neuer Firmen-Login"));
check("created in firma account", (await pop.textContent('[data-testid="detail-account"]')).includes("alex@firma.test"));
await shot(pop, "14-created");

// accounts view
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForSelector('[data-testid="all-items"]');
await pop.click('[data-testid="accounts-menu"]');
await pop.waitForTimeout(200);
await shot(pop, "15-accounts-menu");
await pop.getByRole("menuitem", { name: "Konten verwalten" }).click();
await pop.waitForTimeout(300);
await shot(pop, "16-accounts");

console.log(failed ? `${failed} FAILED` : "E2E ALL PASSED");
await ctx.close();
process.exit(failed ? 1 : 0);
