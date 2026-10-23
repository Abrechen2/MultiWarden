// Browser test of the popup's confirmation dialog: a long message (e.g. the bulk clean-up list of a large
// duplicate group) must not push the entries or the buttons out of the 380 x 600 popup.
// Run: CHROMIUM_PATH=… tests/run-node.sh tests/confirm-dialog.test.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { chromium } from "playwright-core";
import { TMP, chromiumOptions } from "./env.mjs";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const ORIGIN = "http://mw.test";
const out = path.join(TMP, "confirm-dialog-harness.js");
buildSync({
  entryPoints: [path.resolve("tests/confirm-dialog-harness.tsx")],
  bundle: true,
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  loader: { ".css": "empty" },
  define: { __TEST__: "false", __FIREFOX__: "false" },
  logLevel: "warning",
  outfile: out,
});
const css = readFileSync(path.resolve("src/popup/styles.css"), "utf8");
const ev = "{ addListener() {}, removeListener() {} }";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div>
<script>window.__chromeStub = { i18n: { getUILanguage: () => "de" }, storage: { local: { get: async () => ({}) }, onChanged: ${ev} },
  runtime: { sendMessage: async () => ({ ok: true, data: {} }), onMessage: ${ev} } };</script>
<script>(function (chrome) {
${readFileSync(out, "utf8").replace(/<\/script/gi, "<\\/script")}
})(window.__chromeStub);</script></body></html>`;

(async () => {
  const browser = await chromium.launch({ ...chromiumOptions, headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 600 } });
  await page.route(`${ORIGIN}/**`, (r: any) => r.fulfill({ contentType: "text/html", body: PAGE }));
  await page.goto(`${ORIGIN}/popup.html`);

  const lines = Array.from({ length: 60 }, (_, i) => `„Eintrag ${i + 1}“ (Konto ${i % 3})\n   Nur in diesem Eintrag: TOTP, Notizen`);
  page.setDefaultTimeout(5000);
  // not awaited inside the page: the promise only settles when the dialog is answered
  await page.evaluate((m: string) => void (window as any).openConfirm(m), lines.join("\n"));
  await page.waitForSelector('[data-testid="confirm-ok"]');

  const box = await page.locator('[data-testid="confirm-ok"]').boundingBox();
  check("OK button lies inside the popup", !!box && box.y >= 0 && box.y + box.height <= 600, box);
  const cancel = await page.locator('[role="dialog"] .btn-ghost').boundingBox();
  check("cancel button lies inside the popup", !!cancel && cancel.y >= 0 && cancel.y + cancel.height <= 600, cancel);
  const title = await page.getByText("Duplikate entfernen?").boundingBox();
  check("title lies inside the popup", !!title && title.y >= 0, title);

  // the last entry can be scrolled into view inside the message
  const msg = page.locator('[role="dialog"] p');
  const scroll = await msg.evaluate((el: HTMLElement) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
  check("long message scrolls inside the dialog", scroll.sh > scroll.ch && (scroll.oy === "auto" || scroll.oy === "scroll"), scroll);
  const end = await msg.evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    return { top: el.scrollTop, ch: el.clientHeight, sh: el.scrollHeight };
  });
  const msgBox = await msg.boundingBox();
  check(
    "last entry reachable by scrolling",
    end.top + end.ch >= end.sh - 1 && !!msgBox && msgBox.y >= 0 && msgBox.y + msgBox.height <= 600,
    { end, msgBox },
  );

  await page.click('[data-testid="confirm-ok"]');
  await page.waitForTimeout(50);
  check("OK button answers the confirmation", (await page.evaluate(() => (window as any).__answer)) === true);

  await browser.close();
  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
