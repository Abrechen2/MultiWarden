import { AccountPublic, CipherType, ItemView } from "../shared/types";
import type { IconName } from "./icons";
import { callAny } from "./rpc";
import { locale, localized, t, tk } from "../shared/i18n";

function hostnameOf(uri: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : "http://" + uri);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const TYPE_LABEL: Record<number, string> = localized({
  [CipherType.Login]: tk("Login"),
  [CipherType.SecureNote]: tk("Sichere Notiz"),
  [CipherType.Card]: tk("Karte"),
  [CipherType.Identity]: tk("Identität"),
  [CipherType.SshKey]: tk("SSH-Schlüssel"),
  [CipherType.BankAccount]: tk("Bankkonto"),
  [CipherType.DriversLicense]: tk("Führerschein"),
  [CipherType.Passport]: tk("Reisepass"),
});

export const TYPE_ICON: Record<number, IconName> = {
  [CipherType.Login]: "globe",
  [CipherType.SecureNote]: "note",
  [CipherType.Card]: "card",
  [CipherType.Identity]: "identity",
  [CipherType.SshKey]: "key",
  [CipherType.BankAccount]: "bank",
  [CipherType.DriversLicense]: "idCard",
  [CipherType.Passport]: "passport",
};

export function itemKey(i: { accountKey: string; id: string }) {
  return i.accountKey + "::" + i.id;
}

export function subtitle(i: ItemView): string {
  switch (i.type) {
    case CipherType.Login:
      return i.login?.username || (i.login?.uris[0] ? (hostnameOf(i.login.uris[0].uri) ?? "") : "");
    case CipherType.Card: {
      const n = i.card?.number ?? "";
      const brand = i.card?.brand ?? "";
      return [brand, n ? "*" + n.slice(-4) : ""].filter(Boolean).join(", ");
    }
    case CipherType.Identity:
      return [i.identity?.firstName, i.identity?.lastName].filter(Boolean).join(" ") || i.identity?.email || "";
    case CipherType.SshKey:
      return i.sshKey?.keyFingerprint ?? "";
    case CipherType.SecureNote:
      return (i.notes ?? "").split("\n")[0].slice(0, 60);
    case CipherType.BankAccount:
      return i.extra?.bankName || i.extra?.nameOnAccount || "";
    case CipherType.DriversLicense:
      return [i.extra?.firstName, i.extra?.lastName].filter(Boolean).join(" ");
    case CipherType.Passport:
      return [i.extra?.givenName, i.extra?.surname].filter(Boolean).join(" ");
    default:
      return "";
  }
}

export function faviconUrl(i: ItemView, acc: AccountPublic | undefined, enabled: boolean): string | undefined {
  if (!enabled || i.type !== CipherType.Login || !acc) return undefined;
  for (const u of i.login?.uris ?? []) {
    if (!/^https?:\/\//i.test(u.uri) && /^[a-z]+:/i.test(u.uri) && !/^[\w.-]+:\d+/.test(u.uri)) continue;
    const h = hostnameOf(u.uri);
    if (h && h.includes(".")) return `${acc.iconsUrl}/${h}/icon.png`;
  }
  return undefined;
}

export function launchUrl(uri: string): string | null {
  const u = uri.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[\w.-]+:\d+/.test(u)) return null;
  return "http://" + u;
}

export function normalize(s: string) {
  return s.toLocaleLowerCase("de").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function searchMatch(i: ItemView, q: string): boolean {
  if (!q) return true;
  const n = normalize(q);
  const hay = [
    i.name,
    subtitle(i),
    i.login?.username ?? "",
    ...(i.login?.uris.map((u) => u.uri) ?? []),
    i.notes && i.type === CipherType.SecureNote ? i.notes : "",
  ]
    .filter(Boolean)
    .join("\n");
  return normalize(hay).includes(n);
}

export function compareItems(a: ItemView, b: ItemView) {
  return (
    a.name.localeCompare(b.name, "de", { sensitivity: "base" }) || (a.login?.username ?? "").localeCompare(b.login?.username ?? "", "de")
  );
}

let clearTimer: number | undefined;

export async function copyToClipboard(text: string, clearAfterSec: number): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearAfterSec > 0) {
    // the popup may close; let the background clear it
    callAny("scheduleClipboardClear").catch(() => {});
    window.clearTimeout(clearTimer);
  }
}

export function formatDate(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

/** date without time */
export function formatDay(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString(locale(), { dateStyle: "medium" });
}

export function relTime(ts?: number): string {
  if (!ts) return t("nie");
  const diff = Math.round((Date.now() - ts) / 1000);
  if (diff < 60) return t("gerade eben");
  if (diff < 3600) return t("vor {n} Min.", { n: Math.round(diff / 60) });
  if (diff < 86400) return t("vor {n} Std.", { n: Math.round(diff / 3600) });
  return new Date(ts).toLocaleDateString(locale());
}

export function cardBrandFromNumber(n: string): string {
  const s = n.replace(/\D/g, "");
  if (/^4/.test(s)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(s)) return "Mastercard";
  if (/^3[47]/.test(s)) return "Amex";
  if (/^6(011|5)/.test(s)) return "Discover";
  if (/^35/.test(s)) return "JCB";
  if (/^3(0[0-5]|[68])/.test(s)) return "Diners Club";
  if (/^(5018|5020|5038|6304|6759|676[1-3])/.test(s)) return "Maestro";
  return "";
}
