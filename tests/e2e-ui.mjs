// Browser test of language, colour schemes, settings layout and appearance options.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? SP + "/shots";
const PW = "Test-Passwort-123!";
mkdirSync(SHOTS, { recursive: true });
const profile = SP + "/profile-ui";
rmSync(profile, { recursive: true, force: true });

let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};

const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  locale: process.env.LOCALE ?? "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", `--lang=${process.env.LOCALE ?? "de-DE"}`],
  viewport: { width: 1100, height: 760 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/popup.html`);
const rpc = async (name, args = {}) => {
  const r = await ext.evaluate(([n, a]) => chrome.runtime.sendMessage({ rpc: n, args: a }), [name, args]);
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

async function popup(w = 380) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
const cssVar = (p, v) => p.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), v);

// default: system language (de) + MultiWarden scheme
let p = await popup();
check("German by default (system language de)", (await p.textContent(".tabs")).includes("Einstellungen"));
check("default scheme primary", (await cssVar(p, "--primary")) === "#175ddc", await cssVar(p, "--primary"));

// switch language to English via settings
await p.getByRole("button", { name: "Einstellungen" }).click();
await p.selectOption('[data-testid="language"]', "en");
await p.waitForTimeout(500);
check("UI switches to English", (await p.textContent(".tabs")).includes("Settings") && (await p.textContent("main")).includes("Appearance"));
await p.screenshot({ path: `${SHOTS}/ui-settings-en.png` });

// colour schemes
check("Bitwarden scheme removed", (await p.locator('[data-testid="scheme-bitwarden"]').count()) === 0);
for (const [id, primary] of [
  ["mint", "#0e8063"],
  ["tuvia", "#ff4d9a"],
  ["red", "#c4202f"],
  ["gray", "#3f3f46"],
]) {
  await p.click(`[data-testid="scheme-${id}"]`);
  await p.waitForTimeout(300);
  check(`scheme ${id}`, (await cssVar(p, "--primary")) === primary, await cssVar(p, "--primary"));
}
await p.selectOption('[data-testid="theme-mode"]', "dark");
await p.waitForTimeout(300);
check("gray dark", (await cssVar(p, "--bg")) === "#161616", await cssVar(p, "--bg"));
await p.screenshot({ path: `${SHOTS}/ui-gray-dark.png` });
await p.click('[data-testid="scheme-red"]');
await p.waitForTimeout(300);
check("red dark", (await cssVar(p, "--primary")) === "#ff6b74", await cssVar(p, "--primary"));
await p.goto(`chrome-extension://${extId}/popup.html`);
await p.waitForSelector('[data-testid="all-items"]');
await p.waitForTimeout(300);
await p.screenshot({ path: `${SHOTS}/ui-red-dark-vault.png` });

// custom colours
await p.getByRole("button", { name: "Settings" }).click();
await p.click('[data-testid="scheme-custom"]');
await p.waitForSelector('[data-testid="custom-colors"]');
// own colour picker instead of the native dialog (which closes the popup on Windows)
check("no native colour inputs", (await p.locator('input[type="color"]').count()) === 0);
await p.click('[data-testid="color-accent"]');
await p.waitForSelector('[data-testid="color-picker"]');
// hue slider by keyboard (Home = red), then drag across the area beyond its top right corner (clamped: full saturation/brightness)
await p.focus('[data-testid="cp-hue"]');
await p.keyboard.press("Home");
const sv = await p.locator('[data-testid="cp-sv"]').boundingBox();
await p.mouse.move(sv.x + sv.width / 2, sv.y + sv.height / 2);
await p.mouse.down();
await p.mouse.move(sv.x + sv.width / 4, sv.y + sv.height / 2, { steps: 3 });
check("picker previews while dragging", (await rpc("getState")).settings.customColors?.accent !== (await cssVar(p, "--primary")));
await p.mouse.move(sv.x + sv.width + 40, sv.y - 40, { steps: 4 });
await p.mouse.up();
await p.waitForTimeout(500);
check("picker: drag saves the colour", (await rpc("getState")).settings.customColors.accent === "#ff0000", JSON.stringify((await rpc("getState")).settings.customColors));
check("picker: colour applied", (await cssVar(p, "--primary")) === "#ff0000", await cssVar(p, "--primary"));
// keyboard in the area: Home = no saturation (grey at full brightness)
await p.focus('[data-testid="cp-sv"]');
await p.keyboard.press("Home");
await p.waitForTimeout(400);
check("picker: keyboard", (await rpc("getState")).settings.customColors.accent === "#ffffff", (await rpc("getState")).settings.customColors.accent);
await p.locator('[data-testid="color-picker"]').scrollIntoViewIfNeeded();
await p.screenshot({ path: `${SHOTS}/ui-color-picker.png` });
await p.click('[data-testid="cp-preset-0a8f6a"]');
await p.waitForTimeout(500);
await p.keyboard.press("Escape");
check("picker closes with Escape", (await p.locator('[data-testid="color-picker"]').count()) === 0);
check("custom accent applied", (await cssVar(p, "--primary")) === "#0a8f6a", await cssVar(p, "--primary"));
const st = await rpc("getState");
check("custom colours stored", st.settings.colorScheme === "custom" && st.settings.customColors.accent === "#0a8f6a", JSON.stringify(st.settings.customColors));
// hex code typed directly
await p.fill('[data-testid="hex-accent"]', "#123abc");
await p.press('[data-testid="hex-accent"]', "Enter");
await p.waitForTimeout(500);
check("hex code applied", (await cssVar(p, "--primary")) === "#123abc", await cssVar(p, "--primary"));
check("hex code stored", (await rpc("getState")).settings.customColors.accent === "#123abc");
await p.fill('[data-testid="hex-background"]', "f0a");
await p.press('[data-testid="hex-background"]', "Tab");
await p.waitForTimeout(500);
check("short hex code expanded", (await rpc("getState")).settings.customColors.background === "#ff00aa", JSON.stringify((await rpc("getState")).settings.customColors));
await p.fill('[data-testid="hex-text"]', "#zzz");
await p.press('[data-testid="hex-text"]', "Enter");
await p.waitForTimeout(300);
check("invalid hex code ignored", (await rpc("getState")).settings.customColors.text !== "#zzz");
await p.locator('[data-testid="custom-colors"]').scrollIntoViewIfNeeded();
await p.screenshot({ path: `${SHOTS}/ui-custom-colors.png` });
await rpc("setSettings", { customColors: { accent: "#0a8f6a" } });

// settings layout: sections
await p.selectOption('[data-testid="settings-layout"]', "sections");
await p.waitForTimeout(400);
check("sections index shown", (await p.locator('[data-testid="settings-index"]').count()) === 1);
await p.screenshot({ path: `${SHOTS}/ui-settings-sections.png` });
await p.click('[data-testid="section-appearance"]');
await p.waitForTimeout(300);
check("appearance sub page", (await p.locator('[data-testid="color-schemes"]').count()) === 1 && (await p.locator('[data-testid="settings-index"]').count()) === 0);
await p.getByRole("button", { name: "Back", exact: true }).click();
check("back to index", (await p.locator('[data-testid="settings-index"]').count()) === 1);

// inline menu / notification pages follow the scheme
const im = await ctx.newPage();
await im.goto(`chrome-extension://${extId}/inline-menu.html#x`);
await im.waitForTimeout(400);
check("inline menu follows custom accent", (await cssVar(im, "--primary")) === "#0a8f6a");
await im.close();

// compact mode, width, quick copy, language back to German
// French and Spanish
for (const [l, word] of [
  ["fr", "Paramètres"],
  ["es", "Ajustes"],
]) {
  await rpc("setSettings", { language: l });
  const q = await popup();
  check(`language ${l}`, (await q.textContent(".tabs")).includes(word), await q.textContent(".tabs"));
  await q.close();
}
// a removed scheme ("bitwarden" until 1.2.0) falls back to MultiWarden
await rpc("setSettings", { colorScheme: "bitwarden", theme: "light" });
{
  const q = await popup();
  check("old scheme falls back to MultiWarden", (await cssVar(q, "--primary")) === "#175ddc", await cssVar(q, "--primary"));
  await q.close();
}
await rpc("setSettings", { compactMode: true, popupWidth: "wide", quickCopy: true, colorScheme: "mint", theme: "light", language: "de" });
const p2 = await popup(480);
check("compact class", await p2.evaluate(() => document.documentElement.classList.contains("compact")));
check("wide popup", (await p2.evaluate(() => document.body.getBoundingClientRect().width)) === 480);
check("quick copy buttons", (await p2.locator('[data-testid="quick-copy"]').count()) > 0);
check("quick copy only for logins", (await p2.locator('[data-testid="item-row"]:not([data-type="1"]) [data-testid="quick-copy"]').count()) === 0);
check("German again", (await p2.textContent(".tabs")).includes("Einstellungen"));
await p2.screenshot({ path: `${SHOTS}/ui-mint-compact-wide.png` });

// dropdown lists in the colour scheme (customizable select in Chromium)
check("selects use the themed list", (await p2.evaluate(() => getComputedStyle(document.querySelector("select") ?? document.body).appearance)) === "base-select" || (await p2.locator("select").count()) === 0);
// avatar initials centred
const off = await p2.evaluate(() => {
  const a = document.querySelector('[data-testid="accounts-menu"] .avatar');
  const i = a?.querySelector(".ini");
  if (!a || !i) return null;
  const r = a.getBoundingClientRect();
  const q = i.getBoundingClientRect();
  return { dx: Math.abs(r.left + r.width / 2 - (q.left + q.width / 2)), dy: Math.abs(r.top + r.height / 2 - (q.top + q.height / 2)) };
});
check("avatar initials centred", !!off && off.dx <= 1 && off.dy <= 1.5, JSON.stringify(off));
// folders / collections / organisations show their account
await p2.click('[data-testid="filter-folder"]');
await p2.waitForTimeout(300);
check("folder filter shows account badges", (await p2.locator('.popover [data-testid="account-badges"]').count()) > 0);
await p2.keyboard.press("Escape");
await p2.close();

// sidebar (Firefox / Opera): same UI, full size of the panel
{
  const sb = await ctx.newPage();
  await sb.setViewportSize({ width: 520, height: 700 });
  await sb.goto(`chrome-extension://${extId}/popup.html?sidebar=1`);
  await sb.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  check("sidebar uses the full width", (await sb.evaluate(() => document.body.getBoundingClientRect().width)) === 520);
  check("sidebar marked", await sb.evaluate(() => document.body.classList.contains("sidebar")));
  await sb.screenshot({ path: `${SHOTS}/ui-sidebar.png` });
  await sb.close();
  const man = (t) => JSON.parse(readFileSync(`dist/${t}/manifest.json`, "utf8"));
  check("Firefox manifest has the sidebar", man("firefox").sidebar_action?.default_panel === "popup.html?sidebar=1");
  check("Opera manifest has the sidebar", man("opera").sidebar_action?.default_panel === "popup.html?sidebar=1");
  check("Chrome manifest without sidebar key", !man("chrome").sidebar_action);
}

// phishing warning: a listed link opens the warning page instead
{
  await rpc("setSettings", { phishingWarning: true });
  const PHISH = "http://localhost:9000/login.html?phish=1";
  await sw.evaluate((u) => globalThis.__mwTest.phishing.setList([u, "https://other.example/x"]), PHISH);
  const tab = await ctx.newPage();
  await tab.goto(PHISH).catch(() => {});
  await tab.waitForURL(/phishing=/, { timeout: 10000 }).catch(() => {});
  check("phishing link replaced by the warning", tab.url().includes("popup.html") && tab.url().includes("phishing="), tab.url());
  await tab.waitForSelector('[data-testid="phishing-warning"]', { timeout: 10000 }).catch(() => {});
  check("warning shows the address", ((await tab.textContent('[data-testid="phishing-url"]').catch(() => "")) ?? "").includes("localhost:9000/login.html"));
  await tab.screenshot({ path: `${SHOTS}/ui-phishing.png` });
  await tab.click('[data-testid="phishing-continue"]');
  await tab.waitForURL(PHISH, { timeout: 10000 }).catch(() => {});
  await tab.waitForTimeout(1200);
  check("'continue anyway' opens the page", tab.url() === PHISH, tab.url());
  const tab2 = await ctx.newPage();
  await tab2.goto(PHISH).catch(() => {});
  await tab2.waitForURL(/phishing=/, { timeout: 10000 }).catch(() => {});
  check("other tab is warned again", tab2.url().includes("phishing="), tab2.url());
  await tab2.waitForSelector('[data-testid="phishing-leave"]');
  const closed = tab2.waitForEvent("close", { timeout: 5000 }).then(() => true).catch(() => false);
  await tab2.click('[data-testid="phishing-leave"]');
  check("'leave' closes the tab", await closed);
  const ok = await ctx.newPage();
  await ok.goto("http://localhost:9000/login.html");
  await ok.waitForTimeout(800);
  check("other pages are not affected", ok.url() === "http://localhost:9000/login.html", ok.url());
  await ok.close();
  await tab.close();
  await rpc("setSettings", { phishingWarning: false });
}

// 1.2.2: quick copy next to "Ausfüllen" (wide layouts), copy entries in the "more" menu, all types in the filter
{
  const site = await ctx.newPage();
  await site.goto("http://localhost:9000/login.html");
  await site.bringToFront();
  await site.waitForTimeout(500);
  const openPopout = async () => {
    const pp = ctx.waitForEvent("page");
    await sw.evaluate(async (id) => {
      await chrome.windows.create({ url: `chrome-extension://${id}/popup.html?popout=1`, type: "popup", width: 600, height: 700 });
    }, extId);
    const q = await pp;
    await q.setViewportSize({ width: 480, height: 640 });
    await q.waitForSelector('[data-testid="suggestions"] [data-testid="item-row"]', { timeout: 15000 });
    await q.waitForTimeout(300);
    return q;
  };
  const sugCopies = (q) => q.locator('[data-testid="suggestions"] [data-testid="quick-copy"]').count();
  await rpc("setSettings", { popupWidth: "default", quickCopy: true, compactMode: false, language: "de" });
  let q = await openPopout();
  check("no quick copy in suggestions at default width", (await sugCopies(q)) === 0);
  await q.close();
  for (const w of ["wide", "extraWide"]) {
    await rpc("setSettings", { popupWidth: w });
    q = await openPopout();
    check(`quick copy in suggestions (${w})`, (await sugCopies(q)) > 0);
    const row = q.locator('[data-testid="suggestions"] [data-testid="item-row"][data-name="Test-Login (privat)"]');
    const copyBox = await row.locator('[data-testid="quick-copy"]').last().boundingBox();
    const fillBox = await row.locator('[data-testid="fill"]').boundingBox();
    check(`quick copy left of "Ausfüllen" (${w})`, !!copyBox && !!fillBox && copyBox.x + copyBox.width <= fillBox.x);
    const plainCopies = await q.locator('[data-testid="suggestions"] [data-testid="item-row"]:not([data-type="1"]) [data-testid="quick-copy"]').count();
    check(`no look-alike copy buttons for identities/cards (${w})`, plainCopies === 0, String(plainCopies));
    check(`login quick copy: username, password, TOTP (${w})`, (await row.locator('[data-testid="quick-copy"]').count()) === 3);
    if (w === "wide") await q.screenshot({ path: `${SHOTS}/ui-suggestions-quickcopy.png` });
    await q.close();
  }
  await rpc("setSettings", { quickCopy: false });
  q = await openPopout();
  check("quick copy off: none in suggestions", (await sugCopies(q)) === 0);
  // the "more" menu always starts with copying username and password
  await q.locator('[data-testid="suggestions"] [data-testid="item-row"][data-name="Test-Login (privat)"] button[aria-label="Weitere Optionen"]').click();
  const items = q.getByRole("menuitem");
  check("menu: copy username first", ((await items.nth(0).textContent()) ?? "").includes("Benutzername kopieren"), await items.nth(0).textContent());
  check("menu: copy password second", ((await items.nth(1).textContent()) ?? "").includes("Passwort kopieren"), await items.nth(1).textContent());
  check("menu: copy TOTP third", ((await items.nth(2).textContent()) ?? "").includes("TOTP kopieren"), await items.nth(2).textContent());
  await q.screenshot({ path: `${SHOTS}/ui-more-menu.png` });
  await items.nth(1).click();
  await q.waitForTimeout(300);
  check("menu: password copied", ((await q.textContent("body")) ?? "").includes("Passwort kopiert"));
  check("menu click stays in the vault list", (await q.locator('[data-testid="detail-name"]').count()) === 0 && (await q.locator('[data-testid="all-items"]').count()) === 1);
  // also in the normal list (no quick copy)
  await q.locator('[data-testid="all-items"] [data-testid="item-row"][data-type="1"]').first().locator('button[aria-label="Weitere Optionen"]').click();
  check("menu in the list: copy username", (await q.locator('[data-testid="menu-copy-username"]').count()) === 1);
  await q.keyboard.press("Escape");
  await q.waitForTimeout(200);
  // non-login items have no username/password entries
  await q.locator('[data-testid="all-items"] [data-testid="item-row"][data-type="3"]').first().locator('button[aria-label="Weitere Optionen"]').click();
  check("menu of a card: no login copy entries", (await q.locator('[data-testid^="menu-copy-"]').count()) === 0);
  await q.keyboard.press("Escape");
  await q.waitForTimeout(200);
  // type filter offers all types, including the new experimental ones
  await q.click('[data-testid="filter-type"]');
  const types = (await q.getByRole("menuitem").allTextContents()).join("|");
  for (const tx of ["Login", "Sichere Notiz", "Karte", "Identität", "SSH-Schlüssel", "Bankkonto", "Führerschein", "Reisepass"])
    check(`type filter offers ${tx}`, types.includes(tx), types);
  await q.close();
  await site.close();
  await rpc("setSettings", { popupWidth: "default" });
}

// open source components and license texts in "Über"
{
  const list = JSON.parse(readFileSync("src/shared/third-party.json", "utf8"));
  const q = await popup();
  await q.locator(".tabs").getByText("Einstellungen").click();
  await q.waitForTimeout(300);
  // settings layout "sections" (set above): open the "Über" page
  if (await q.locator('[data-testid="section-about"]').count()) await q.click('[data-testid="section-about"]');
  await q.waitForSelector('[data-testid="oss-list"]');
  check("about lists the open source components", (await q.locator('[data-testid="oss-item"]').count()) === list.length);
  const hrefs = await q.$$eval('[data-testid="oss-item"]', (as) => as.map((a) => a.getAttribute("href")));
  check("components link to their repositories", hrefs.every((h) => /^https:\/\//.test(h ?? "")) && hrefs.some((h) => h.includes("github.com/cozmo/jsQR")));
  await q.locator('[data-testid="oss-list"]').scrollIntoViewIfNeeded();
  await q.screenshot({ path: `${SHOTS}/ui-about-oss.png` });
  const np = ctx.waitForEvent("page");
  await q.click('[data-testid="license-texts"]');
  const lic = await np;
  await lic.waitForLoadState();
  const txt = (await lic.textContent("body")) ?? "";
  check("license texts open", lic.url().endsWith("/THIRD-PARTY-NOTICES.txt"), lic.url());
  check("license texts complete", ["Apache License", "Mozilla Public License", "ISC License", "CC BY 3.0 US", "Biró"].every((s) => txt.includes(s)));
  check("GPL text shipped", readFileSync("dist/chrome/LICENSE.txt", "utf8").includes("GNU GENERAL PUBLIC LICENSE"));
  await lic.close();
  await q.close();
}

await ctx.close();
console.log(failed ? `${failed} FAILED` : "UI E2E ALL PASSED");
process.exit(failed ? 1 : 0);
