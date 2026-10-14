// Parsers for vault imports: Bitwarden (JSON, CSV, encrypted JSON), KeePass 2 XML and the CSV
// exports of browsers and other password managers (columns are recognised by their names).
import { CipherType, FieldType, ItemView } from "../shared/types";
import { tk } from "../shared/i18n";

export interface ImportItem extends Partial<ItemView> {
  type: CipherType;
  name: string;
  folderName?: string;
  /** passkeys from Bitwarden JSON (plain values) */
  passkeysPlain?: Record<string, string>[];
}

export interface ParsedImport {
  format: string;
  items: ImportItem[];
  /** encrypted Bitwarden export: needs the background (account key or file password) */
  encrypted?: { doc: any; passwordProtected: boolean };
}

export const IMPORT_FORMATS: [string, string][] = [
  ["auto", tk("Automatisch erkennen")],
  ["bitwardenjson", tk("Bitwarden (JSON, auch verschlüsselt)")],
  ["bitwardencsv", tk("Bitwarden (CSV)")],
  ["chromecsv", tk("Chrome, Edge, Brave, Opera, Vivaldi (CSV)")],
  ["firefoxcsv", tk("Firefox (CSV)")],
  ["safaricsv", tk("Safari / Apple Passwörter (CSV)")],
  ["lastpasscsv", tk("LastPass (CSV)")],
  ["1passwordcsv", tk("1Password (CSV)")],
  ["keepassxcsv", tk("KeePassXC (CSV)")],
  ["keepass2xml", tk("KeePass 2 (XML)")],
  ["genericcsv", tk("Andere CSV-Datei (Spalten werden erkannt)")],
];

// ---------------------------------------------------------------------------------------------
// CSV

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLS: Record<string, string[]> = {
  name: ["name", "title", "account", "itemname", "eintrag", "titel"],
  url: ["url", "uri", "website", "loginuri", "web", "address", "webadresse", "urls"],
  username: ["username", "login", "user", "email", "loginusername", "benutzername", "loginname", "username1"],
  password: ["password", "pass", "pwd", "loginpassword", "kennwort", "passwort"],
  notes: ["notes", "note", "extra", "comment", "comments", "notizen", "notiz", "bemerkung"],
  totp: ["totp", "otp", "otpauth", "otpsecret", "onetimepassword", "logintotp", "2fa", "otpurl"],
  folder: ["folder", "group", "grouping", "vault", "ordner", "gruppe"],
  favorite: ["fav", "favorite", "favourite", "favorit"],
};

