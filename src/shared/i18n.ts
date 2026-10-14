// Minimal i18n: the German UI text is the key, other languages are dictionaries
// (missing → English, then German). Placeholders: t("{n} Konten", { n: 3 }).
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

export type Language = "system" | "de" | "en" | "fr" | "es";
type UiLanguage = Exclude<Language, "system">;
export const LANGUAGES: { id: UiLanguage; name: string }[] = [
  { id: "de", name: "Deutsch" },
  { id: "en", name: "English" },
  { id: "fr", name: "Français" },
  { id: "es", name: "Español" },
];

const DICTS: Record<string, Record<string, string>> = { en, fr, es };
const LOCALES: Record<UiLanguage, string> = { de: "de-DE", en: "en-US", fr: "fr-FR", es: "es-ES" };
let current: UiLanguage = detect();

function detect(): UiLanguage {
  let l = "";
  try {
    l = (globalThis as any).chrome?.i18n?.getUILanguage?.() ?? "";
  } catch {
    /* ignore */
  }
  if (!l) l = (globalThis as any).navigator?.language ?? "de";
  const base = l.toLowerCase().slice(0, 2);
  return base === "de" || base === "fr" || base === "es" ? base : "en";
}

export function setLanguage(pref: Language | undefined) {
  current = !pref || pref === "system" ? detect() : pref;
  try {
    if (typeof document !== "undefined") document.documentElement.lang = current;
  } catch {
    /* no DOM */
  }
}

export function lang(): UiLanguage {
  return current;
}

/** BCP-47 locale for number/date formatting */
export function locale(): string {
  return LOCALES[current] ?? "en-US";
}

export function t(text: string, vars?: Record<string, string | number | undefined | null>): string {
  let out = current === "de" ? text : (DICTS[current]?.[text] ?? DICTS.en[text] ?? text);
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m));
  return out;
}

/** Reads the language from the stored settings and follows changes (extension pages and worker). */
export async function initLanguage(onChange?: () => void): Promise<void> {
  try {
    const r = await chrome.storage.local.get("settings");
    setLanguage((r.settings as any)?.language);
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || !ch.settings) return;
      const before = current;
      setLanguage((ch.settings.newValue as any)?.language);
      if (before !== current) onChange?.();
    });
  } catch {
    setLanguage("system");
  }
}

/** An item type etc. inside a sentence: lower case at the start in French and Spanish ("Ajouter identifiant"). */
export function inSentence(word: string): string {
  return current === "fr" || current === "es" ? word.charAt(0).toLowerCase() + word.slice(1) : word;
}

/** Marks a text as translation key without translating it (for module-level tables). */
export function tk(text: string): string {
  return text;
}

/** Lookup table whose string values are translated on access. */
export function localized<T extends Record<string | number, string>>(table: T): T {
  return new Proxy(table, {
    get(target, k) {
      const v = (target as any)[k];
      return typeof v === "string" ? t(v) : v;
    },
  });
}
