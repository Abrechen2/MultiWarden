import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { thirdPartyNotices } from "./scripts/notices.mjs";

const watch = process.argv.includes("--watch");
const targets = ["chrome", "firefox", "opera"];

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: ["chrome116", "firefox128"],
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"', __TEST__: process.env.MW_TEST ? "true" : "false", __FIREFOX__: "false" },
};

const entries = [
  { in: "src/background/index.ts", out: "background", format: "iife" },
  { in: "src/content/autofill.ts", out: "content/autofill", format: "iife" },
  { in: "src/content/fido2-page.ts", out: "content/fido2-page", format: "iife" },
  { in: "src/content/fido2-bridge.ts", out: "content/fido2-bridge", format: "iife" },
  { in: "src/fido2/index.tsx", out: "fido2", format: "iife" },
  { in: "src/notification/index.tsx", out: "notification", format: "iife" },
  { in: "src/popup/index.tsx", out: "popup", format: "iife" },
  { in: "src/inline-menu/index.tsx", out: "inline-menu", format: "iife" },
  { in: "src/offscreen.ts", out: "offscreen", format: "iife" },
];

/** Sidebar (Firefox, Opera): the popup UI as a panel next to the page. */
function sidebarAction(m) {
  return { default_panel: "popup.html?sidebar=1", default_title: "MultiWarden", default_icon: m.action.default_icon };
}

function operaManifest(m) {
  const o = structuredClone(m);
  o.sidebar_action = sidebarAction(m);
  return o;
}

const UPDATE_URL = "https://raw.githubusercontent.com/Abrechen2/MultiWarden/abrechen2/updates.json";

function firefoxManifest(m) {
  const f = structuredClone(m);
  f.sidebar_action = { ...sidebarAction(m), open_at_install: false };
  f.background = { scripts: ["background.js"] };
  // Firefox answers HTTP auth with "blocking" listeners instead of Chrome's webRequestAuthProvider
  f.permissions = f.permissions.filter((p) => p !== "offscreen" && p !== "webRequestAuthProvider").concat("webRequestBlocking");
  delete f.minimum_chrome_version;
  f.web_accessible_resources = f.web_accessible_resources.map((r) => {
    const { use_dynamic_url, ...rest } = r;
    return rest;
  });
  // Firefox 140+ shows its built-in consent for the data an extension transmits. MultiWarden syncs the vault
  // (usernames, passwords, identities, cards – end-to-end encrypted) with the servers of the user's accounts.
  f.browser_specific_settings = {
    gecko: {
      id: "multiwarden@abrechen2.de",
      strict_min_version: "140.0",
      // self-distributed updates: updates.json on the abrechen2 branch names the signed xpi of the newest GitHub release
      update_url: UPDATE_URL,
      data_collection_permissions: { required: ["authenticationInfo", "personallyIdentifyingInfo", "financialAndPaymentInfo"] },
    },
  };
  return f;
}

async function build() {
  for (const t of targets) rmSync(`dist/${t}`, { recursive: true, force: true });
  mkdirSync("dist/chrome", { recursive: true });
  await esbuild.build({
    ...common,
    entryPoints: entries.map((e) => ({ in: e.in, out: e.out })),
    outdir: "dist/chrome",
    format: "iife",
  });
  cpSync("static", "dist/chrome", { recursive: true, filter: (s) => !s.endsWith("manifest.json") });
  const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  manifest.version = pkg.version;
  writeFileSync("dist/chrome/manifest.json", JSON.stringify(manifest, null, 2));
  // license of MultiWarden and of the bundled open source components (also linked from "Über")
  cpSync("LICENSE", "dist/chrome/LICENSE.txt");
  writeFileSync("dist/chrome/THIRD-PARTY-NOTICES.txt", thirdPartyNotices());
  cpSync("dist/chrome", "dist/firefox", { recursive: true });
  rmSync("dist/firefox/offscreen.html", { force: true });
  rmSync("dist/firefox/offscreen.js", { force: true });
  writeFileSync("dist/firefox/manifest.json", JSON.stringify(firefoxManifest(manifest), null, 2));
  // Firefox: background without the (Chrome-only) offscreen clipboard code
  await esbuild.build({
    ...common,
    define: { ...common.define, __FIREFOX__: "true" },
    entryPoints: ["src/background/index.ts"],
    outfile: "dist/firefox/background.js",
    format: "iife",
  });
  cpSync("dist/chrome", "dist/opera", { recursive: true });
  writeFileSync("dist/opera/manifest.json", JSON.stringify(operaManifest(manifest), null, 2));
  console.log("built", new Date().toLocaleTimeString());
}

await build();
if (watch) {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: entries.map((e) => ({ in: e.in, out: e.out })),
    outdir: "dist/chrome",
    format: "iife",
  });
  await ctx.watch();
}
