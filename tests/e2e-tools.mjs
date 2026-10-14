// Browser test of release 1.2 tools: username generator (incl. forwarding service mock), generator
// history, vault export (json / csv / encrypted / password protected / zip) and import (re-import,
// browser CSV, KeePass XML).
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const SHOTS = SP + "/shots";
const PW = "Test-Passwort-123!";
mkdirSync(SHOTS, { recursive: true });
const profile = SP + "/profile-tools";
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
const keys = {};
for (const [base, email] of [
  ["http://localhost:8001", "alex@privat.test"],
  ["http://localhost:8002", "alex@firma.test"],
]) {
  const f = await rpc("loginStart", { server: "selfhosted", baseUrl: base, email, password: PW });
  check("login " + email, f.step === "done", JSON.stringify(f));
  keys[email] = f.accountKey;
  await rpc("loginAck");
}
const A = keys["alex@privat.test"];
const B = keys["alex@firma.test"];

async function popup(route = "") {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 640 });
  await p.goto(`chrome-extension://${extId}/popup.html${route}`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
const genValue = (p) => p.locator('[data-testid="generated"] .v').textContent();

// 1. username generator
{
  const p = await popup();
  await p.getByRole("button", { name: "Generator" }).click();
  await p.click('[data-testid="gen-mode-username"]');
  await p.selectOption('[data-testid="username-kind"]', "word");
  await p.waitForTimeout(200);
  let v = (await genValue(p)).trim();
  check("random word username", /^[a-z-]+\d{4}$/.test(v), v);
  await p.selectOption('[data-testid="username-kind"]', "plus");
  await p.fill('[data-testid="plus-email"]', "alex@example.org");
  await p.click('[data-testid="gen-regen"]');
  v = (await genValue(p)).trim();
  check("plus addressed email", /^alex\+[a-z0-9]{8}@example\.org$/.test(v), v);
  await p.selectOption('[data-testid="username-kind"]', "catchall");
  await p.fill('[data-testid="catchall-domain"]', "example.org");
  await p.click('[data-testid="gen-regen"]');
  v = (await genValue(p)).trim();
  check("catch-all email", /^[a-z0-9]{8}@example\.org$/.test(v), v);
  // forwarding service (SimpleLogin API, self-hosted base URL → local mock)
  await p.selectOption('[data-testid="username-kind"]', "forwarded");
  await p.selectOption('[data-testid="fwd-service"]', "simplelogin");
  await p.waitForSelector('input[name="fwd-token"]');
  await p.fill('input[name="fwd-token"]', "sl-test-token");
  await p.fill('[data-testid="fwd-baseUrl"]', "http://localhost:9000/mock-sl");
  await p.fill('[data-testid="gen-website"]', "https://www.shop.test/login");
  await p.click('[data-testid="fwd-create"]');
  await p.waitForTimeout(1200);
  v = (await genValue(p)).trim();
  check("forwarded alias from the service", v === "mock.www.shop.test@simplelogin.test", v);
  await p.screenshot({ path: `${SHOTS}/tools-forwarder.png` });
  const stored = await rpc("forwarderSettings");
  check("forwarder token stored", stored.forwarders.simplelogin?.token === "sl-test-token");
  const raw = await sw.evaluate(async (k) => (await chrome.storage.local.get("secretStore:" + k))["secretStore:" + k], A);
  check("forwarder token encrypted at rest", typeof raw === "string" && /^2\./.test(raw) && !raw.includes("sl-test-token"), String(raw).slice(0, 30));
  // copy → history
  await p.click('[data-testid="gen-mode-password"]');
  await p.waitForTimeout(200);
  const pw = (await genValue(p)).trim();
  await p.click('[data-testid="gen-copy"]');
  await p.waitForTimeout(400);
  const h = await rpc("generatorHistory");
  check(
    "history contains copied password and created alias",
    h.history[0]?.value === pw && h.history.some((x) => x.value === "mock.www.shop.test@simplelogin.test" && x.kind === "email"),
    JSON.stringify(h.history.slice(0, 3)),
  );
  // history survives locking one account (copy of the other account)
  await rpc("lock", { accountKey: A });
  const h2 = await rpc("generatorHistory");
  check("history available while one account is locked", !h2.locked && h2.history[0]?.value === pw);
  await rpc("unlock", { password: PW, accountKeys: [A] });
  await p.click('[data-testid="gen-history"]');
  await p.waitForSelector('[data-testid="history-row"]');
  await p.screenshot({ path: `${SHOTS}/tools-history.png` });
  await p.click('[data-testid="history-clear"]');
  await p.click('[data-testid="confirm-ok"]');
  await p.waitForTimeout(600);
  check("history cleared", (await rpc("generatorHistory")).history.length === 0);
  await p.close();
}

// prepare: an attachment in account A for the zip export
let vault = await rpc("getVault");
for (const i of vault.items.filter((x) => x.name.startsWith("Export-Anhang") || x.name.startsWith("CSV-Import") || x.name.startsWith("KP-")))
  await rpc("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });
const att = await rpc("saveItem", {
  accountKey: A,
  isNew: true,
  item: {
    id: "",
    accountKey: A,
    type: 2,
    name: "Export-Anhang",
    notes: "mit Datei",
    favorite: false,
    reprompt: 0,
    edit: true,
    viewPassword: true,
    collectionIds: [],
    fields: [],
    passwordHistory: [],
    attachments: [],
    secureNote: { type: 0 },
  },
});
{
  const { id } = await rpc("attachmentUploadStart", { accountKey: A, itemId: att.item.id, fileName: "hallo.txt", size: 11 });
  await rpc("attachmentUploadChunk", { id, data: Buffer.from("Hallo Welt!").toString("base64") });
  await rpc("attachmentUploadFinish", { id });
}
vault = await rpc("getVault");
const personalA = vault.items.filter((i) => i.accountKey === A && !i.organizationId && !i.deletedDate);

async function exportVia(p, format, opts = {}) {
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]');
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-export"]');
  await p.waitForSelector('[data-testid="export-format"]');
  if (opts.account) await p.selectOption('[data-testid="export-account"]', opts.account);
  await p.selectOption('[data-testid="export-format"]', format);
  if (opts.filePassword) {
    await p.click('[data-testid="enc-password"]');
    await p.fill('input[name="file-password"]', opts.filePassword);
    await p.fill('input[name="file-password2"]', opts.filePassword);
  }
  await p.fill('input[name="export-secret"]', opts.secret ?? PW);
  if (opts.expectError) {
    await p.click('[data-testid="export-run"]');
    await p.waitForTimeout(1500);
    return (await p.locator(".banner.error").textContent().catch(() => "")) ?? "";
  }
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click('[data-testid="export-run"]')]);
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

