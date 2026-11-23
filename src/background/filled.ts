// The login last filled into a tab. The save/update prompt uses it: after filling an entry, that entry is
// the one the submission belongs to, even when it is stored for another address.
import type { ItemView } from "../shared/types";
import { session } from "./store";

/** how long a fill is taken as the source of a later submission */
export const FILL_TTL = 5 * 60_000;

interface FillRecord {
  accountKey: string;
  itemId: string;
  /** origin (scheme, host, port) of the page the fill went into */
  origin: string;
  at: number;
}

function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

export async function recordFill(tabId: number, item: Pick<ItemView, "accountKey" | "id">, url: string, at = Date.now()) {
  const origin = originOf(url);
  if (!origin) return;
  const r: FillRecord = { accountKey: item.accountKey, itemId: item.id, origin, at };
  await session.set("filled:" + tabId, r);
}

/** the entry filled into this tab within FILL_TTL on the same origin as `url` */
export async function recentFill(tabId: number, url: string, now = Date.now()): Promise<{ accountKey: string; itemId: string } | undefined> {
  const r = await session.get<FillRecord>("filled:" + tabId);
  if (!r || !(now - r.at <= FILL_TTL) || r.origin !== originOf(url)) return undefined;
  return { accountKey: r.accountKey, itemId: r.itemId };
}

export async function forgetFill(tabId: number) {
  await session.remove("filled:" + tabId);
}
