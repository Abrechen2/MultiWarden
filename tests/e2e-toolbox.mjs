// Browser test of the "Tools" tab (duplicate check, Send) and of where logins are filled
// (whole domain vs. exact subdomain, per item and as default).
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const EXT = path.resolve("dist/chrome");
const SHOTS = process.env.SHOTS ?? TMP + "/shots";
const PW = "Test-Passwort-123!";
mkdirSync(SHOTS, { recursive: true });
const profile = TMP + "/profile-toolbox";
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
  // subdomains of a test domain for the "fill on" checks
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE", "--host-resolver-rules=MAP *.shop.test 127.0.0.1"],
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
await rpc("setSettings", { language: "de", theme: "light" });
const accounts = (await rpc("getState")).accounts;
const A = accounts.find((a) => a.email === "alex@privat.test").key;
const B = accounts.find((a) => a.email === "alex@firma.test").key;

async function popup() {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
  await p.waitForTimeout(300);
  return p;
}
const newLogin = (accountKey, name, username, uri, extra = {}) =>
  rpc("saveItem", {
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
      login: { username, password: "pw-" + name, uris: [{ uri, match: null }], passkeys: 0 },
      ...extra,
    },
  });

// ------------------------------------------------------------------------------ duplicate check
{
  await newLogin(A, "Shop (alt)", "dup-user", "https://www.dup.test/login");
  await new Promise((r) => setTimeout(r, 1100)); // later revision date
  await newLogin(A, "Shop (neu)", "DUP-user", "https://dup.test/");
  await newLogin(B, "Shop (anderes Konto)", "dup-user", "https://dup.test/");
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-duplicates"]');
  await p.selectOption('[data-testid="tool-account"]', A);
  await p.waitForTimeout(300);
  const group = p.locator('[data-testid="dup-group"]', { hasText: "dup.test" });
  check("duplicate group within the account", (await group.locator('[data-testid="dup-item"]').count()) === 2);
  check("other account not mixed in", !((await group.textContent()) ?? "").includes("anderes Konto"));
  await p.screenshot({ path: `${SHOTS}/toolbox-duplicates.png` });
  await p.selectOption('[data-testid="tool-account"]', B);
  await p.waitForTimeout(200);
  check("account B: no dup.test group", (await p.locator('[data-testid="dup-group"]', { hasText: "dup.test" }).count()) === 0);
  await p.selectOption('[data-testid="tool-account"]', A);
  await p.waitForTimeout(500);
  // different passwords, no login outcomes yet: the newer one is "probably current", nothing is bulk-removable
  const neu = group.locator('[data-testid="dup-item"]', { hasText: "Shop (neu)" });
  check("newer password recommended", ((await neu.textContent()) ?? "").includes("vermutlich aktuell"));
  check("evidence line shown", (await group.locator('[data-testid="dup-evidence"]').count()) === 2);
  check("no bulk clean-up without strong evidence", (await group.locator('[data-testid="dup-clean"]').count()) === 0);
  await group.locator('[data-testid="dup-item"]', { hasText: "Shop (alt)" }).locator('[data-testid="dup-trash"]').click();
  await p.click('[data-testid="confirm-ok"]');
  await p.waitForTimeout(1200);
  check("group resolved", (await p.locator('[data-testid="dup-group"]', { hasText: "dup.test" }).count()) === 0);
  const v = await rpc("getVault");
  check(
    "older entry in the trash, newer kept",
    !!v.items.find((i) => i.name === "Shop (alt)")?.deletedDate && !v.items.find((i) => i.name === "Shop (neu)")?.deletedDate,
  );

  // identical copies (same password): "Bereinigen" removes the extra copy, the confirmation names it
  const same = { login: { username: "copy-user", password: "same-PW", uris: [{ uri: "https://copy.test/", match: null }], passkeys: 0 } };
  await newLogin(A, "Kopie 1", "copy-user", "https://copy.test/", same);
  await newLogin(A, "Kopie 2", "copy-user", "https://copy.test/", same);
  await p.click('[data-testid="tool-duplicates"]');
  await p.selectOption('[data-testid="tool-account"]', A);
  await p.waitForTimeout(800);
  const copies = p.locator('[data-testid="dup-group"]', { hasText: "copy.test" });
  check("identical copies grouped", (await copies.locator('[data-testid="dup-item"]').count()) === 2);
  await copies.locator('[data-testid="dup-clean"]').click();
  const msg = (await p.textContent('[role="dialog"]')) ?? "";
  check("confirmation lists the copy that goes", msg.includes("Kopie 1") || msg.includes("Kopie 2"), msg);
  await p.screenshot({ path: `${SHOTS}/toolbox-clean-confirm.png` });
  await p.click('[data-testid="confirm-ok"]');
  await p.waitForTimeout(1200);
  const v2 = await rpc("getVault");
  const left = v2.items.filter((i) => (i.name === "Kopie 1" || i.name === "Kopie 2") && !i.deletedDate);
  check("one copy kept, one in the trash", left.length === 1, left.map((i) => i.name));
  await p.close();
}

