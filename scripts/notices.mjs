// Builds THIRD-PARTY-NOTICES.txt from src/shared/third-party.json: name, source, license and the
// full license text of every bundled third-party component (npm packages: their LICENSE file).
import { existsSync, readdirSync, readFileSync } from "node:fs";

function npmLicense(pkg) {
  const dir = `node_modules/${pkg}`;
  const meta = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`no license file in ${dir}`);
  return { version: meta.version, text: readFileSync(`${dir}/${file}`, "utf8").trim() };
}

export function thirdPartyNotices() {
  const list = JSON.parse(readFileSync("src/shared/third-party.json", "utf8"));
  const line = "=".repeat(78);
  const out = [
    "MultiWarden - third-party notices",
    "",
    "MultiWarden is free software under the GNU General Public License v3.0 or later (LICENSE.txt).",
    "It contains or is based on the following open source components:",
    "",
    ...list.map((c) => `  - ${c.name} (${c.license}): ${c.url}`),
    "",
  ];
  for (const c of list) {
    out.push(line, `${c.name}`, `${c.url}`, `License: ${c.license}`, line, "");
    if (c.notice) out.push(c.notice, "");
    for (const pkg of c.npm ?? []) {
      const l = npmLicense(pkg);
      out.push(`--- npm package ${pkg} ${l.version} ---`, "", l.text, "");
    }
    for (const f of c.files ?? []) {
      if (!existsSync(f)) throw new Error(`missing license file ${f}`);
      out.push(readFileSync(f, "utf8").trim(), "");
    }
  }
  // BOM: browsers show the .txt as UTF-8 (names like "Biró" in the license texts)
  return "\uFEFF" + out.join("\n");
}
