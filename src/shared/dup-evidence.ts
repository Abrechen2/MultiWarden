// Evidence and a cautious recommendation for a duplicate group (pure: no I/O, no secrets leave this module).
import { compareGroup, DuplicateGroup } from "./duplicates";
import { CipherType, ItemView, OutcomeRecord } from "./types";

/** Same shape as the `usageEvidence` RPC result; keyed by accountKey, then item id. */
export interface Evidence {
  lastUsed: Record<string, Record<string, number>>;
  outcomes: Record<string, Record<string, OutcomeRecord>>;
}

export interface ItemEvidence {
  /** when the password last changed (ISO); falls back to the creation date */
  passwordChanged?: string;
  passwordChangedIsCreation: boolean;
  lastUsed?: number;
  outcome?: OutcomeRecord;
  /** the entry that replaces this one when its variant is outdated */
  supersededBy?: ItemView;
}

export interface GroupAssessment {
  /** only filled for login groups with differing passwords */
  evidence: Map<ItemView, ItemEvidence>;
  /** "vermutlich aktuell": only for login groups with differing passwords and a decisive rule */
  recommended: ItemView | null;
  /** differing passwords, but no rule decides: "Unklar – bitte selbst prüfen" */
  unclear: boolean;
  /** every entry of a variant that rule 1 (failure, or history of the winner) or rule 2 (history) marked outdated */
  outdated: Set<ItemView>;
  /**
   * The entries that stay after a bulk cleanup: the entry to keep of every variant that is not removed
   * (the recommended variant, undecided variants, and outdated variants that could not be removed);
   * for groups without differing passwords the single entry to keep.
   */
  keep: ItemView[];
  /**
   * strong-evidence removals only: identical copies, whole variants outdated by history, and variants outdated
   * by a failure when another variant has a newer success; never read-only entries
   */
  removable: ItemView[];
  /** field keys (see FieldDiff.key) that `removed` has and that differ from (or are empty in) every entry that stays */
  uniqueFieldsOf: (removed: ItemView) => string[];
}

const time = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);

/** Password date of an item and whether it is only the creation date. */
function passwordDate(item: ItemView): { iso?: string; isCreation: boolean } {
  const rev = item.login?.passwordRevisionDate;
  if (rev && Number.isFinite(time(rev))) return { iso: rev, isCreation: false };
  if (item.creationDate && Number.isFinite(time(item.creationDate))) return { iso: item.creationDate, isCreation: true };
  return { isCreation: false };
}

const pwOf = (i: ItemView) => i.login?.password ?? "";

/** Entry to keep among identical copies: success record, then most recent use, then newest revision. */
function pickKeep(items: ItemView[], ev: Evidence): ItemView {
  const score = (i: ItemView): [number, number, number] => {
    const o = ev.outcomes[i.accountKey]?.[i.id];
    const rev = time(i.revisionDate);
    return [o?.ok ? 1 : 0, ev.lastUsed[i.accountKey]?.[i.id] ?? 0, Number.isFinite(rev) ? rev : 0];
  };
  return items.reduce((best, cur) => {
    const a = score(best);
    const b = score(cur);
    for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return b[k] > a[k] ? cur : best;
    return best;
  });
}

interface Variant {
  password: string;
  items: ItemView[];
  keep: ItemView;
  /** newest outcome record of any member */
  latest?: OutcomeRecord;
  /** newest password date (ms), NaN if unknown */
  date: number;
}

const removableOf = (items: ItemView[], keep: ItemView) => items.filter((i) => i !== keep && i.edit !== false);

/**
 * Evidence-based assessment of a duplicate group. The rules (see the design spec): login outcomes first,
 * then password history, then the unique newest password date; anything else is unclear. Only
 * identical copies and variants outdated by outcomes or history are offered for removal.
 */
