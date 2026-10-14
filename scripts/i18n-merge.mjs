// Merges "German|||English|||French|||Spanish" lines (stdin or file) into src/shared/locales/*.json.
// French and Spanish are optional (lines with only "German|||English" update en.json only).
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(process.argv[2] ?? 0, "utf8");
const langs = ["en", "fr", "es"];
const dicts = Object.fromEntries(langs.map((l) => [l, JSON.parse(readFileSync(`src/shared/locales/${l}.json`, "utf8"))]));
let n = 0;
for (const line of src.split("\n")) {
  if (!line.includes("|||")) continue;
  const [k, ...vals] = line.split("|||");
  vals.forEach((v, i) => {
    if (langs[i] && v !== undefined && v !== "") dicts[langs[i]][k] = v;
  });
  n++;
}
for (const l of langs) {
  const sorted = Object.fromEntries(Object.entries(dicts[l]).sort(([a], [b]) => a.localeCompare(b, "de")));
  writeFileSync(`src/shared/locales/${l}.json`, JSON.stringify(sorted, null, 1) + "\n");
}
console.log("merged", n, "lines →", langs.map((l) => `${l}: ${Object.keys(dicts[l]).length}`).join(", "));
