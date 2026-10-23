// Cleanup checks over the decrypted vault. Pure and in memory only; nothing here is persisted.
import type { Evidence } from "./dup-evidence";
import { sameSharedItem } from "./duplicates";
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

/** Logins never filled on this device, or not within the last STALE_MS. */
export function staleOnThisDevice(
  items: ItemView[],
  lastUsed: Evidence["lastUsed"],
  now: number,
): { item: ItemView; lastUsed?: number }[] {
  const out: { item: ItemView; lastUsed?: number }[] = [];
  for (const item of activeLogins(items)) {
    const t = lastUsed[item.accountKey]?.[item.id];
    if (t === undefined || now - t > STALE_MS) out.push({ item, lastUsed: t });
  }
  return out;
}

/** Groups of logins with the same password that span at least two accounts; a shared item counts once. */
export function reusedAcrossAccounts(items: ItemView[]): ItemView[][] {
  const live = activeLogins(items).filter((i, idx, all) => !!i.login!.password && !all.slice(0, idx).some((e) => sameSharedItem(e, i)));
  const groups = new Map<string, ItemView[]>();
  for (const i of live) {
    const pw = i.login!.password!;
    groups.set(pw, [...(groups.get(pw) ?? []), i]);
  }
  return [...groups.values()].filter((g) => new Set(g.map((i) => i.accountKey)).size >= 2);
}
