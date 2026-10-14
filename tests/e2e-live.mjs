// Browser test: live sync over the notifications hub (SignalR/MessagePack) against Vaultwarden.
// A second "device" (plain API client) changes the vault; the extension must notice without a sync.
import { chromium } from "playwright-core";
import { pbkdf2Sync, randomUUID, generateKeyPairSync } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { TMP, chromiumOptions } from "./env.mjs";

const SP = TMP;
const EXT = path.resolve("dist/chrome");
const PW = "Test-Passwort-123!";
const A = "http://localhost:8001";
const EMAIL = "alex@privat.test";
let failed = 0;
const check = (n, ok, info = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + info));
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => {
  for (let i = 0; i < ms / 200; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return undefined;
};

const profile = SP + "/profile-live";
rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  ...chromiumOptions,
  headless: true,
  locale: "de-DE",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-sandbox", "--lang=de-DE"],
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

const f = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: EMAIL, password: PW });
await rpc("loginAck");
const key = f.accountKey;
await rpc("setSettings", { approveLoginRequests: true });
const connected = await waitFor(() => sw.evaluate((k) => globalThis.__mwTest.live.status()[k], key));
check("hub connected", !!connected);

// the other device
const mk = pbkdf2Sync(PW, EMAIL, 600000, 32, "sha256");
const hash = pbkdf2Sync(mk, PW, 1, 32, "sha256").toString("base64");
const otherDevice = randomUUID();
const tokRes = await fetch(A + "/identity/connect/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "password",
    username: EMAIL,
    password: hash,
    scope: "api offline_access",
    client_id: "web",
    deviceType: "9",
    deviceIdentifier: otherDevice,
    deviceName: "chrome",
  }),
});
const tok = await tokRes.json();
check("second device logged in", !!tok.access_token, JSON.stringify(tok).slice(0, 200));
const other = (method, p, body) =>
  fetch(A + "/api" + p, {
    method,
    headers: { Authorization: "Bearer " + tok.access_token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

let v = await rpc("getVault");
const wlan = v.items.find((i) => i.name === "WLAN Zuhause");

// 1. cipher deleted elsewhere
{
  const r = await other("PUT", `/ciphers/${wlan.id}/delete`);
  check("other device: moved to trash", r.ok, String(r.status));
  const del = await waitFor(async () => (await rpc("getVault")).items.find((i) => i.id === wlan.id)?.deletedDate);
  check("delete arrives without sync", !!del);
}

// 2. cipher updated elsewhere (restored from the trash) → refreshed here
{
  const r = await other("PUT", `/ciphers/${wlan.id}/restore`);
  check("other device: restored", r.ok, String(r.status));
  const back = await waitFor(async () => {
    const it = (await rpc("getVault")).items.find((i) => i.id === wlan.id);
    return it && !it.deletedDate;
  });
  check("update arrives without sync", !!back);
}

// 3. folder created elsewhere
{
  const before = (await rpc("getVault")).folders.filter((x) => x.accountKey === key).length;
  const r = await other("POST", "/folders", { name: "2.AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAA==|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  check("other device: folder created", r.ok, String(r.status));
  const n = await waitFor(async () => {
    const c = (await rpc("getVault")).folders.filter((x) => x.accountKey === key).length;
    return c > before ? c : 0;
  });
  check("new folder arrives without sync", !!n);
}

// 4. login request of another device → approval window opens right away (not with the 30 s alarm)
{
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" } });
  const winPromise = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
  const r = await fetch(A + "/api/auth-requests/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Device-Identifier": otherDevice, "Device-Type": "9" },
    body: JSON.stringify({ email: EMAIL, deviceIdentifier: otherDevice, publicKey: Buffer.from(publicKey).toString("base64"), type: 0, accessCode: "abcdefghijklmnopqrstuvwxy" }),
  });
  check("other device: login request created", r.ok, String(r.status) + " " + (await r.text()).slice(0, 200));
  const win = await winPromise;
  check("approval window opened by the notification", !!win && win.url().includes("route=authRequests"), win?.url());
}

// 5. locking closes the connection, unlocking opens it again
{
  await rpc("lock");
  const closed = await waitFor(async () => !(await sw.evaluate((k) => k in globalThis.__mwTest.live.status(), key)));
  check("disconnected while locked", !!closed);
  await rpc("unlock", { password: PW });
  const again = await waitFor(() => sw.evaluate((k) => globalThis.__mwTest.live.status()[k], key));
  check("connected again after unlock", !!again);
}

// 6. custom environment: services of a self-hosted server under other URLs
{
  await rpc("setCustomEnv", { baseUrl: A, env: { api: "http://127.0.0.1:8001/api", notifications: "http://127.0.0.1:8001/notifications" } });
  const env = await rpc("getCustomEnv", { baseUrl: A + "/" });
  check("custom URLs stored", env.env.api === "http://127.0.0.1:8001/api" && !env.env.identity, JSON.stringify(env));
  const f2 = await rpc("loginStart", { server: "selfhosted", baseUrl: A, email: "familie@privat.test", password: PW });
  await rpc("loginAck");
  check("login with custom URLs", f2.step === "done", JSON.stringify(f2));
  const urls = await sw.evaluate((k) => globalThis.__mwTest.svc.account(k).urls, f2.accountKey);
  check("account uses the custom API URL", urls.api === "http://127.0.0.1:8001/api" && urls.identity === A + "/identity", JSON.stringify(urls));
  const v2 = await waitFor(async () => (await rpc("getVault")).items.some((i) => i.accountKey === f2.accountKey));
  check("sync through the custom API URL", !!v2);
  const c2 = await waitFor(() => sw.evaluate((k) => globalThis.__mwTest.live.status()[k], f2.accountKey));
  check("live sync through the custom notifications URL", !!c2);
  // the login form shows the stored URLs
  const q = await ctx.newPage();
  await q.setViewportSize({ width: 380, height: 700 });
  await q.goto(`chrome-extension://${extId}/popup.html`);
  await q.waitForSelector('[data-testid="all-items"]');
  await q.getByRole("button", { name: "Einstellungen" }).click();
  await q.getByText("Konto hinzufügen", { exact: true }).click();
  await q.getByRole("button", { name: "Eigener Server" }).click();
  await q.fill('input[name="server-url"]', A);
  await q.waitForSelector('input[name="env-api"]', { timeout: 5000 }).catch(() => {});
  const apiField = await q.inputValue('input[name="env-api"]').catch(() => "");
  check("form shows the custom URLs", apiField === "http://127.0.0.1:8001/api", apiField);
  await q.screenshot({ path: SP + "/shots/custom-env.png" });
  await rpc("setCustomEnv", { baseUrl: A, env: {} });
  check("custom URLs removed", !Object.keys((await rpc("getCustomEnv", { baseUrl: A })).env).length);
  await q.close();
}

await ctx.close();
console.log(failed ? `${failed} FAILED` : "LIVE E2E ALL PASSED");
process.exit(failed ? 1 : 0);
