// Browser test of release 1.2 item features: attachments upload/delete, clone, archive, folders,
// move to organization / collections, new item types, password exposure check, TOTP QR scan.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import QRCode from "qrcode";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = SP + "/shots";
const PW = "Test-Passwort-123!";
mkdirSync(SHOTS, { recursive: true });
const profile = SP + "/profile-items";
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
  locale: "de-DE",
  acceptDownloads: true,
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
const accountKey = vault.items.find((i) => i.name === "Visa Privat").accountKey;
const TEST = ["Anhang-Test", "Org-Move-Test", "Bank-Test", "Pass-Test", "FS-Test", "HIBP-Test"];
for (const i of vault.items.filter((x) => TEST.some((n) => x.name.startsWith(n))))
  await rpc("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });

const login = (name, extra = {}) => ({
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
  login: { username: name.toLowerCase() + "-user", password: name + "-pw!", uris: [{ uri: "https://example.org" }], passkeys: 0 },
  ...extra,
});
const create = async (item) => {
  const r = await rpc("saveItem", { accountKey, item, isNew: true });
  if (!r.ok) throw new Error(r.error);
  return r.item;
};
const reloadItem = async (id) => (await rpc("getVault")).items.find((i) => i.id === id);

async function popup(route = "") {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 640 });
  await p.goto(`chrome-extension://${extId}/popup.html${route}`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
async function openItem(p, name) {
  await p.fill('input[type="search"]', name).catch(() => {});
  await p.waitForTimeout(300);
  await p.locator(`[data-testid="item-row"][data-name="${name}"]`).first().click();
  await p.waitForSelector('[data-testid="detail-name"]');
}

// 1. attachments: upload in the UI, download, delete
{
  const item = await create(login("Anhang-Test"));
  const file = SP + "/anhang.txt";
  writeFileSync(file, "Geheimer Inhalt äöü " + "x".repeat(5000));
  const p = await popup();
  await openItem(p, "Anhang-Test");
  await p.setInputFiles('[data-testid="attachment-file"]', file);
  await p.waitForSelector('[data-testid="attachment"]', { timeout: 20000 }).catch(() => {});
  const att = (await reloadItem(item.id)).attachments;
  check("attachment uploaded via UI", att.length === 1 && att[0].fileName === "anhang.txt", JSON.stringify(att));
  await p.screenshot({ path: `${SHOTS}/items-attachment.png` });
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 15000 }), p.click('[data-testid="attachment-download"]')]);
  const got = readFileSync(await dl.path(), "utf8");
  check("uploaded attachment downloads and decrypts", got === readFileSync(file, "utf8"));
  // larger file through several chunks (RPC)
  const big = randomBytes(9 * 1024 * 1024 + 123);
  writeFileSync(SP + "/big.bin", big);
  await p.setInputFiles('[data-testid="attachment-file"]', SP + "/big.bin");
  for (let i = 0; i < 60 && (await reloadItem(item.id)).attachments.length < 2; i++) await sleep(500);
  const a2 = (await reloadItem(item.id)).attachments.find((a) => a.fileName === "big.bin");
  check("9 MB attachment uploaded (several chunks)", !!a2, JSON.stringify((await reloadItem(item.id)).attachments));
  if (a2) {
    const ok = await p.evaluate(
      async ([acc, id, attId, sha]) => {
        const d = await chrome.runtime.sendMessage({ rpc: "attachmentDownload", args: { accountKey: acc, itemId: id, attachmentId: attId } });
        const res = await fetch(d.data.url);
        const enc = new Uint8Array(await res.arrayBuffer());
        // decrypt with the returned key (AES-CBC + HMAC)
        const raw = Uint8Array.from(atob(d.data.key.k), (c) => c.charCodeAt(0));
        const ak = await crypto.subtle.importKey("raw", raw.slice(0, 32), "AES-CBC", false, ["decrypt"]);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: enc.slice(1, 17) }, ak, enc.slice(49)));
        const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", plain)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return h === sha;
      },
      [accountKey, item.id, a2.id, createHash("sha256").update(big).digest("hex")],
    );
    check("large attachment content intact", ok);
  }
  // delete the first one in the UI
  await p.locator('[data-testid="attachment-delete"]').first().click();
  await p.click('[data-testid="confirm-ok"]');
  for (let i = 0; i < 20 && (await reloadItem(item.id)).attachments.length !== 1; i++) await sleep(300);
  check("attachment deleted", (await reloadItem(item.id)).attachments.length === 1);
  await p.close();
}

