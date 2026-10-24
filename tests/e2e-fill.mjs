// Browser test of release 1.2 autofill features: cards, identities, generator in the inline menu,
// context menu / shortcuts, autofill on page load, icon mode, blocked domains, data-bwignore, Basic auth.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = SP + "/shots";
const PW = "Test-Passwort-123!";
const SITE = "http://localhost:9000";
mkdirSync(SHOTS, { recursive: true });
const profile = SP + "/profile-fill";
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
  viewport: { width: 1000, height: 760 },
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
let vault = await rpc("getVault");
const TEST_ITEMS = ["Lieferadresse Test", "Basic-Test", "Basic-Test 2"];
// leftovers of an aborted run
for (const i of vault.items.filter((x) => TEST_ITEMS.includes(x.name)))
  await rpc("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });
vault = await rpc("getVault");
const card = vault.items.find((i) => i.name === "Visa Privat");
const accountKey = card.accountKey;

const base = (type, name, extra) => ({
  id: "",
  accountKey,
  type,
  name,
  favorite: false,
  reprompt: 0,
  edit: true,
  viewPassword: true,
  collectionIds: [],
  fields: [],
  passwordHistory: [],
  attachments: [],
  ...extra,
});
const created = [];
async function create(item) {
  const r = await rpc("saveItem", { accountKey, item, isNew: true });
  if (!r.ok) throw new Error(r.error);
  created.push(r.item.id);
  return r.item;
}
const ident = await create(
  base(4, "Lieferadresse Test", {
    identity: {
      title: "Herr",
      firstName: "Erika",
      lastName: "Mustermann",
      company: "Muster GmbH",
      address1: "Musterstraße 12a",
      postalCode: "12345",
      city: "Musterstadt",
      country: "DE",
      email: "erika@example.test",
      phone: "+49 30 1234567",
    },
  }),
);

async function openTab(url) {
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(600);
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "*" }))[0]?.id, url.split("#")[0]);
  return { p, tabId };
}
const menuFrame = (p) => p.frames().find((f) => f.url().includes("inline-menu.html"));
const settings = (s) => rpc("setSettings", s);

// 1. card via popup: top frame (selects) + hosted payment frame, never the ad frame
{
  const { p, tabId } = await openTab(SITE + "/checkout.html");
  const r = await rpc("autofill", { accountKey, itemId: card.id, tabId });
  const pay = p.frames().find((f) => f.url().includes("payframe"));
  const ad = p.frames().find((f) => f.url().includes("adframe"));
  const v = {
    holder: await p.inputValue("#holder"),
    num: await p.inputValue("#ccnum"),
    m: await p.inputValue("#exp-m"),
    y: await p.inputValue("#exp-y"),
    cvc: await p.inputValue("#cvc"),
    brand: await p.inputValue("#brand"),
  };
  check(
    "card fields filled (holder, number, month/year selects, CVC, brand)",
    r.ok &&
      v.holder === "Alex Beispiel" &&
      v.num === "4111111111111111" &&
      v.m === "08" &&
      v.y === "2029" &&
      v.cvc === "123" &&
      v.brand === "VI",
    JSON.stringify([r, v]),
  );
  // the hosted payment frame is on another origin (127.0.0.1 vs. localhost): card data goes there only
  // after the user confirms (audit hardening), a plain fill leaves it empty
  check(
    "cross-origin payment frame not filled without confirmation",
    (await pay.inputValue("#pf-num")) === "" && (await pay.inputValue("#pf-exp")) === "" && (await pay.inputValue("#pf-cvc")) === "",
    [await pay.inputValue("#pf-num"), await pay.inputValue("#pf-exp"), await pay.inputValue("#pf-cvc")].join("|"),
  );
  check(
    "foreign ad frame untouched",
    (await ad.inputValue("#ad-card")) === "" && (await ad.inputValue("#ad-mail")) === "" && (await ad.inputValue("#ad-name")) === "",
  );
  await p.screenshot({ path: `${SHOTS}/fill-card.png` });
  await p.close();
}

