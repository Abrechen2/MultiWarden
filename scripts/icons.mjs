import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
<defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#175ddc"/></linearGradient></defs>
<path d="M16 1.5 4.2 5.9v8.7c0 7.6 4.9 13.2 11.8 15.9 6.9-2.7 11.8-8.3 11.8-15.9V5.9Z" fill="url(#lg)"/>
<path d="M16 5.4v20.9c5-2.1 8.2-6.4 8.2-11.8V8.3Z" fill="#fff" fill-opacity=".2"/>
<circle cx="12" cy="13.4" r="2.9" fill="#fff"/>
<circle cx="20.1" cy="13.4" r="2.9" fill="#fff" fill-opacity=".78"/>
<path d="M7.9 21.8c.8-2.6 2.2-3.9 4.1-3.9s3.3 1.3 4.1 3.9M16 21.8c.8-2.6 2.2-3.9 4.1-3.9s3.3 1.3 4.1 3.9" stroke="#fff" stroke-width="${size <= 16 ? 2.2 : 1.8}" fill="none" stroke-linecap="round"/>
</svg>`;
// renders the toolbar icons from the SVG (Chromium via CHROMIUM_PATH or Playwright's own build)
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: 200, height: 200 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(`static/icons/icon-${size}.png`, buf);
}
writeFileSync("static/icons/icon.svg", svg(128));
await browser.close();
console.log("icons ok");
