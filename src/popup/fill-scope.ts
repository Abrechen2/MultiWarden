// Where a login is filled: on the whole domain (incl. all subdomains) or only on exactly the saved host.
// Stored as Bitwarden's URI match detection on every website of the item, so the official clients
// honour it too; "Standard" leaves the match empty and follows the global setting.
import { t, tk } from "../shared/i18n";
import { UriMatch } from "../shared/types";
import { baseDomain, hostOf } from "../shared/uri";

export type FillScope = "default" | "domain" | "host" | "custom";

type Uri = { uri: string; match?: UriMatch | null };

export const MATCH_NAMES: Record<number, string> = {
  [UriMatch.Domain]: tk("Basisdomain (inkl. Subdomains)"),
  [UriMatch.Host]: tk("Host (nur genau diese Subdomain)"),
  [UriMatch.StartsWith]: tk("Beginnt mit"),
  [UriMatch.Exact]: tk("Exakt"),
  [UriMatch.RegularExpression]: tk("Regulärer Ausdruck"),
  [UriMatch.Never]: tk("Nie"),
};

export function scopeOf(uris: Uri[]): FillScope {
  const ms = uris.map((u) => u.match ?? null);
  if (ms.every((m) => m == null)) return "default";
  if (ms.every((m) => m === UriMatch.Domain)) return "domain";
  if (ms.every((m) => m === UriMatch.Host)) return "host";
  return "custom";
}

/** Apply a scope to all websites ("custom" keeps the individual values). */
export function withScope<T extends Uri>(uris: T[], scope: FillScope): T[] {
  if (scope === "custom") return uris;
  const match = scope === "domain" ? UriMatch.Domain : scope === "host" ? UriMatch.Host : null;
  return uris.map((u) => ({ ...u, match }));
}

/** The match for a newly added website in this scope. */
export function matchForNew(scope: FillScope): UriMatch | null {
  return scope === "domain" ? UriMatch.Domain : scope === "host" ? UriMatch.Host : null;
}

function firstUri(uris: Uri[]) {
  return uris.find((u) => u.uri.trim())?.uri ?? "";
}

export function domainLabel(uris: Uri[]): string {
  const d = baseDomain(firstUri(uris));
  return d ? t("{domain} und alle Subdomains", { domain: d }) : t("Ganze Domain inkl. Subdomains");
}

export function hostLabel(uris: Uri[]): string {
  const h = hostOf(firstUri(uris));
  return h ? t("Nur {host}", { host: h }) : t("Nur genau diese Subdomain");
}

/** Short description of where an item is filled (item view). */
export function describeScope(uris: Uri[], defaultMatch: UriMatch): string {
  const used = uris.filter((u) => u.uri.trim());
  if (!used.length) return "";
  const eff = used.map((u) => u.match ?? defaultMatch);
  if (eff.every((m) => m === UriMatch.Domain)) return domainLabel(used);
  if (eff.every((m) => m === UriMatch.Host)) return used.length === 1 ? hostLabel(used) : t("Nur genau die gespeicherten Hosts");
  if (eff.every((m) => m === eff[0])) return t(MATCH_NAMES[eff[0]] ?? "");
  return t("Individuell je Website");
}