// 2. card via inline menu on the card number field
{
  const { p } = await openTab(SITE + "/checkout.html");
  await p.click("#ccnum");
  await p.waitForTimeout(1200);
  const m = menuFrame(p);
  const names = m ? await m.locator('[data-testid="inline-item"] b').allTextContents() : [];
  check("inline menu lists cards on card field", names.includes("Visa Privat"), JSON.stringify(names));
  check("inline menu offers 'Neue Karte'", !!m && (await m.locator('[data-testid="inline-new"]').textContent()).includes("Neue Karte"));
  await p.screenshot({ path: `${SHOTS}/inline-card.png` });
  if (m) {
    await m.locator('[data-testid="inline-item"]', { hasText: "Visa Privat" }).click();
    await p.waitForTimeout(800);
  }
  check("inline card fill", (await p.inputValue("#ccnum")) === "4111111111111111" && (await p.inputValue("#exp-y")) === "2029");
  await p.close();
}

// 3. identity via popup (German address form with house number, salutation and country selects)
{
  const { p, tabId } = await openTab(SITE + "/address.html");
  const r = await rpc("autofill", { accountKey, itemId: ident.id, tabId });
  const get = async (sel) => p.inputValue(sel);
  const v = {
    anrede: await get("#anrede"),
    vn: await get("#vn"),
    nn: await get("#nn"),
    firma: await get("#firma"),
    str: await get("#str"),
    hnr: await get("#hnr"),
    plz: await get("#plz"),
    ort: await get("#ort"),
    land: await get("#land"),
    mail: await get("#mail"),
    tel: await get("#tel"),
  };
  check(
    "identity: German address form",
    r.ok &&
      v.anrede === "m" &&
      v.vn === "Erika" &&
      v.nn === "Mustermann" &&
      v.firma === "Muster GmbH" &&
      v.str === "Musterstraße" &&
      v.hnr === "12a" &&
      v.plz === "12345" &&
      v.ort === "Musterstadt" &&
      v.land === "DE" &&
      v.mail === "erika@example.test" &&
      v.tel === "+49 30 1234567",
    JSON.stringify([r, v]),
  );
  await p.screenshot({ path: `${SHOTS}/fill-identity.png` });
  await p.close();
}

// 4. identity: autocomplete tokens, textarea address, country select by name
{
  const { p, tabId } = await openTab(SITE + "/shipping.html");
  const r = await rpc("autofill", { accountKey, itemId: ident.id, tabId });
  const v = {
    name: await p.inputValue("#s-name"),
    org: await p.inputValue("#s-org"),
    addr: await p.inputValue("#s-addr"),
    city: await p.inputValue("#s-city"),
    zip: await p.inputValue("#s-zip"),
    country: await p.inputValue("#s-country"),
    mail: await p.inputValue("#s-mail"),
  };
  check(
    "identity: autocomplete form (full name, textarea, country by name)",
    r.ok &&
      v.name === "Erika Mustermann" &&
      v.org === "Muster GmbH" &&
      v.addr === "Musterstraße 12a" &&
      v.city === "Musterstadt" &&
      v.zip === "12345" &&
      v.country === "276" &&
      v.mail === "erika@example.test",
    JSON.stringify([r, v]),
  );
  await p.close();
}

// 5. identity via inline menu
{
  const { p } = await openTab(SITE + "/address.html");
  await p.click("#vn");
  await p.waitForTimeout(1200);
  const m = menuFrame(p);
  const names = m ? await m.locator('[data-testid="inline-item"] b').allTextContents() : [];
  check("inline menu lists identities on address field", names.includes("Lieferadresse Test"), JSON.stringify(names));
  if (m) {
    await m.locator('[data-testid="inline-item"]', { hasText: "Lieferadresse Test" }).click();
    await p.waitForTimeout(800);
  }
  check("inline identity fill", (await p.inputValue("#ort")) === "Musterstadt" && (await p.inputValue("#hnr")) === "12a");
  await p.close();
}

