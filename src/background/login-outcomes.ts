// Local record of whether the last login with a vault item worked. Only the verdict, the time and the
// item's password revision are stored (never a password, hash or anything derived from it), so a record
// stops counting as soon as the password of the item changes.
import type { ItemView, OutcomeRecord } from "../shared/types";

export type { OutcomeRecord };

interface OutcomeStore {
  get<T>(k: string): Promise<T | undefined>;
  set(k: string, v: unknown): Promise<void>;
  remove(k: string | string[]): Promise<void>;
}

const PREFIX = "loginOutcome:";
/** items the outcome question was shown for: { [itemId]: rev } (asked at most once per password revision) */
const ASKED = "outcomeAsked:";
/** account keys that have a record, so that clear() without argument can find them */
const INDEX = "loginOutcomeAccounts";
/** hosts where the outcome question is never shown ("Nicht mehr fragen"; list kept in never-domains.ts) */
export const NEVER_ASK_KEY = "neverAskOutcome";

export function itemRev(i: ItemView): string {
  return i.login?.passwordRevisionDate ?? i.revisionDate ?? "";
}

export class LoginOutcomes {
  constructor(private store: OutcomeStore) {}

  async record(item: ItemView, ok: boolean, now = Date.now()): Promise<void> {
    const key = PREFIX + item.accountKey;
    const map = { ...((await this.store.get<Record<string, OutcomeRecord>>(key)) ?? {}) };
    map[item.id] = { at: now, ok, rev: itemRev(item) };
    await this.store.set(key, map);
    await this.index(item.accountKey);
  }

  private async index(accountKey: string) {
    const idx = (await this.store.get<string[]>(INDEX)) ?? [];
    if (!idx.includes(accountKey)) await this.store.set(INDEX, [...idx, accountKey]);
  }

  /** Remember that the question was shown for the item at its current password revision. */
  async markAsked(item: ItemView): Promise<void> {
    const key = ASKED + item.accountKey;
    const map = { ...((await this.store.get<Record<string, string>>(key)) ?? {}) };
    map[item.id] = itemRev(item);
    await this.store.set(key, map);
    await this.index(item.accountKey);
  }

  /** The question was already shown for this item and password revision. */
  async wasAsked(item: ItemView): Promise<boolean> {
    const map = await this.store.get<Record<string, string>>(ASKED + item.accountKey);
    return map?.[item.id] === itemRev(item);
  }

  /**
   * Records still valid for the given items (same password revision). Records whose item has a different
   * revision are dropped from the store; records of items missing from the list are kept (the vault may be
   * partial) but not returned.
   */
  async forAccount(accountKey: string, items: ItemView[]): Promise<Record<string, OutcomeRecord>> {
    const key = PREFIX + accountKey;
    const stored = await this.store.get<Record<string, OutcomeRecord>>(key);
    if (!stored) return {};
    const byId = new Map(items.map((i) => [i.id, i]));
    const valid: Record<string, OutcomeRecord> = {};
    const kept: Record<string, OutcomeRecord> = {};
    let dropped = false;
    for (const [id, rec] of Object.entries(stored)) {
      const cur = byId.get(id);
      if (!cur) kept[id] = rec;
      else if (rec.rev === itemRev(cur)) valid[id] = kept[id] = rec;
      else dropped = true;
    }
    if (dropped) await this.store.set(key, kept);
    return valid;
  }

  async clear(accountKey?: string): Promise<void> {
    const idx = (await this.store.get<string[]>(INDEX)) ?? [];
    if (accountKey === undefined) {
      // everything learned for this feature, including the hosts the user never wants to be asked about
      await this.store.remove([...idx.flatMap((k) => [PREFIX + k, ASKED + k]), INDEX, NEVER_ASK_KEY]);
      return;
    }
    await this.store.remove([PREFIX + accountKey, ASKED + accountKey]);
    await this.store.set(INDEX, idx.filter((k) => k !== accountKey));
  }
}