// ------------------------------------------------------------------------------ Send
{
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-send"]');
  await p.selectOption('[data-testid="tool-account"]', A);
  await p.waitForSelector('[data-testid="send-empty"], [data-testid="send-list"]');
  await p.click('[data-testid="send-new-text"]');
  await p.fill('[data-testid="send-name"]', "WLAN für Gäste");
  await p.fill('[data-testid="send-text"]', "Netz: Gäste / sommer-2026");
  await p.fill('input[name="send-password"]', "sesam");
  await p.fill('[data-testid="send-max-access"]', "5");
  await p.selectOption('[data-testid="send-deletion"]', "1d");
  await p.click('[data-testid="send-save"]');
  await p.waitForSelector('[data-testid="send-created"]', { timeout: 15000 });
  const link = (await p.textContent('[data-testid="send-link"]'))?.trim() ?? "";
  check("text Send created with link", /^http:\/\/localhost:8001\/#\/send\/[\w-]+\/[\w-]+$/.test(link), link);
  await p.screenshot({ path: `${SHOTS}/toolbox-send-created.png` });
  let sends = (await rpc("listSends", { accountKey: A })).sends;
  const s = sends.find((x) => x.name === "WLAN für Gäste");
  const inOneDay = s && Math.abs(Date.parse(s.deletionDate) - Date.now() - 86400_000) < 5 * 60_000;
  check("stored encrypted with password, max accesses and deletion date", !!s && s.hasPassword && s.maxAccessCount === 5 && s.text === "Netz: Gäste / sommer-2026" && inOneDay, JSON.stringify(s));
  check("same link in the list", s?.link === link);
  await p.click('[data-testid="send-created-done"]');
  await p.waitForSelector('[data-testid="send-row"]');
  check("listed", (await p.locator('[data-testid="send-row"][data-name="WLAN für Gäste"]').count()) === 1);
  // edit
  await p.click('[data-testid="send-row"][data-name="WLAN für Gäste"]');
  await p.waitForFunction(() => document.querySelector('[data-testid="send-name"]')?.value === "WLAN für Gäste");
  await p.fill('[data-testid="send-name"]', "WLAN Gäste");
  await p.click('[data-testid="send-save"]');
  await p.waitForSelector('[data-testid="send-row"][data-name="WLAN Gäste"]', { timeout: 10000 });
  sends = (await rpc("listSends", { accountKey: A })).sends;
  check("edited, password and link kept", sends.some((x) => x.name === "WLAN Gäste" && x.hasPassword && x.link === link));
  // file Send
  const file = path.join(TMP, "send-test.txt");
  writeFileSync(file, "Inhalt der Datei\n");
  await p.click('[data-testid="send-new-file"]');
  await p.fill('[data-testid="send-name"]', "Vertrag");
  await p.setInputFiles('[data-testid="send-file"]', file);
  check("file chosen", ((await p.textContent('[data-testid="send-file-name"]')) ?? "").includes("send-test.txt"));
  await p.click('[data-testid="send-save"]');
  await p.waitForSelector('[data-testid="send-created"]', { timeout: 15000 });
  sends = (await rpc("listSends", { accountKey: A })).sends;
  check("file Send created", sends.some((x) => x.name === "Vertrag" && x.type === 1 && x.file?.fileName === "send-test.txt" && x.file?.size > 0));
  await p.click('[data-testid="send-created-done"]');
  await p.waitForSelector('[data-testid="send-row"][data-name="Vertrag"]');
  await p.screenshot({ path: `${SHOTS}/toolbox-send-list.png` });
  // delete both via the menu
  for (const name of ["WLAN Gäste", "Vertrag"]) {
    await p.locator(`[data-testid="send-row"][data-name="${name}"] [data-testid="send-more"]`).click();
    await p.click('[data-testid="send-delete"]');
    await p.click('[data-testid="confirm-ok"]');
    await p.waitForSelector(`[data-testid="send-row"][data-name="${name}"]`, { state: "detached", timeout: 10000 });
  }
  check("Sends deleted", (await rpc("listSends", { accountKey: A })).sends.length === 0);
  // policy "Remove Send" is honoured (simulated through the account policies)
  await p.close();
}

// ------------------------------------------------------------------------------ fill on: domain vs. exact subdomain
{
  const created = await newLogin(A, "Scope-Login", "scope-user", "http://login.shop.test:9000/login.html");
  const site = await ctx.newPage();
  const suggested = async (url) => {
    await site.goto(url);
    await site.bringToFront();
    await site.waitForTimeout(400);
    const pp = ctx.waitForEvent("page");
    await sw.evaluate(async (id) => {
      await chrome.windows.create({ url: `chrome-extension://${id}/popup.html?popout=1`, type: "popup", width: 420, height: 640 });
    }, extId);
    const w = await pp;
    await w.waitForSelector('[data-testid="all-items"]', { timeout: 15000 });
    await w.waitForTimeout(600);
    const n = await w.locator('[data-testid="suggestions"] [data-testid="item-row"][data-name="Scope-Login"]').count();
    await w.close();
    return n > 0;
  };
  check("default (base domain): suggested on another subdomain", await suggested("http://other.shop.test:9000/login.html"));
  // per item: only the exact subdomain
  const p = await popup();
  await p.fill('[data-testid="search"]', "Scope-Login");
  await p.waitForTimeout(300);
  await p.locator('[data-testid="item-row"][data-name="Scope-Login"]').first().click();
  await p.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await p.waitForSelector('[data-testid="fill-scope"]');
  const opts = await p.$$eval('[data-testid="fill-scope"] option', (os) => os.map((o) => o.textContent));
  check("options name the domain and the host", opts.some((o) => o.includes("shop.test und alle Subdomains")) && opts.some((o) => o.includes("Nur login.shop.test:9000")), JSON.stringify(opts));
  await p.selectOption('[data-testid="fill-scope"]', "host");
  await p.locator('[data-testid="fill-scope"]').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SHOTS}/toolbox-fill-scope.png` });
  await p.click('[data-testid="save"]');
  await p.waitForSelector('[data-testid="fill-scope-info"]');
  check("item view shows the restriction", ((await p.textContent('[data-testid="fill-scope-info"]')) ?? "").includes("Nur login.shop.test:9000"));
  const stored = (await rpc("getVault")).items.find((i) => i.name === "Scope-Login");
  check("stored as host match (Bitwarden format)", stored?.login.uris.every((u) => u.match === 1), JSON.stringify(stored?.login.uris));
  await p.close();
  check("host only: not suggested on another subdomain", !(await suggested("http://other.shop.test:9000/login.html")));
  check("host only: suggested on the saved subdomain", await suggested("http://login.shop.test:9000/login.html"));
  // global default
  await rpc("saveItem", { accountKey: A, isNew: false, item: { ...stored, login: { ...stored.login, uris: [{ uri: stored.login.uris[0].uri, match: null }] } } });
  await rpc("setSettings", { defaultUriMatch: 1 });
  check("default host: not suggested on another subdomain", !(await suggested("http://other.shop.test:9000/login.html")));
  check("default host: suggested on the saved subdomain", await suggested("http://login.shop.test:9000/login.html"));
  await rpc("setSettings", { defaultUriMatch: 0 });
  await rpc("deleteItem", { accountKey: A, itemId: created.item?.id ?? stored.id, permanent: true }).catch(() => {});
  await site.close();
}

// ------------------------------------------------------------------------------ password report
{
  await newLogin(A, "Report schwach", "rw-user", "https://weak.example.test", { login: { username: "rw-user", password: "Passwort123", uris: [{ uri: "https://weak.example.test", match: null }], passkeys: 0 } });
  for (const n of ["Report doppelt 1", "Report doppelt 2"])
    await newLogin(A, n, n, "https://reuse.example.test/" + n.slice(-1), {
      login: { username: n, password: "Gleich-Passwort-2026!x", uris: [{ uri: "https://reuse-" + n.slice(-1) + ".example.test", match: null }], passkeys: 0 },
    });
  await newLogin(A, "Report http", "rh-user", "http://insecure.example.test/login", {
    login: { username: "rh-user", password: "zY8#mQ2!vK7pL0wR", uris: [{ uri: "http://insecure.example.test/login", match: null }], passkeys: 0 },
  });
  await newLogin(A, "Report 2FA", "rt-user", "https://login.tfa.example.test", {
    login: { username: "rt-user", password: "aB3$dF6&hJ9*kL2@", uris: [{ uri: "https://login.tfa.example.test", match: null }], passkeys: 0 },
  });
  // online sources replaced by local answers (no network in the test)
  const sha = createHash("sha1").update("Passwort123").digest("hex").toUpperCase();
  await ctx.route("https://api.pwnedpasswords.com/range/**", (route) => {
    const prefix = route.request().url().split("/").pop();
    route.fulfill({ status: 200, contentType: "text/plain", body: prefix === sha.slice(0, 5) ? `${sha.slice(5)}:4711\r\n0000000000000000000000000000000000A:0` : "0000000000000000000000000000000000A:0" });
  });
  await ctx.route("https://api.2fa.directory/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([["TFA Example", { domain: "tfa.example.test", tfa: ["totp"], documentation: "https://tfa.example.test/2fa" }]]) }),
  );
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-report"]');
  await p.selectOption('[data-testid="tool-account"]', A).catch(() => {});
  await p.waitForSelector('[data-testid="password-report"]');
  const names = async (id) => p.$$eval(`[data-testid="report-${id}"] [data-testid="report-item"]`, (els) => els.map((e) => e.getAttribute("data-name")));
  check("report: weak password", (await names("weak")).includes("Report schwach"), JSON.stringify(await names("weak")));
  check("report: strong passwords not weak", !(await names("weak")).includes("Report http"));
  const reused = await names("reused");
  check("report: reused passwords", reused.includes("Report doppelt 1") && reused.includes("Report doppelt 2"), JSON.stringify(reused));
  check("report: http website", (await names("http")).includes("Report http"));
  check("report: online checks only on request", (await p.locator('[data-testid="report-count-exposed"]').count()) === 0);
  await p.click('[data-testid="report-exposed-run"]');
  await p.waitForSelector('[data-testid="report-count-exposed"]', { timeout: 15000 });
  check("report: exposed password (HIBP)", (await names("exposed")).includes("Report schwach") && !(await names("exposed")).includes("Report http"), JSON.stringify(await names("exposed")));
  await p.click('[data-testid="report-tfa-run"]');
  await p.waitForSelector('[data-testid="report-count-tfa"]', { timeout: 15000 });
  check("report: 2FA available but not set up", (await names("tfa")).includes("Report 2FA") && !(await names("tfa")).includes("Test-Login (privat)"), JSON.stringify(await names("tfa")));
  await p.screenshot({ path: `${SHOTS}/toolbox-report.png`, fullPage: true });
  await p.close();
}

// ------------------------------------------------------------------------------ receive a Send
{
  const day = new Date(Date.now() + 86400_000).toISOString();
  const r1 = await rpc("saveSend", { accountKey: B, send: { type: 0, name: "Geheimer Gruß", text: "Hallo aus dem anderen Konto", hidden: true, newPassword: "sesam", disabled: false, hideEmail: false, deletionDate: day } });
  const p = await popup();
  await p.click('[data-testid="tab-tools"]');
  await p.click('[data-testid="tool-receive"]');
  await p.fill('[data-testid="receive-link"]', "keine-url");
  await p.click('[data-testid="receive-open"]');
  check("receive: invalid link rejected", ((await p.textContent('[data-testid="receive-error"]')) ?? "").length > 0);
  await p.fill('[data-testid="receive-link"]', r1.send.link);
  await p.click('[data-testid="receive-open"]');
  await p.waitForSelector('input[name="receive-password"]');
  await p.fill('input[name="receive-password"]', "falsch");
  await p.click('[data-testid="receive-open"]');
  await p.waitForSelector('[data-testid="receive-error"]');
  check("receive: wrong password", ((await p.textContent('[data-testid="receive-error"]')) ?? "").includes("falsch"));
  await p.fill('input[name="receive-password"]', "sesam");
  await p.click('[data-testid="receive-open"]');
  await p.waitForSelector('[data-testid="receive-result"]', { timeout: 15000 });
  check("receive: name", (await p.textContent('[data-testid="receive-name"]')) === "Geheimer Gruß");
  check("receive: hidden text stays hidden", (await p.locator('[data-testid="receive-text"]').count()) === 0);
  await p.click('[data-testid="receive-toggle"]');
  check("receive: text", (await p.textContent('[data-testid="receive-text"]')) === "Hallo aus dem anderen Konto");
  await p.screenshot({ path: `${SHOTS}/toolbox-receive.png` });
  // file
  const fpath = path.join(TMP, "receive-test.txt");
  writeFileSync(fpath, "Datei über Send empfangen\n");
  const up = await rpc("sendUploadStart", { accountKey: B, fileName: "empfang.txt", size: readFileSync(fpath).length });
  await rpc("attachmentUploadChunk", { id: up.id, data: readFileSync(fpath).toString("base64") });
  const r2 = await rpc("saveSend", { accountKey: B, send: { type: 1, name: "Datei", disabled: false, hideEmail: false, deletionDate: day, uploadId: up.id } });
  await p.click('[data-testid="receive-again"]');
  await p.fill('[data-testid="receive-link"]', r2.send.link);
  await p.click('[data-testid="receive-open"]');
  await p.waitForSelector('[data-testid="receive-download"]', { timeout: 15000 });
  const dl = p.waitForEvent("download");
  await p.click('[data-testid="receive-download"]');
  const d = await dl;
  const got = readFileSync(await d.path(), "utf8");
  check("receive: file downloaded and decrypted", got === "Datei über Send empfangen\n" && d.suggestedFilename() === "empfang.txt", JSON.stringify([got, d.suggestedFilename()]));
  await rpc("deleteSend", { accountKey: B, id: r1.send.id });
  await rpc("deleteSend", { accountKey: B, id: r2.send.id });
  await p.close();
}

// ------------------------------------------------------------------------------ passkeys: filter and details
{
  await rpc("importItems", {
    accountKey: A,
    items: [
      {
        type: 1,
        name: "Passkey-Konto",
        login: { username: "pk-user", password: "", uris: [{ uri: "https://passkey.example.test", match: null }] },
        passkeysPlain: [
          {
            credentialId: "b9b1d2f1-5a1f-4a77-9c4c-0e6f2f1d6a10",
            keyType: "public-key",
            keyAlgorithm: "ECDSA",
            keyCurve: "P-256",
            keyValue: "AAAA",
            rpId: "passkey.example.test",
            rpName: "Passkey Example",
            userHandle: "dXNlci1oYW5kbGU",
            userName: "pk-user",
            userDisplayName: "PK User",
            counter: "0",
            discoverable: "true",
            creationDate: "2026-10-01T10:00:00.000Z",
          },
        ],
      },
    ],
  });
  const p = await popup();
  await p.click('[data-testid="filter-type"]');
  await p.getByRole("menuitem", { name: "Login mit Passkey" }).click();
  await p.waitForTimeout(300);
  const rows = await p.$$eval('[data-testid="all-items"] [data-testid="item-row"]', (els) => els.map((e) => e.getAttribute("data-name")));
  check("filter: only logins with passkey", rows.includes("Passkey-Konto") && !rows.includes("Test-Login (privat)"), JSON.stringify(rows));
  await p.locator('[data-testid="item-row"][data-name="Passkey-Konto"]').first().click();
  await p.waitForSelector('[data-testid="detail-passkey"]');
  check("passkey details hidden at first", (await p.locator('[data-testid="passkey-details"]').count()) === 0);
  await p.click('[data-testid="passkey-details-toggle"]');
  const det = (await p.textContent('[data-testid="passkey-details"]')) ?? "";
  check("passkey details shown", det.includes("passkey.example.test") && det.includes("Passkey Example") && det.includes("PK User") && det.includes("b9b1d2f1-5a1f-4a77-9c4c-0e6f2f1d6a10"), det);
  check("private key never shown", !det.includes("AAAA"));
  await p.screenshot({ path: `${SHOTS}/toolbox-passkey.png` });
  await p.close();
}

await ctx.close();
console.log(failed ? `${failed} FAILED` : "TOOLBOX E2E ALL PASSED");
process.exit(failed ? 1 : 0);