// 6. generator in the inline menu on a registration form
{
  const { p } = await openTab(SITE + "/register.html");
  await p.click("#r-pw");
  await p.waitForTimeout(1200);
  const m = menuFrame(p);
  check("inline menu offers generated password on new-password field", !!m && (await m.locator('[data-testid="inline-generate"]').count()) === 1);
  let shown = "";
  if (m) {
    const first = await m.locator('[data-testid="inline-generated"]').textContent();
    await m.locator('[data-testid="inline-regenerate"]').click();
    // the inline menu re-arms after a re-render (clickjacking guard): wait past the arming delay
    await p.waitForTimeout(900);
    shown = await m.locator('[data-testid="inline-generated"]').textContent();
    check("regenerate gives a new password", shown && shown !== first && shown.length >= 14, first + " → " + shown);
    await p.screenshot({ path: `${SHOTS}/inline-generator.png` });
    await m.locator('[data-testid="inline-generate"]').click();
    await p.waitForTimeout(800);
  }
  check(
    "generated password filled into password + confirmation",
    !!shown && (await p.inputValue("#r-pw")) === shown && (await p.inputValue("#r-pw2")) === shown && (await p.inputValue("#r-mail")) === "",
  );
  await p.close();
}

// 7. context menu "generate password" + Ctrl+Shift+9 into the focused field
{
  const { p, tabId } = await openTab(SITE + "/register.html");
  await p.click("#r-pw");
  await p.keyboard.press("Escape");
  const tab = await sw.evaluate((id) => chrome.tabs.get(id), tabId);
  await sw.evaluate(([t]) => globalThis.__mwTest.menus.click("mw-gen", t, { frameId: 0, editable: true }), [tab]);
  await p.waitForTimeout(500);
  const a = await p.inputValue("#r-pw");
  check("context menu generator fills focused new-password form", a.length >= 14 && (await p.inputValue("#r-pw2")) === a, a);
  await p.bringToFront();
  await p.click("#r-pw2");
  await sw.evaluate(() => globalThis.__mwTest.menus.command("generate_password"));
  await p.waitForTimeout(500);
  const b = await p.inputValue("#r-pw");
  check("shortcut generator replaces both passwords", b.length >= 14 && b !== a && (await p.inputValue("#r-pw2")) === b, a + " / " + b);
  await p.close();
}

// 8. shortcuts / context menu for cards and identities
{
  const { p, tabId } = await openTab(SITE + "/address.html");
  await p.bringToFront();
  await rpc("markUsed", { accountKey, itemId: ident.id });
  await sw.evaluate(() => globalThis.__mwTest.menus.command("autofill_identity"));
  await p.waitForTimeout(600);
  check("shortcut fills the most recently used identity", (await p.inputValue("#nn")) === "Mustermann");
  await p.close();
  const c = await openTab(SITE + "/checkout.html");
  const tab = await sw.evaluate((id) => chrome.tabs.get(id), c.tabId);
  await sw.evaluate(([t, id]) => globalThis.__mwTest.menus.click(id, t, { frameId: 0 }), [tab, `mw-fc|${accountKey}|${card.id}`]);
  await c.p.waitForTimeout(600);
  const pay = c.p.frames().find((f) => f.url().includes("payframe"));
  check(
    "context menu fills the card in the clicked frame only",
    (await c.p.inputValue("#ccnum")) === "4111111111111111" && (await pay.inputValue("#pf-num")) === "",
  );
  const errs = await sw.evaluate(async () => {
    await globalThis.__mwTest.rebuildContextMenu();
    await new Promise((r) => setTimeout(r, 300));
    return globalThis.__mwTest.menuErrors;
  });
  check("context menu with submenus builds without errors", errs.length === 0, JSON.stringify(errs));
  await c.p.close();
}