// 2. exports
const p = await popup();
{
  const err = await exportVia(p, "json", { secret: "falsch", expectError: true });
  check("export refuses a wrong master password", /Master-Passwort/.test(err), err);
  const j = await exportVia(p, "json");
  const doc = JSON.parse(j.bytes.toString("utf8"));
  check(
    "unencrypted JSON export",
    doc.encrypted === false && doc.items.length === personalA.length && doc.items.every((i) => !i.organizationId) && j.name.endsWith(".json"),
    `${doc.items?.length} vs ${personalA.length}`,
  );
  const visa = doc.items.find((i) => i.name === "Visa Privat");
  check("card data in clear text", visa?.card?.number === "4111111111111111", JSON.stringify(visa?.card));
  writeFileSync(SP + "/export.json", j.bytes);
  const c = await exportVia(p, "csv");
  const lines = c.bytes.toString("utf8").split(/\r\n/);
  check(
    "CSV export (logins + notes)",
    lines[0] === "folder,favorite,type,name,notes,fields,reprompt,archivedDate,login_uri,login_username,login_password,login_totp" &&
      lines.length - 1 === personalA.filter((i) => i.type === 1 || i.type === 2).length,
    lines[0] + " / " + (lines.length - 1),
  );
  const e = await exportVia(p, "encrypted_json");
  const edoc = JSON.parse(e.bytes.toString("utf8"));
  check(
    "account-restricted export is encrypted",
    edoc.encrypted === true && !edoc.passwordProtected && edoc.items.length === personalA.length && /^2\./.test(edoc.items[0].name),
  );
  writeFileSync(SP + "/export-enc.json", e.bytes);
  const pp = await exportVia(p, "encrypted_json", { filePassword: "Datei-Passwort-1" });
  const pdoc = JSON.parse(pp.bytes.toString("utf8"));
  check("password-protected export", pdoc.passwordProtected === true && typeof pdoc.data === "string" && !!pdoc.salt);
  writeFileSync(SP + "/export-pw.json", pp.bytes);
  const z = await exportVia(p, "zip");
  const files = unzipSync(new Uint8Array(z.bytes));
  check(
    "zip export with attachments",
    !!files["data.json"] && strFromU8(files["attachments/Export-Anhang/hallo.txt"] ?? new Uint8Array()) === "Hallo Welt!",
    Object.keys(files).join(","),
  );
}

async function importVia(file, opts = {}) {
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]');
  await p.getByRole("button", { name: "Einstellungen" }).click();
  await p.click('[data-testid="open-import"]');
  await p.waitForSelector('[data-testid="import-format"]');
  if (opts.account) await p.selectOption('[data-testid="import-account"]', opts.account);
  if (opts.format) await p.selectOption('[data-testid="import-format"]', opts.format);
  await p.setInputFiles('[data-testid="import-file"]', file);
  await p.waitForSelector('[data-testid="import-summary"]', { timeout: 5000 }).catch(() => {});
  const summary = (await p.locator('[data-testid="import-summary"]').textContent().catch(() => "")) ?? "";
  if (opts.filePassword) await p.fill('input[name="import-file-password"]', opts.filePassword);
  if (opts.folder) await p.fill('input[placeholder="Ordnername"]', opts.folder);
  if (opts.shot) await p.screenshot({ path: `${SHOTS}/${opts.shot}.png` });
  await p.click('[data-testid="import-run"]');
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if ((await p.locator('[data-testid="import-run"]').count()) === 0) break;
    const err = await p.locator(".banner.error").textContent().catch(() => null);
    if (err) return { summary, error: err };
  }
  return { summary };
}