export function assessGroup(group: DuplicateGroup, ev: Evidence, folderName: (i: ItemView) => string): GroupAssessment {
  const items = group.items;
  const evidence = new Map<ItemView, ItemEvidence>();
  const outdated = new Set<ItemView>();
  let recommended: ItemView | null = null;
  let unclear = false;
  let keep: ItemView[];
  let removable: ItemView[];

  if (group.type !== CipherType.Login || group.samePassword !== false) {
    const k = pickKeep(items, ev);
    keep = [k];
    removable = removableOf(items, k);
  } else {
    const byPw = new Map<string, ItemView[]>();
    for (const i of items) byPw.set(pwOf(i), [...(byPw.get(pwOf(i)) ?? []), i]);
    const variants: Variant[] = [...byPw].map(([password, members]) => {
      const records = members.map((m) => ev.outcomes[m.accountKey]?.[m.id]).filter((r): r is OutcomeRecord => !!r);
      const dates = members.map((m) => time(passwordDate(m).iso)).filter(Number.isFinite);
      return {
        password,
        items: members,
        keep: pickKeep(members, ev),
        latest: records.reduce<OutcomeRecord | undefined>((a, r) => (!a || r.at > a.at ? r : a), undefined),
        date: dates.length ? Math.max(...dates) : NaN,
      };
    });
    const nonEmpty = (v: Variant) => v.password !== "";
    const supersededBy = new Map<Variant, Variant | undefined>();
    /** outdated variants whose removal is backed by strong evidence (history, or a failure answered by a newer success) */
    const droppable = new Set<Variant>();
    const markOutdated = (v: Variant, by: Variant | undefined, strong: boolean) => {
      if (!supersededBy.has(v) || (!supersededBy.get(v) && by)) supersededBy.set(v, by);
      if (strong) droppable.add(v);
    };
    const inHistoryOf = (v: Variant, other: Variant) =>
      nonEmpty(v) && other.items.some((i) => i.passwordHistory.some((h) => h.password === v.password));

    // rule 1: outcomes; a variant whose latest record is a failure is outdated
    const failed = variants.filter((v) => v.latest && !v.latest.ok);
    const succeeded = variants.filter((v) => v.latest?.ok);
    const newestOk = succeeded.length ? Math.max(...succeeded.map((v) => v.latest!.at)) : -1;
    const top = succeeded.filter((v) => v.latest!.at === newestOk);
    // a failure of another variant does not undo a success; a password changed after the success record
    // may be the one that works now (the record then only shows that the older password worked back then)
    const changedSince = (w: Variant) =>
      variants.some((v) => v !== w && nonEmpty(v) && !failed.includes(v) && v.date > w.latest!.at);
    let winner: Variant | undefined = top.length === 1 && !changedSince(top[0]) ? top[0] : undefined;
    // a failure alone may be wrong (typo-free mistakes, outages, misread pages): removal needs a newer success elsewhere
    for (const v of failed) markOutdated(v, winner, succeeded.some((u) => u !== v && u.latest!.at > v.latest!.at));

    if (winner) {
      // the observation says which side of a password change is live: only a password in the winner's
      // history is older; a variant holding the winner's password in its history changed later and stays
      for (const v of variants) if (v !== winner && !v.latest?.ok && inHistoryOf(v, winner)) markOutdated(v, winner, true);
    } else {
      // rule 2: a password found in another entry's history is outdated, unless that goes both ways.
      // History of a variant that failed counts for nothing; a variant with a working login is never outdated by it.
      for (const v of variants)
        for (const u of variants)
          if (u !== v && !v.latest?.ok && !failed.includes(u) && inHistoryOf(v, u) && !inHistoryOf(u, v)) markOutdated(v, u, true);
      // rule 3: the unique newest password date among the variants that are not outdated
      const alive = variants.filter((v) => !supersededBy.has(v));
      if (alive.length === 1 && nonEmpty(alive[0])) winner = alive[0];
      else {
        const dated = alive.filter((v) => Number.isFinite(v.date));
        const newest = dated.length ? Math.max(...dated.map((v) => v.date)) : NaN;
        const best = dated.filter((v) => v.date === newest);
        // an empty password is "not set", not "newest"
        if (best.length === 1 && nonEmpty(best[0])) winner = best[0];
      }
    }
    unclear = !winner;
    recommended = winner?.keep ?? null;

    // wholesale removal of outdated variants needs a variant that stays
    const canDrop = variants.some((v) => !supersededBy.has(v));
    keep = [];
    removable = [];
    for (const v of variants) {
      const by = supersededBy.get(v);
      if (supersededBy.has(v)) for (const i of v.items) outdated.add(i);
      if (droppable.has(v) && canDrop) removable.push(...v.items.filter((i) => i.edit !== false));
      else {
        keep.push(v.keep);
        removable.push(...removableOf(v.items, v.keep));
      }
      for (const i of v.items) {
        const date = passwordDate(i);
        evidence.set(i, {
          passwordChanged: date.iso,
          passwordChangedIsCreation: date.isCreation,
          lastUsed: ev.lastUsed[i.accountKey]?.[i.id],
          outcome: ev.outcomes[i.accountKey]?.[i.id],
          supersededBy: by?.keep,
        });
      }
    }
  }

  const uniqueFieldsOf = (removed: ItemView): string[] => {
    const others = keep.filter((k) => k !== removed);
    if (!others.length) return [];
    const perKeep = others.map(
      (k) => new Set(compareGroup([removed, k], folderName).filter((d) => !d.same && d.variants[0] !== -1).map((d) => d.key)),
    );
    return [...perKeep[0]].filter((key) => perKeep.every((s) => s.has(key)));
  };

  return { evidence, recommended, unclear, outdated, keep, removable, uniqueFieldsOf };
}