// 9. autofill on page load
{
  vault = await rpc("getVault");
  const matches = (await rpc("getPageMatches", { url: SITE + "/login.html" })).itemIds;
  const byKey = (k) => vault.items.find((i) => i.accountKey + "::" + i.id === k);
  const first = byKey(matches[0]);
  await settings({ autofillOnPageLoad: true, autofillOnPageLoadDefault: true });
  let { p } = await openTab(SITE + "/login.html");
  await p.waitForTimeout(800);
  check(
    "page-load fill uses the most recently used match",
    (await p.inputValue("#u")) === first.login.username && (await p.inputValue("#p")) === first.login.password,
    (await p.inputValue("#u")) + " vs " + first.login.username,
  );
  await p.close();
  // opt the item out → the next match is used
  const r = await rpc("saveItem", { accountKey: first.accountKey, item: { ...first, login: { ...first.login, autofillOnPageLoad: false } }, isNew: false });
  check("item opt-out saved", r.ok, JSON.stringify(r));
  ({ p } = await openTab(SITE + "/login.html"));
  await p.waitForTimeout(800);
  const u = await p.inputValue("#u");
  check("page-load fill skips opted-out item", u !== "" && u !== first.login.username, u);
  await p.close();
  await rpc("saveItem", { accountKey: first.accountKey, item: { ...first, login: { ...first.login, autofillOnPageLoad: null } }, isNew: false });
  // no page-load fill when the default is "off"
  await settings({ autofillOnPageLoadDefault: false });
  ({ p } = await openTab(SITE + "/login.html"));
  await p.waitForTimeout(800);
  check("default off → no page-load fill", (await p.inputValue("#u")) === "");
  await p.close();
  // registration forms are never filled on load
  await settings({ autofillOnPageLoadDefault: true });
  ({ p } = await openTab(SITE + "/register.html"));
  await p.waitForTimeout(800);
  check("registration form not filled on load", (await p.inputValue("#r-pw")) === "");
  await p.close();
  await settings({ autofillOnPageLoad: false });
}