function hostName(url: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** CSV with a header line: columns found by their names (browsers, LastPass, 1Password, KeePassXC …). */
function genericCsv(rows: string[][], format: string): ParsedImport {
  const header = rows[0].map(norm);
  const col = (k: string) => {
    for (const n of COLS[k]) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = Object.fromEntries(Object.keys(COLS).map((k) => [k, col(k)])) as Record<string, number>;
  if (c.password < 0 && c.username < 0 && c.url < 0) throw new Error(tk("In der CSV-Datei wurden keine Spalten für Zugangsdaten gefunden"));
  const known = new Set(Object.values(c).filter((i) => i >= 0));
  // Firefox: technical columns are not worth a custom field
  const skip = new Set([
    "httprealm",
    "formactionorigin",
    "guid",
    "timecreated",
    "timelastused",
    "timepasswordchanged",
    "icon",
    "lastmodified",
    "created",
  ]);
  const items: ImportItem[] = [];
  for (const r of rows.slice(1)) {
    const get = (k: string) => (c[k] >= 0 ? (r[c[k]] ?? "").trim() : "");
    const url = get("url");
    const notes = c.notes >= 0 ? (r[c.notes] ?? "") : "";
    // LastPass secure notes
    if (url === "http://sn") {
      items.push({
        type: CipherType.SecureNote,
        name: get("name") || "--",
        notes,
        secureNote: { type: 0 },
        folderName: get("folder") || undefined,
      });
      continue;
    }
    const fields = header
      .map((h, i) => [h, i] as const)
      .filter(([h, i]) => !known.has(i) && !skip.has(h) && (r[i] ?? "").trim() !== "")
      .map(([, i]) => ({ name: rows[0][i].trim(), value: r[i], type: FieldType.Text }));
    const fav = get("favorite").toLowerCase();
    items.push({
      type: CipherType.Login,
      name: get("name") || (url ? hostName(url) : get("username")) || "--",
      notes: notes || undefined,
      favorite: fav === "1" || fav === "true" || fav === "yes",
      fields,
      folderName: get("folder").replace(/^\/+|\/+$/g, "") || undefined,
      login: {
        username: get("username"),
        password: c.password >= 0 ? (r[c.password] ?? "") : "",
        totp: get("totp") || undefined,
        uris: url
          ? url
              .split(/[\n,]/)
              .map((u) => u.trim())
              .filter(Boolean)
              .map((u) => ({ uri: u, match: null }))
          : [],
        passkeys: 0,
      },
    });
  }
  return { format, items };
}

function bitwardenCsv(rows: string[][]): ParsedImport {
  const h = rows[0].map((x) => x.trim());
  const idx = (n: string) => h.indexOf(n);
  const items: ImportItem[] = [];
  for (const r of rows.slice(1)) {
    const g = (n: string) => (idx(n) >= 0 ? (r[idx(n)] ?? "") : "");
    const fields = g("fields")
      ? g("fields")
          .split("\n")
          .map((l) => {
            const p = l.indexOf(": ");
            return p >= 0
              ? { name: l.slice(0, p), value: l.slice(p + 2), type: FieldType.Text }
              : { name: l, value: "", type: FieldType.Text };
          })
      : [];
    const isNote = g("type") === "note";
    const base: ImportItem = {
      type: isNote ? CipherType.SecureNote : CipherType.Login,
      name: g("name") || "--",
      notes: g("notes") || undefined,
      favorite: g("favorite") === "1",
      reprompt: g("reprompt") === "1" ? 1 : 0,
      fields,
      folderName: g("folder") || undefined,
    };
    if (isNote) base.secureNote = { type: 0 };
    else
      base.login = {
        username: g("login_username"),
        password: g("login_password"),
        totp: g("login_totp") || undefined,
        uris: g("login_uri")
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean)
          .map((u) => ({ uri: u, match: null })),
        passkeys: 0,
      };
    items.push(base);
  }
  return { format: "bitwardencsv", items };
}

// ---------------------------------------------------------------------------------------------
// Bitwarden JSON

const strObj = (o: any): Record<string, string | undefined> => {
  const r: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (v != null && typeof v !== "object") r[k] = String(v);
  return r;
};

/** Unencrypted Bitwarden export document → items. */
export function fromBitwardenDoc(doc: any): ImportItem[] {
  const folders = new Map<string, string>((doc.folders ?? []).map((f: any) => [f.id, f.name]));
  const items: ImportItem[] = [];
  for (const c of doc.items ?? []) {
    const type = Number(c.type) as CipherType;
    if (!(type >= 1 && type <= 8)) continue;
    const it: ImportItem = {
      type,
      name: c.name || "--",
      notes: c.notes ?? undefined,
      favorite: !!c.favorite,
      reprompt: c.reprompt === 1 ? 1 : 0,
      fields: (c.fields ?? []).map((f: any) => ({
        name: f.name ?? "",
        value: f.value ?? "",
        type: f.type ?? 0,
        linkedId: f.linkedId ?? null,
      })),
      passwordHistory: (c.passwordHistory ?? [])
        .filter((p: any) => p?.password)
        .map((p: any) => ({ password: p.password, lastUsedDate: p.lastUsedDate ?? new Date().toISOString() })),
      folderName: c.folderId ? folders.get(c.folderId) : undefined,
    };
    switch (type) {
      case CipherType.Login:
        it.login = {
          username: c.login?.username ?? "",
          password: c.login?.password ?? "",
          totp: c.login?.totp ?? undefined,
          uris: (c.login?.uris ?? []).filter((u: any) => u?.uri).map((u: any) => ({ uri: u.uri, match: u.match ?? null })),
          passkeys: 0,
        };
        if (Array.isArray(c.login?.fido2Credentials) && c.login.fido2Credentials.length)
          it.passkeysPlain = c.login.fido2Credentials.map((f: any) => strObj(f));
        break;
      case CipherType.SecureNote:
        it.secureNote = { type: c.secureNote?.type ?? 0 };
        break;
      case CipherType.Card:
        it.card = strObj(c.card);
        break;
      case CipherType.Identity:
        it.identity = strObj(c.identity);
        break;
      case CipherType.SshKey:
        it.sshKey = strObj(c.sshKey);
        break;
      case CipherType.BankAccount:
        it.extra = strObj(c.bankAccount);
        break;
      case CipherType.DriversLicense:
        it.extra = strObj(c.driversLicense);
        break;
      case CipherType.Passport:
        it.extra = strObj(c.passport);
        break;
    }
    items.push(it);
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// KeePass 2 XML

function keepassXml(text: string): ParsedImport {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error(tk("Die XML-Datei ist fehlerhaft"));
  const root = xml.querySelector("KeePassFile > Root > Group");
  if (!root) throw new Error(tk("Keine KeePass-Datei"));
  const items: ImportItem[] = [];
  const walk = (group: Element, path: string[]) => {
    for (const child of Array.from(group.children)) {
      if (child.tagName === "Group") {
        const name = child.querySelector(":scope > Name")?.textContent ?? "";
        walk(child, [...path, name]);
      } else if (child.tagName === "Entry") {
        const strings = new Map<string, { value: string; protect: boolean }>();
        for (const s of Array.from(child.querySelectorAll(":scope > String"))) {
          const k = s.querySelector("Key")?.textContent ?? "";
          const v = s.querySelector("Value");
          strings.set(k, { value: v?.textContent ?? "", protect: v?.getAttribute("ProtectInMemory") === "True" });
        }
        const g = (k: string) => strings.get(k)?.value ?? "";
        const std = new Set(["Title", "UserName", "Password", "URL", "Notes", "otp", "TOTP Seed", "TOTP Settings"]);
        const url = g("URL");
        items.push({
          type: CipherType.Login,
          name: g("Title") || (url ? hostName(url) : "--"),
          notes: g("Notes") || undefined,
          folderName: path.join("/") || undefined,
          fields: [...strings]
            .filter(([k, v]) => !std.has(k) && v.value)
            .map(([k, v]) => ({ name: k, value: v.value, type: v.protect ? FieldType.Hidden : FieldType.Text })),
          login: {
            username: g("UserName"),
            password: g("Password"),
            totp: g("otp") || g("TOTP Seed") || undefined,
            uris: url ? [{ uri: url, match: null }] : [],
            passkeys: 0,
          },
        });
      }
    }
  };
  walk(root, []);
  return { format: "keepass2xml", items };
}

// ---------------------------------------------------------------------------------------------

export function parseImport(text: string, format: string): ParsedImport {
  const trimmed = text.trim().replace(/^﻿/, "");
  let f = format;
  if (f === "auto") {
    if (trimmed.startsWith("{")) f = "bitwardenjson";
    else if (trimmed.startsWith("<")) f = "keepass2xml";
    else f = /(^|,)login_uri(,|$)/m.test(trimmed.split(/\r?\n/)[0]) ? "bitwardencsv" : "genericcsv";
  }
  if (f === "bitwardenjson") {
    let doc: any;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new Error(tk("Die JSON-Datei ist fehlerhaft"));
    }
    if (!Array.isArray(doc.items) && !doc.encrypted) throw new Error(tk("Keine Bitwarden-Exportdatei"));
    if (doc.encrypted) return { format: f, items: [], encrypted: { doc, passwordProtected: !!doc.passwordProtected } };
    return { format: f, items: fromBitwardenDoc(doc) };
  }
  if (f === "keepass2xml") return keepassXml(trimmed);
  const rows = parseCsv(trimmed);
  if (rows.length < 2) throw new Error(tk("Die Datei enthält keine Einträge"));
  if (f === "bitwardencsv") return bitwardenCsv(rows);
  return genericCsv(rows, f);
}