// 2. clone + archive (item menu)
{
  const p = await popup();
  await openItem(p, "Anhang-Test");
  await p.click('[data-testid="detail-more"]');
  await p.click('[data-testid="menu-clone"]');
  await p.waitForSelector('[data-testid="edit-name"]');
  const name = await p.inputValue('[data-testid="edit-name"]');
  check("clone opens the editor with a copy", name === "Anhang-Test – Kopie", name);
  await p.click('[data-testid="save"]');
  await p.waitForSelector('[data-testid="detail-name"]');
  vault = await rpc("getVault");
  const copy = vault.items.find((i) => i.name === "Anhang-Test – Kopie");
  const orig = vault.items.find((i) => i.name === "Anhang-Test");
  check(
    "clone saved with same data, without attachments",
    copy && copy.id !== orig.id && copy.login.password === orig.login.password && copy.attachments.length === 0,
    JSON.stringify(copy?.attachments),
  );
  // archive the copy
  await p.click('[data-testid="detail-more"]');
  await p.click('[data-testid="menu-archive"]');
  await p.waitForTimeout(800);
  const archived = await reloadItem(copy.id);
  check("item archived", !!archived?.archivedDate, JSON.stringify(archived?.archivedDate));
  check("archived item shown as archived", (await p.locator('[data-testid="detail-archived"]').count()) === 1);
  const matches = await rpc("getPageMatches", { url: "https://example.org/" });
  check("archived item not offered for autofill", !matches.itemIds.includes(accountKey + "::" + copy.id));
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]');
  check("archived item hidden in the vault list", (await p.locator('[data-testid="item-row"][data-name="Anhang-Test – Kopie"]').count()) === 0);
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-archive"]');
  await p.waitForSelector('[data-testid="archive-row"]');
  await p.screenshot({ path: `${SHOTS}/items-archive.png` });
  await p.click('[data-testid="unarchive"]');
  await p.waitForTimeout(800);
  check("unarchived", !(await reloadItem(copy.id))?.archivedDate);
  await rpc("deleteItem", { accountKey, itemId: copy.id, permanent: true });
  await p.close();
}

// 3. folders: create, rename, delete
{
  const p = await popup();
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-folders"]');
  await p.waitForSelector('[data-testid="folder-account"]');
  await p.locator('[data-testid="folder-add"]').first().click();
  await p.fill('[role="dialog"] input', "Testordner E2E");
  await p.screenshot({ path: `${SHOTS}/items-folder-prompt.png` });
  await p.press('[role="dialog"] input', "Enter");
  await p.waitForSelector('[data-testid="folder-row"][data-name="Testordner E2E"]', { timeout: 10000 }).catch(() => {});
  vault = await rpc("getVault");
  const f = vault.folders.find((x) => x.name === "Testordner E2E");
  check("folder created", !!f && f.accountKey === vault.folders.find((x) => x.name === "Testordner E2E")?.accountKey);
  await p.locator('[data-testid="folder-row"][data-name="Testordner E2E"] [data-testid="folder-rename"]').click();
  await p.fill('[role="dialog"] input', "Umbenannt E2E");
  await p.press('[role="dialog"] input', "Enter");
  await p.waitForSelector('[data-testid="folder-row"][data-name="Umbenannt E2E"]', { timeout: 10000 }).catch(() => {});
  vault = await rpc("getVault");
  check("folder renamed", vault.folders.some((x) => x.id === f?.id && x.name === "Umbenannt E2E"));
  await p.screenshot({ path: `${SHOTS}/items-folders.png` });
  await p.locator('[data-testid="folder-row"][data-name="Umbenannt E2E"] [data-testid="folder-delete"]').click();
  await p.click('[data-testid="confirm-ok"]');
  await p.waitForTimeout(1000);
  vault = await rpc("getVault");
  check("folder deleted", !vault.folders.some((x) => x.id === f?.id));
  await p.close();
}

