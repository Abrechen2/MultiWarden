// Lists German-looking string literals that are not passed through t() and translation keys
// that are missing in the English dictionary.
// Usage: node scripts/i18n-check.mjs [--keys] [files…]   (default: all UI + background files)
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const showKeys = args.includes("--keys");
const writeMissing = args.includes("--missing");
let files = args.filter((a) => !a.startsWith("--"));
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
if (!files.length) files = walk("src").filter((f) => !/crypto\/|shared\/locales|shared\/strength|\.d\.ts$|content\/fido2-page|offscreen/.test(f));

const GERMAN =
  /[äöüÄÖÜß]|\b(der|die|das|und|nicht|kein|keine|bitte|ist|wird|werden|mit|für|ein|eine|oder|zu|von|auf|im|den|dem|des|sich|noch|nur|alle|konto|konten|eintrag|einträge|passwort|tresor|anmeldung|fehler|speichern|abbrechen|schließen|ordner|sammlung|website|server|entsperren|gesperrt|anmelden|löschen|bearbeiten|kopiert|kopieren|fehlgeschlagen|kartennummer|telefon|adresse|fingerabdruck|synchronisiere|synchronisiert|teilweise|eingerichtet|deaktiviert|sein|muss|zeichen|lang|neu|neue|neuer|aktiviert|gespeichert|wählen|eingeben|angeben|hinzufügen|ohne|namen|benutzer|geheim|wert|feld|felder|seite|unbekannt|ungültig|gültig|bereits|jetzt|später|immer|wieder|fertig|erfolgreich)\b/i;
const IGNORE_ATTR = new Set(["class", "data-testid", "name", "type", "autocomplete", "inputMode", "role", "id", "key", "href", "rel", "target", "for", "style", "value", "lang"]);
const keys = new Set();
const problems = [];

const UI_PROPS = /^(title|aria-label|label|placeholder|okLabel|desc|message|hint)$/;
/** a capitalised word in a place where only UI text goes (title=…, toast.show(…), { message: … }) */
function uiSlot(node) {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;
  if (!/^[A-ZÄÖÜ][a-zäöüß]{2,}/.test(node.text) || /^[A-Z][a-z]+[A-Z]/.test(node.text)) return false;
  for (let p = node.parent, depth = 0; p && depth < 6; p = p.parent, depth++) {
    if (ts.isJsxAttribute(p)) return UI_PROPS.test(p.name.getText());
    if (ts.isPropertyAssignment(p)) return p.name !== node && UI_PROPS.test(p.name.getText());
    if (ts.isCallExpression(p)) return /\.show$/.test(p.expression.getText());
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isTCall = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "t" || n.expression.text === "tk");
  const visit = (node) => {
    if (isTCall(node) && node.arguments[0]) {
      const a = node.arguments[0];
      if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) keys.add(a.text);
      // t(variable): the value has to be marked with tk() elsewhere (also inside the expression, e.g. t([tk("a"), tk("b")][i]))
      else visit(a);
      node.arguments.slice(1).forEach(visit);
      return;
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxAttribute(node) && IGNORE_ATTR.has(node.name.getText(sf))) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (/^console\.|\.querySelector|\.getAttribute|\.setAttribute|\.addEventListener|\.startsWith|\.endsWith|\.includes|\.replace|\.split|\.test|RegExp|\.get\(|\.set\(|\.remove\(|^call$|^callAny$|^rpc$|send$|bearerJson|anonJson|httpJson|\.match/.test(callee)) {
        // arguments of these calls are not UI text, but nested t() calls still count
        node.arguments.forEach((a) => ts.forEachChild(a, visit));
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isJsxText(node)) {
      const text = ts.isTemplateExpression(node) ? node.getText(sf) : ts.isJsxText(node) ? node.getText(sf) : node.text;
      if ((GERMAN.test(text) && /[a-zäöü]{2}/i.test(text)) || uiSlot(node)) {
        const parent = node.parent;
        const isKey = parent && (ts.isPropertyAssignment(parent) && parent.name === node);
        const inType = parent && (ts.isLiteralTypeNode(parent));
        const isCompare = parent && ts.isBinaryExpression(parent) && /===|!==|==/.test(parent.operatorToken.getText(sf));
        if (!isKey && !inType && !isCompare)
          problems.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text.replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// descriptions of the open source components ("Über") are translation keys, too
for (const c of JSON.parse(readFileSync("src/shared/third-party.json", "utf8"))) keys.add(c.use);

const en = JSON.parse(readFileSync("src/shared/locales/en.json", "utf8"));
// --missing: keys missing in any dictionary (en, fr, es)
const dicts = Object.fromEntries(["en", "fr", "es"].map((l) => [l, JSON.parse(readFileSync(`src/shared/locales/${l}.json`, "utf8"))]));
const missing = [...keys].filter((k) => Object.values(dicts).some((d) => !(k in d)));
const unused = Object.keys(en).filter((k) => !keys.has(k));
if (process.argv.includes("--unused")) console.log(JSON.stringify(unused, null, 1));
if (showKeys) console.log(JSON.stringify([...keys].sort(), null, 1));
else if (writeMissing) console.log(JSON.stringify(missing, null, 1));
else {
  problems.forEach((p) => console.log(p));
  console.log(`\n${problems.length} untranslated candidates, ${keys.size} keys, ${missing.length} missing in en/fr/es, ${unused.length} unused in en.json`);
}