// 10. icon mode
{
  await settings({ inlineMenuOnIcon: true });
  const { p } = await openTab(SITE + "/login.html");
  await p.click("#u");
  await p.waitForTimeout(800);
  check("icon mode: no menu on focus", !menuFrame(p));
  const box = await p.evaluate(() => {
    const r = document.querySelector("mw-inline-button")?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  check("icon mode: icon shown in the field", !!box);
  if (box) {
    await p.mouse.click(box.x, box.y);
    await p.waitForTimeout(1200);
  }
  check("icon mode: click opens the menu", !!menuFrame(p));
  await p.screenshot({ path: `${SHOTS}/inline-icon.png`, clip: { x: 250, y: 40, width: 500, height: 340 } });
  await p.close();
  await settings({ inlineMenuOnIcon: false });
}

// 11. data-bwignore
{
  vault = await rpc("getVault");
  const login = vault.items.find((i) => i.name === "Test-Login (privat)");
  let { p, tabId } = await openTab(SITE + "/ignore.html");
  let r = await rpc("autofill", { accountKey: login.accountKey, itemId: login.id, tabId });
  check("without honoring: data-bwignore field filled", r.ok && (await p.inputValue("#u")) === login.login.username);
  await p.close();
  await settings({ honorBwIgnore: true });
  ({ p, tabId } = await openTab(SITE + "/ignore.html"));
  r = await rpc("autofill", { accountKey: login.accountKey, itemId: login.id, tabId });
  check(
    "honoring data-bwignore: only the password",
    r.ok && (await p.inputValue("#u")) === "" && (await p.inputValue("#p")) === login.login.password,
    JSON.stringify(r),
  );
  await p.close();
  await settings({ honorBwIgnore: false });
}

// 12. HTTP Basic authentication (unanswered challenges end in 401 / ERR_INVALID_AUTH_CREDENTIALS headless)
{
  const nav = async (p, url) => {
    try {
      return (await p.goto(url)).status();
    } catch (e) {
      return /ERR_INVALID_AUTH_CREDENTIALS/.test(e.message) ? "unanswered" : e.message;
    }
  };
  const unanswered = (s) => s === 401 || s === "unanswered";
  const p = await ctx.newPage();
  let st = await nav(p, "http://127.0.0.1:9000/basic0/");
  check("basic auth: no login → not answered", unanswered(st), String(st));
  await create(
    base(1, "Basic-Test", { login: { username: "basic-user", password: "basic-pw", uris: [{ uri: "http://127.0.0.1:9000/basic/" }], passkeys: 0 } }),
  );
  st = await nav(p, "http://127.0.0.1:9000/basic1/");
  check("basic auth answered with the one matching login", st === 200 && (await p.locator("#ok").count()) === 1, String(st));
  await settings({ basicAuth: false });
  const p2 = await ctx.newPage();
  st = await nav(p2, "http://127.0.0.1:9000/basic2/");
  check("basic auth off → not answered", unanswered(st), String(st));
  await settings({ basicAuth: true });
  // two matches → ambiguous → not answered
  await create(base(1, "Basic-Test 2", { login: { username: "other", password: "x", uris: [{ uri: "http://127.0.0.1:9000" }], passkeys: 0 } }));
  const p3 = await ctx.newPage();
  st = await nav(p3, "http://127.0.0.1:9000/basic3/");
  check("basic auth with two matches not answered", unanswered(st), String(st));
  await p.close();
  await p2.close();
  await p3.close();
}

// 13. "Neuer Login" in the inline menu opens the editor with the page prefilled
{
  const { p } = await openTab(SITE + "/login.html");
  await p.click("#u");
  await p.waitForTimeout(1200);
  const m = menuFrame(p);
  const popupPromise = ctx.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  if (m) await m.locator('[data-testid="inline-new"]').click();
  const pop = await popupPromise;
  if (pop) await pop.waitForLoadState();
  check("inline 'Neuer Login' opens the editor window", !!pop && pop.url().includes("add=1") && pop.url().includes("uri="), pop?.url());
  if (pop) {
    await pop.waitForSelector('[data-testid="save"]', { timeout: 8000 }).catch(() => {});
    const vals = await pop.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => i.value));
    check("editor prefilled with the page URL", vals.some((v) => v.includes("localhost:9000/login.html")), JSON.stringify(vals));
    await pop.close();
  }
  await p.close();
}

// 14. blocked domains: no inline menu, no save prompt, no page-load fill
{
  await settings({ blockedDomains: ["localhost"], autofillOnPageLoad: true });
  const { p } = await openTab(SITE + "/login.html");
  await p.click("#u");
  await p.waitForTimeout(1200);
  check("blocked domain: no inline menu", !menuFrame(p));
  check("blocked domain: no page-load fill", (await p.inputValue("#u")) === "");
  await p.close();
  await settings({ blockedDomains: [], autofillOnPageLoad: false });
}

// 15. settings UI renders the new options (German)
{
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.waitForTimeout(400);
  check("settings: inline menu mode select", (await p.locator('[data-testid="inline-menu-mode"]').count()) === 1);
  await p.click('[data-testid="blocked-domains"]');
  await p.fill('[data-testid="blocked-input"]', "https://www.Beispiel.de/login");
  await p.click('[data-testid="blocked-add"]');
  await p.waitForTimeout(400);
  const st = await rpc("getState");
  check("blocked domain normalised and stored", JSON.stringify(st.settings.blockedDomains) === '["www.beispiel.de"]', JSON.stringify(st.settings.blockedDomains));
  await p.locator('[data-testid="blocked-list"]').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SHOTS}/settings-autofill.png`, fullPage: true });
  await settings({ blockedDomains: [] });
  await p.close();
}

// cleanup
vault = await rpc("getVault");
for (const i of vault.items.filter((x) => TEST_ITEMS.includes(x.name)))
  await rpc("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });
await ctx.close();
console.log(failed ? `${failed} FAILED` : "FILL E2E ALL PASSED");
process.exit(failed ? 1 : 0);