// 4. move a personal item into the organization, then change its collections
{
  const item = await create(login("Org-Move-Test"));
  const p = await popup();
  await openItem(p, "Org-Move-Test");
  await p.click('[data-testid="detail-more"]');
  await p.click('[data-testid="menu-move-org"]');
  await p.waitForSelector('[data-testid="assign-collections"]');
  await p.locator('[data-testid="assign-collections"] label', { hasText: "Gemeinsam" }).click();
  await p.screenshot({ path: `${SHOTS}/items-move-org.png` });
  await p.click('[data-testid="assign-save"]');
  await p.waitForTimeout(1200);
  vault = await rpc("getVault");
  const moved = vault.items.find((i) => i.id === item.id);
  const org = vault.organizations.find((o) => o.accountKey === accountKey);
  const gem = vault.collections.find((c) => c.accountKey === accountKey && c.name === "Gemeinsam");
  const str = vault.collections.find((c) => c.accountKey === accountKey && c.name === "Streaming");
  check(
    "item moved into the organization and still decryptable",
    moved?.organizationId === org?.id && moved.collectionIds.includes(gem.id) && moved.login.password === "Org-Move-Test-pw!" && !moved.decryptError,
    JSON.stringify(moved && { org: moved.organizationId, cols: moved.collectionIds, pw: moved.login.password }),
  );
  // a fresh sync (decrypt from server data) must give the same result
  await rpc("sync", { accountKey });
  const synced = await reloadItem(item.id);
  check("moved item survives a sync", synced?.login.password === "Org-Move-Test-pw!" && synced.organizationId === org?.id);
  const r = await rpc("setItemCollections", { accountKey, itemId: item.id, collectionIds: [gem.id, str.id] });
  const two = await reloadItem(item.id);
  check("collections changed", r.ok && two?.collectionIds.length === 2, JSON.stringify([r, two?.collectionIds]));
  await rpc("deleteItem", { accountKey, itemId: item.id, permanent: true });
  await p.close();
}

// 5. new item types
{
  const p = await popup();
  await p.click('[data-testid="add"]');
  await p.getByText("Bankkonto", { exact: true }).click();
  await p.waitForSelector('[data-testid="extra-fields"]');
  await p.fill('[data-testid="edit-name"]', "Bank-Test");
  await p.fill('input[name="field-bankName"]', "Sparkasse Test");
  await p.fill('input[name="field-iban"]', "DE02120300000000202051");
  await p.selectOption('[data-testid="field-accountType"]', "checking");
  await p.click('[data-testid="save"]');
  await p.waitForSelector('[data-testid="detail-name"]');
  await p.screenshot({ path: `${SHOTS}/items-bank.png` });
  vault = await rpc("getVault");
  const bank = vault.items.find((i) => i.name === "Bank-Test");
  check(
    "bank account created",
    bank?.type === 6 && bank.extra?.iban === "DE02120300000000202051" && bank.extra?.accountType === "checking" && bank.extra?.bankName === "Sparkasse Test",
    JSON.stringify(bank?.extra),
  );
  check("bank account detail shows translated account type", (await p.textContent("main")).includes("Girokonto"));
  const base = { ...login("x"), login: undefined };
  const pass = await create({
    ...base,
    type: 8,
    name: "Pass-Test",
    extra: { givenName: "Erika", surname: "Mustermann", passportNumber: "C01X00T47", dateOfBirth: "1964-08-12", nationality: "deutsch" },
  });
  const fs = await create({
    ...base,
    type: 7,
    name: "FS-Test",
    extra: { firstName: "Erika", lastName: "Mustermann", licenseNumber: "B072RRE2I55", licenseClass: "B, BE", expirationDate: "2033-01-19" },
  });
  await rpc("sync", { accountKey });
  const pass2 = await reloadItem(pass.id);
  const fs2 = await reloadItem(fs.id);
  check("passport round trip", pass2?.type === 8 && pass2.extra?.passportNumber === "C01X00T47" && pass2.extra?.dateOfBirth === "1964-08-12");
  check("driver's license round trip", fs2?.type === 7 && fs2.extra?.licenseClass === "B, BE");
  for (const i of [bank, pass, fs]) if (i) await rpc("deleteItem", { accountKey, itemId: i.id, permanent: true });
  await p.close();
}