// 3. imports
{
  const countB = () => rpc("getVault").then((v) => v.items.filter((i) => i.accountKey === B && !i.deletedDate && !i.organizationId).length);
  const beforeB = await countB();
  // password-protected export of A → account B
  const r1 = await importVia(SP + "/export-pw.json", { account: B, filePassword: "Datei-Passwort-1", shot: "tools-import" });
  const afterB = await countB();
  check("password-protected export imported into another account", !r1.error && afterB - beforeB === personalA.length, JSON.stringify(r1) + ` ${beforeB}→${afterB}`);
  vault = await rpc("getVault");
  const visaB = vault.items.find((i) => i.accountKey === B && i.name === "Visa Privat");
  check("imported card decrypts", visaB?.card?.number === "4111111111111111");
  const folderB = vault.folders.filter((f) => f.accountKey === B).map((f) => f.name);
  check("folders imported", vault.items.some((i) => i.accountKey === B && i.folderId && i.name === "Sparkasse") && folderB.length > 0, JSON.stringify(folderB));
  // account-restricted export into the wrong account is refused
  const r2 = await importVia(SP + "/export-enc.json", { account: B });
  check("account-restricted export refused for another account", /anderen Konto/.test(r2.error ?? ""), JSON.stringify(r2));
  // … and accepted by its own account
  const beforeA = (await rpc("getVault")).items.filter((i) => i.accountKey === A && !i.deletedDate && !i.organizationId).length;
  const r3 = await importVia(SP + "/export-enc.json", { account: A, folder: "Wiederhergestellt" });
  vault = await rpc("getVault");
  const afterA = vault.items.filter((i) => i.accountKey === A && !i.deletedDate && !i.organizationId).length;
  check("account-restricted export re-imported", !r3.error && afterA - beforeA === personalA.length, JSON.stringify(r3) + ` ${beforeA}→${afterA}`);
  const restoredFolder = vault.folders.find((f) => f.accountKey === A && f.name === "Wiederhergestellt");
  check("import into folder", !!restoredFolder && vault.items.some((i) => i.folderId === restoredFolder.id));
  // Chrome CSV
  writeFileSync(
    SP + "/chrome.csv",
    "name,url,username,password,note\r\nCSV-Import Shop,https://shop.example/login,kunde@example.org,\"pa,ss\"\"wort\",Notiz 1\r\n,https://forum.example,forist,geheim,\r\n",
  );
  const r4 = await importVia(SP + "/chrome.csv", { account: A });
  vault = await rpc("getVault");
  const shop = vault.items.find((i) => i.name === "CSV-Import Shop");
  const forum = vault.items.find((i) => i.accountKey === A && i.login?.username === "forist");
  check(
    "browser CSV import",
    /2 Einträge erkannt/.test(r4.summary) && shop?.login.password === 'pa,ss"wort' && shop.login.uris[0].uri === "https://shop.example/login" && forum?.name === "forum.example",
    JSON.stringify([r4.summary, shop?.login, forum?.name]),
  );
  // KeePass 2 XML
  writeFileSync(
    SP + "/keepass.xml",
    `<?xml version="1.0" encoding="utf-8"?><KeePassFile><Root><Group><Name>Datenbank</Name>
<Group><Name>Banken</Name><Entry><String><Key>Title</Key><Value>KP-Bank</Value></String><String><Key>UserName</Key><Value>kpuser</Value></String>
<String><Key>Password</Key><Value ProtectInMemory="True">kp-geheim</Value></String><String><Key>URL</Key><Value>https://bank.example</Value></String>
<String><Key>PIN</Key><Value ProtectInMemory="True">1234</Value></String></Entry></Group></Group></Root></KeePassFile>`,
  );
  const r5 = await importVia(SP + "/keepass.xml", { account: A });
  vault = await rpc("getVault");
  const kp = vault.items.find((i) => i.name === "KP-Bank");
  const kpFolder = kp && vault.folders.find((f) => f.id === kp.folderId);
  check(
    "KeePass XML import (group → folder, protected field hidden)",
    !r5.error && kp?.login.password === "kp-geheim" && kpFolder?.name === "Banken" && kp.fields[0]?.name === "PIN" && kp.fields[0].type === 1,
    JSON.stringify([r5, kp?.fields, kpFolder?.name]),
  );
}
await p.close();

// (the servers are reset before the next test run)
await ctx.close();
console.log(failed ? `${failed} FAILED` : "TOOLS E2E ALL PASSED");
process.exit(failed ? 1 : 0);
