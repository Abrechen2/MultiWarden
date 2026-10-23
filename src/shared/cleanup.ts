// Cleanup checks over the decrypted vault. Pure and in memory only; nothing here is persisted.
import type { Evidence } from "./dup-evidence";
import { CipherType, ItemView } from "./types";
import { isPortScopedHost, parseUrl } from "./uri";

export const STALE_MS = 365 * 24 * 60 * 60 * 1000;

const WEB = new Set(["http:", "https:"]);
const WEB_OR_APP = new Set(["http:", "https:", "androidapp:", "iosapp:"]);

/** Active logins: not deleted, not archived, decrypted. */
function activeLogins(items: ItemView[]): ItemView[] {
  return items.filter((i) => i.type === CipherType.Login && i.login && !i.deletedDate && !i.archivedDate && !i.decryptError);
}

/** Logins with no website, or only websites that do not parse or use a scheme other than web / app. */
export function withoutWebsite(items: ItemView[]): ItemView[] {
  return activeLogins(items).filter((i) => {
    const uris = (i.login!.uris ?? []).filter((u) => u.uri?.trim());
    return !uris.some((u) => {
      const p = parseUrl(u.uri);
      return !!p && WEB_OR_APP.has(p.protocol);
    });
  });
}

/** http(s) URIs on IP / localhost / single-label hosts without an explicit port (never guessed). */
export function portlessLocalUris(items: ItemView[]): { item: ItemView; uri: string }[] {
  const out: { item: ItemView; uri: string }[] = [];
  for (const item of activeLogins(items)) {
    for (const u of item.login!.uris ?? []) {
      const p = u.uri?.trim() ? parseUrl(u.uri) : null;
      if (p && WEB.has(p.protocol) && isPortScopedHost(p.hostname.toLowerCase()) && !p.port) {
        out.push({ item, uri: u.uri });
        break;
      }
    }
  }
  return out;
}

/**
 * Logins not filled on this device within STALE_MS. "Never used" only counts once this device's usage
 * data spans a year (oldest timestamp over all accounts); before that only entries with a known, old
 * last use are listed and `neverUsedMeaningful` is false.
 */
export function staleOnThisDevice(
  items: ItemView[],
  lastUsed: Evidence["lastUsed"],
  now: number,
): { entries: { item: ItemView; lastUsed?: number }[]; neverUsedMeaningful: boolean } {
  let oldest = Infinity;
  for (const perAccount of Object.values(lastUsed)) for (const t of Object.values(perAccount)) oldest = Math.min(oldest, t);
  const neverUsedMeaningful = oldest < now - STALE_MS;
  const entries: { item: ItemView; lastUsed?: number }[] = [];
  for (const item of activeLogins(items)) {
    const t = lastUsed[item.accountKey]?.[item.id];
    if (t === undefined ? neverUsedMeaningful : now - t > STALE_MS) entries.push({ item, lastUsed: t });
  }
  return { entries, neverUsedMeaningful };
}

/** Groups of logins with the same password that span at least two accounts; a shared item counts once. */
export function reusedAcrossAccounts(items: ItemView[]): ItemView[][] {
  const seenShared = new Set<string>();
  const live = activeLogins(items).filter((i) => {
    if (!i.login!.password) return false;
    if (!i.organizationId || !i.id) return true;
    const id = JSON.stringify([i.organizationId, i.id]);
    if (seenShared.has(id)) return false;
    seenShared.add(id);
    return true;
  });
  const groups = new Map<string, ItemView[]>();
  for (const i of live) {
    const pw = i.login!.password!;
    groups.set(pw, [...(groups.get(pw) ?? []), i]);
  }
  return [...groups.values()].filter((g) => new Set(g.map((i) => i.accountKey)).size >= 2);
}
