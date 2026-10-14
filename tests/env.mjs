// Shared settings of the test scripts, overridable through environment variables:
//   MW_TEST_TMP    scratch directory (browser profiles, screenshots, bundled tests, TLS key …)
//   CHROMIUM_PATH  Chromium executable; without it Playwright's own "chromium" build is used
//                  (npx playwright-core install chromium). Extensions need a full Chromium, not the headless shell.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TMP = process.env.MW_TEST_TMP || path.join(os.tmpdir(), "multiwarden-tests");
mkdirSync(TMP, { recursive: true });

/** launch options for Chromium with the extension loaded */
export const chromiumOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: "chromium" };
