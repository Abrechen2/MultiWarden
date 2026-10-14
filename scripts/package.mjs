// Builds release bundles and zips them (needs the `zip` CLI).
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
execSync("node build.mjs", { stdio: "inherit", env: { ...process.env, MW_TEST: "" } });
rmSync("release", { recursive: true, force: true });
mkdirSync("release");
for (const t of ["chrome", "firefox", "opera"]) execSync(`cd dist/${t} && zip -qr ../../release/multiwarden-${t}-${version}.zip .`);
execSync(
  `zip -qr release/multiwarden-source-${version}.zip . -x "node_modules/*" "dist/*" "release/*" ".git/*" "NOTES.md"`,
  { stdio: "inherit" },
);
console.log("release/ ready");
