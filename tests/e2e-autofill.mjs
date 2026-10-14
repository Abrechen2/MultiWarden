import { chromium } from "playwright-core";
import { rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const EXT = path.resolve("dist/chrome");
const SHOTS = TMP + "/shots";
const PW = "Test-Passwort-123!";
const profile = TMP + "/profile2";
rmSync(profile, { recursive: true, force: true });
let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};

const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  locale: "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
  viewport: { width: 1000, height: 700 },
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/popup.html`);
const rpc = (name, args = {}) => ext.evaluate(([n, a]) => chrome.runtime.sendMessage({ rpc: n, args: a }), [name, args]);

for (const [base, email] of [
  ["http://localhost:8001", "alex@privat.test"],
  ["http://localhost:8002", "alex@firma.test"],
]) {
  const r = await rpc("loginStart", { server: "selfhosted", baseUrl: base, email, password: PW });
  check("login " + email, r.ok && r.data.step === "done", JSON.stringify(r));
  await rpc("loginAck");
}
const vault = (await rpc("getVault")).data;
const find = (name) => vault.items.find((i) => i.name === name);
const privat = find("Test-Login (privat)");
const firma = find("Test-Login (Firma)");
const github = find("GitHub");

async function openTab(url) {
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(500);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0]?.id, url.split("#")[0]);
  return { p, tabId };
}

// 0. http downgrade protection + reprompt items
{
  const accountKey = privat.accountKey;
  const mk = (name, uri, reprompt) => ({
    id: "",
    accountKey,
    type: 1,
    name,
    favorite: false,
    reprompt,
    edit: true,
    viewPassword: true,
    collectionIds: [],
    fields: [],
    passwordHistory: [],
    attachments: [],
    login: { username: name + "-user", password: name + "-pw", uris: [{ uri, match: 1 }], passkeys: 0 },
  });
  const a = await rpc("saveItem", { accountKey, item: mk("Nur-HTTPS", "https://localhost:9000/login.html", 0), isNew: true });
  const b = await rpc("saveItem", { accountKey, item: mk("Geschützt", "http://localhost:9000/login.html", 1), isNew: true });
  check("created test items", a.data?.ok && b.data?.ok, JSON.stringify([a, b]));
  const { p, tabId } = await openTab("http://localhost:9000/login.html");
  const r1 = await rpc("autofill", { accountKey, itemId: a.data.item.id, tabId });
  check(
    "https-only login refused on http page",
    !r1.data?.ok && r1.data?.code === "insecure" && (await p.inputValue("#p")) === "",
    JSON.stringify(r1),
  );
  const r2 = await rpc("autofill", { accountKey, itemId: a.data.item.id, tabId, force: true });
  check("https-only login after confirmation", r2.data?.ok && (await p.inputValue("#p")) === "Nur-HTTPS-pw", JSON.stringify(r2));
  await p.reload();
  await p.waitForTimeout(500);
  await p.click("#u");
  await p.waitForTimeout(1200);
  const menu = p.frames().find((f) => f.url().includes("inline-menu.html"));
  const names = menu ? await menu.locator("button.entry b").allTextContents() : [];
  check(
    "inline menu hides re-prompt and https-only items on http",
    menu && !names.includes("Geschützt") && !names.includes("Nur-HTTPS") && names.length === 3,
    JSON.stringify(names),
  );
  await p.close();
  await rpc("deleteItem", { accountKey, itemId: a.data.item.id, permanent: true });
  await rpc("deleteItem", { accountKey, itemId: b.data.item.id, permanent: true });
}

// 1. same-origin iframe
{
  const { p, tabId } = await openTab("http://localhost:9000/iframe.html");
  const r = await rpc("autofill", { accountKey: privat.accountKey, itemId: privat.id, tabId });
  const fr = p.frames().find((f) => f.url().endsWith("/login.html"));
  check(
    "same-origin iframe filled",
    r.data?.ok && (await fr.inputValue("#u")) === "alex.privat" && (await fr.inputValue("#p")) === "privat-geheim-1",
    JSON.stringify(r),
  );
  await p.close();
}
// 2. cross-origin iframe must NOT be filled
{
  const { p, tabId } = await openTab("http://localhost:9000/cross.html");
  const r = await rpc("autofill", { accountKey: privat.accountKey, itemId: privat.id, tabId });
  const fr = p.frames().find((f) => f.url().includes("127.0.0.1"));
  check("foreign-origin iframe refused", !r.data?.ok && (await fr.inputValue("#p")) === "", JSON.stringify(r));
  await p.close();
}
// 3. username-only step
{
  const { p, tabId } = await openTab("http://localhost:9000/step1.html");
  const r = await rpc("autofill", { accountKey: firma.accountKey, itemId: firma.id, tabId });
  check("username-first step", r.data?.ok && (await p.inputValue("#e")) === "a.beispiel@firma", JSON.stringify(r));
  await p.close();
}
// 4. TOTP-only page
{
  const { p, tabId } = await openTab("http://localhost:9000/otp.html");
  const r = await rpc("autofill", { accountKey: privat.accountKey, itemId: privat.id, tabId });
  const v = await p.inputValue("#c");
  check(
    "TOTP-only page filled + code returned for clipboard",
    r.data?.ok && /^\d{6}$/.test(v) && r.data.totpCopied === v,
    JSON.stringify(r) + " " + v,
  );
  await p.close();
}
// 5. non-matching item from popup → error, force fills
{
  const { p, tabId } = await openTab("http://localhost:9000/login.html");
  const r = await rpc("autofill", { accountKey: github.accountKey, itemId: github.id, tabId });
  check("non-matching item refused", !r.data?.ok && r.data?.code === "mismatch", JSON.stringify(r));
  const r2 = await rpc("autofill", { accountKey: github.accountKey, itemId: github.id, tabId, force: true });
  check("non-matching item with explicit confirmation", r2.data?.ok && (await p.inputValue("#u")) === "alex-gh", JSON.stringify(r2));
  await p.close();
}
// 6. keyboard shortcut cycles through accounts
{
  const { p } = await openTab("http://localhost:9000/login.html");
  await p.bringToFront();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await sw.evaluate(() => globalThis.__mwTest.menus.command("autofill_login"));
    await p.waitForTimeout(300);
    seen.push(await p.inputValue("#u"));
  }
  check("shortcut cycles matches", new Set(seen).size === 3, JSON.stringify(seen));
  await p.close();
}
// 7. badge count
{
  const { p, tabId } = await openTab("http://localhost:9000/login.html");
  await p.bringToFront();
  await p.waitForTimeout(800);
  const badge = await sw.evaluate(async (t) => chrome.action.getBadgeText({ tabId: t }), tabId);
  check("badge shows number of matches", badge === "3", badge);
  await p.close();
}
// 8. context menu builds without errors (with matches for the active tab)
{
  const { p } = await openTab("http://localhost:9000/login.html");
  await p.bringToFront();
  const errs = await sw.evaluate(async () => {
    await globalThis.__mwTest.rebuildContextMenu();
    await globalThis.__mwTest.rebuildContextMenu();
    await new Promise((r) => setTimeout(r, 300));
    return globalThis.__mwTest.menuErrors;
  });
  check("context menu without errors", errs.length === 0, JSON.stringify(errs));
  await p.close();
}
// 9. inline menu inside same-origin iframe
{
  const { p } = await openTab("http://localhost:9000/iframe.html");
  const fr = p.frames().find((f) => f.url().endsWith("/login.html"));
  await fr.click("#p");
  await p.waitForTimeout(1200);
  const menu = p.frames().find((f) => f.url().includes("inline-menu.html"));
  check("inline menu inside iframe", !!menu);
  if (menu) {
    await menu.locator("button.entry", { hasText: "Firma" }).click();
    await p.waitForTimeout(800);
    check("inline fill inside iframe", (await fr.inputValue("#p")) === "firma-geheim-3");
  }
  await p.screenshot({ path: `${SHOTS}/iframe-inline.png` });
  await p.close();
}
// 10. locked state: inline menu shows unlock hint
{
  await rpc("lock", {});
  const { p } = await openTab("http://localhost:9000/login.html");
  await p.click("#u");
  await p.waitForTimeout(1200);
  const menu = p.frames().find((f) => f.url().includes("inline-menu.html"));
  check("inline menu shows locked state", !!menu && (await menu.locator("button.unlock").count()) === 1);
  await p.screenshot({ path: `${SHOTS}/inline-locked.png`, clip: { x: 300, y: 40, width: 420, height: 260 } });
  await p.close();
}
console.log(failed ? `${failed} FAILED` : "AUTOFILL E2E ALL PASSED");
await ctx.close();
process.exit(failed ? 1 : 0);