// 6. password exposure check (k-anonymity request mocked)
{
  const item = await create(login("HIBP-Test", { login: { username: "u", password: "Passwort123", uris: [], passkeys: 0 } }));
  const sha1 = createHash("sha1").update("Passwort123").digest("hex").toUpperCase();
  let requested = "";
  await ctx.route("https://api.pwnedpasswords.com/range/*", (route) => {
    requested = route.request().url();
    route.fulfill({ status: 200, contentType: "text/plain", body: `0000000000000000000000000000000000A:3\r\n${sha1.slice(5)}:4711\r\n` });
  });
  const p = await popup();
  await openItem(p, "HIBP-Test");
  await p.click('[data-testid="exposed-run"]');
  await p.waitForSelector('[data-testid="exposed-result"]', { timeout: 10000 }).catch(() => {});
  const txt = (await p.locator('[data-testid="exposed-result"]').textContent().catch(() => "")) ?? "";
  check("exposed password reported", /4\.711/.test(txt), txt);
  check("only the hash prefix is sent", requested.endsWith("/range/" + sha1.slice(0, 5)), requested);
  await ctx.unroute("https://api.pwnedpasswords.com/range/*");
  await rpc("deleteItem", { accountKey, itemId: item.id, permanent: true });
  await p.close();
}

// 7. TOTP QR code scan from the visible tab
{
  const uri = "otpauth://totp/Beispiel:alex?secret=JBSWY3DPEHPK3PXP&issuer=Beispiel";
  const qr = await QRCode.toDataURL(uri, { width: 240, margin: 2 });
  const page = await ctx.newPage();
  // a real http page (screenshots of about:blank are not allowed)
  await page.goto("http://localhost:9000/welcome.html");
  await page.evaluate((src) => {
    document.body.innerHTML = '<h2 style="font-family:system-ui">2FA einrichten</h2><img id="qr">';
    document.getElementById("qr").src = src;
  }, qr);
  await page.waitForTimeout(300);
  await page.bringToFront();
  // editor in its own popup window (the action popup is not a tab)
  await sw.evaluate((u) => chrome.windows.create({ url: u, type: "popup", width: 400, height: 640 }), `chrome-extension://${extId}/popup.html?popout=1&add=1`);
  let pop;
  for (let i = 0; i < 40 && !pop; i++) {
    pop = ctx.pages().find((x) => x.url().includes("add=1"));
    if (!pop) await sleep(200);
  }
  await pop.waitForSelector('[data-testid="totp-scan"]', { timeout: 15000 });
  await page.bringToFront();
  await pop.click('[data-testid="totp-scan"]');
  await pop.waitForTimeout(1500);
  const v = await pop.inputValue('input[name="totp"]');
  check("TOTP QR code scanned from the page", v === uri, v);
  await pop.close();
  await page.close();
}

vault = await rpc("getVault");
for (const i of vault.items.filter((x) => TEST.some((n) => x.name.startsWith(n))))
  await rpc("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });
await ctx.close();
console.log(failed ? `${failed} FAILED` : "ITEMS E2E ALL PASSED");
process.exit(failed ? 1 : 0);
