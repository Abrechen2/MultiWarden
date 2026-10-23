// Evidence and recommendation per duplicate group: outcomes, then history, then password date; cautious removal.
import "./chrome-stub";
import { CipherType, ItemView, OutcomeRecord } from "../src/shared/types";
import { assessGroup, Evidence } from "../src/shared/dup-evidence";
import { DuplicateGroup } from "../src/shared/duplicates";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

type Opts = Partial<ItemView> & { password?: string; totp?: string; pwDate?: string; history?: string[] };
const login = (id: string, o: Opts = {}): ItemView => ({
  id,
  accountKey: o.accountKey ?? "a",
  collectionIds: [],
  type: o.type ?? CipherType.Login,
  name: "Example",
  favorite: false,
  reprompt: 0,
  edit: o.edit ?? true,
  viewPassword: true,
  folderId: null,
  login: { username: "alex", password: o.password, totp: o.totp, uris: [{ uri: "https://example.de" }], passkeys: 0, passwordRevisionDate: o.pwDate },
  fields: [],
  passwordHistory: (o.history ?? []).map((password) => ({ password, lastUsedDate: "2025-01-01T00:00:00Z" })),
  attachments: [],
  revisionDate: o.revisionDate,
  creationDate: o.creationDate,
});
const group = (items: ItemView[], samePassword?: boolean): DuplicateGroup => ({ key: "k", type: items[0].type, label: "l", items, samePassword });
const none: Evidence = { lastUsed: {}, outcomes: {} };
const fn = () => "";
const ids = (xs: ItemView[]) => xs.map((x) => x.id).sort();

const oldI = login("old", { password: "pw1", pwDate: "2024-01-01T00:00:00Z" });
const newI = login("new", { password: "pw2", pwDate: "2025-06-01T00:00:00Z" });

{
  const r = assessGroup(group([oldI, newI], false), none, fn);
  check("newest password date recommends but does not remove", r.recommended === newI && r.removable.length === 0 && r.outdated.size === 0 && !r.unclear, r);
  check("keep holds both variants", ids(r.keep).join() === "new,old");
}
{
  // (R19: a's password must be older than b's change, else the history predates it and says nothing)
  const a = login("a1", { password: "pw1", pwDate: "2024-09-01T00:00:00Z" });
  const b = login("b1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", history: ["pw1"] });
  const r = assessGroup(group([a, b], false), none, fn);
  check("password in other entry's history marks outdated and removable", r.outdated.has(a) && r.recommended === b && ids(r.removable).join() === "a1" && r.evidence.get(a)?.supersededBy === b, r);
}
{
  const a = login("a1", { password: "pw1", pwDate: "2025-09-01T00:00:00Z", history: ["pw2"] });
  const b = login("b1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", history: ["pw1"] });
  const r = assessGroup(group([a, b], false), none, fn);
  check("two-way history decides nothing", r.outdated.size === 0 && r.recommended === a && r.removable.length === 0, r);
}
{
  const a = login("a1", { password: "pw1", pwDate: "2024-01-01T00:00:00Z" });
  const b = login("b1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", history: ["pw1"] });
  // R15: the success record (at 2000 ms, 1970) is older than b's password change: b may be the newer, working one
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { a1: { at: 2000, ok: true, rev: "x" } } } };
  const r = assessGroup(group([a, b], false), ev, fn);
  check("success record older than another variant's password change does not win", r.recommended === b && !r.outdated.has(b) && !r.removable.includes(b), r);
  check("success record older than another variant's password change outdates nothing", r.outdated.size === 0 && r.removable.length === 0, r);
}
{
  // regression: A and B shared P_old, success recorded for A, later the password was changed in B only
  const recAt = Date.parse("2026-03-01T00:00:00Z");
  const a = login("A", { password: "P_old", pwDate: "2026-01-01T00:00:00Z" });
  const b = login("B", { password: "P_new", pwDate: "2026-05-01T00:00:00Z", history: ["P_old"] });
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { A: { at: recAt, ok: true, rev: "2026-01-01T00:00:00Z" } } } };
  const r = assessGroup(group([a, b], false), ev, fn);
  check("stale success: the newer password is not removable", !r.removable.includes(b) && !r.outdated.has(b), r);
  check("stale success: the newer password is recommended by its date", r.recommended === b && !r.unclear, r);
  check("stale success: the entry with the success record is not removed either", !r.removable.includes(a), r);
}
{
  // a success record newer than every other variant's password date still wins (rule 1)
  const a = login("a1", { password: "pw1", pwDate: "2024-01-01T00:00:00Z" });
  const b = login("b1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", history: ["pw1"] });
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { a1: { at: Date.parse("2025-06-01T00:00:00Z"), ok: true, rev: "x" } } } };
  const r = assessGroup(group([a, b], false), ev, fn);
  check("newer success record wins over an older password change", r.recommended === a && !r.unclear, r);
  check("winner does not outdate a variant whose history holds the winner's password", !r.outdated.has(b) && !r.removable.includes(b), r);
}
{
  // R16: a variant outdated by a failure is removable only if another variant has a newer success record
  const a = login("a1", { password: "pw1" });
  const b = login("b1", { password: "pw2" });
  const both = (aRec: OutcomeRecord, bRec: OutcomeRecord): Evidence => ({ lastUsed: {}, outcomes: { a: { a1: aRec, b1: bRec } } });
  let r = assessGroup(group([a, b], false), both({ at: 3000, ok: true, rev: "x" }, { at: 2000, ok: false, rev: "x" }), fn);
  check("R16 failure older than another variant's success is removable", r.recommended === a && r.outdated.has(b) && ids(r.removable).join() === "b1", r);
  r = assessGroup(group([a, b], false), both({ at: 1000, ok: true, rev: "x" }, { at: 2000, ok: false, rev: "x" }), fn);
  check("R16 failure newer than every success is outdated but not removable", r.outdated.has(b) && !r.removable.includes(b), r);
}
{
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { new: { at: Date.parse("2025-07-01T00:00:00Z"), ok: false, rev: "x" } } } };
  const r = assessGroup(group([oldI, newI], false), ev, fn);
  check("latest failure outdates a variant", r.outdated.has(newI) && r.recommended === oldI, r);
  check("R16 failure without any success record is not removable", r.removable.length === 0, r);
}
{
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { old: { at: Date.parse("2025-07-01T00:00:00Z"), ok: false, rev: "x" }, new: { at: Date.parse("2025-07-02T00:00:00Z"), ok: false, rev: "x" } } } };
  const r = assessGroup(group([oldI, newI], false), ev, fn);
  check("all variants failed removes nothing", r.removable.length === 0 && r.recommended === null, r);
}
{
  const a = login("a1", { password: "pw1", pwDate: "2025-01-01T00:00:00Z" });
  const b = login("b1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z" });
  const b2 = login("b2", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", revisionDate: "2025-02-01T00:00:00Z" });
  const r = assessGroup(group([a, b, b2], false), none, fn);
  check("tie on password date gives no recommendation", r.recommended === null && r.unclear && ids(r.removable).join() === "b1", r);
}
{
  const a = login("a1", { password: "pw", revisionDate: "2025-05-01T00:00:00Z" });
  const b = login("b1", { password: "pw", revisionDate: "2025-01-01T00:00:00Z" });
  const c = login("c1", { password: "pw", revisionDate: "2024-01-01T00:00:00Z" });
  const ev: Evidence = { lastUsed: { a: { c1: 5000 } }, outcomes: {} };
  const r = assessGroup(group([a, b, c], true), ev, fn);
  check("identical copies keep the most recently used", ids(r.keep).join() === "c1" && ids(r.removable).join() === "a1,b1", r);
  check("same-password group: no recommendation, no evidence", r.recommended === null && !r.unclear && r.evidence.size === 0);
  const r2 = assessGroup(group([a, b, c], true), none, fn);
  check("copies fall back to newest revision", ids(r2.keep).join() === "a1", r2);
  const ev3: Evidence = { lastUsed: { a: { c1: 5000 } }, outcomes: { a: { b1: { at: 1, ok: true, rev: "x" } } } };
  check("success record wins within a variant", ids(assessGroup(group([a, b, c], true), ev3, fn).keep).join() === "b1");
}
{
  const a = login("a1", { password: "pw", revisionDate: "2025-05-01T00:00:00Z", edit: false });
  const b = login("b1", { password: "pw", revisionDate: "2025-01-01T00:00:00Z" });
  const c = login("c1", { password: "pw", revisionDate: "2024-01-01T00:00:00Z", edit: false });
  const r = assessGroup(group([a, b, c], true), none, fn);
  check("read-only items are never removable", ids(r.removable).join() === "b1" && ids(r.keep).join() === "a1", r);
  const o = login("o1", { password: "pw1", pwDate: "2024-01-01T00:00:00Z", edit: false });
  const n = login("n1", { password: "pw2", pwDate: "2025-01-01T00:00:00Z", history: ["pw1"] });
  const r2 = assessGroup(group([o, n], false), none, fn);
  check("read-only outdated variant is not removable", r2.outdated.has(o) && r2.removable.length === 0, r2);
}
{
  const e = login("e1", { password: "", pwDate: "2026-01-01T00:00:00Z" });
  const f = login("f1", { password: "pw", pwDate: "2024-01-01T00:00:00Z" });
  const r = assessGroup(group([e, f], false), none, fn);
  check("empty password is its own variant and never wins on date alone", r.recommended === null && r.unclear && r.removable.length === 0, r);
}
{
  const kept = login("k1", { password: "pw", revisionDate: "2025-05-01T00:00:00Z" });
  const copy = login("c1", { password: "pw", totp: "JBSWY3DP", revisionDate: "2025-01-01T00:00:00Z" });
  const r = assessGroup(group([kept, copy], true), none, fn);
  check("unique fields of a removed copy", JSON.stringify(r.uniqueFieldsOf(copy)) === '["totp"]' && r.uniqueFieldsOf(kept).length === 0, r.uniqueFieldsOf(copy));
}
{
  const note = (id: string, rev: string, type = CipherType.SecureNote): ItemView => ({ ...login(id, { revisionDate: rev, type }), login: undefined });
  const a = note("n1", "2024-01-01T00:00:00Z");
  const b = note("n2", "2025-01-01T00:00:00Z");
  const r = assessGroup(group([a, b]), none, fn);
  check("non-login groups keep newest revision and offer the rest", ids(r.keep).join() === "n2" && ids(r.removable).join() === "n1" && r.recommended === null && !r.unclear && r.evidence.size === 0, r);
}
{
  const r = assessGroup(group([oldI, newI], false), { lastUsed: { a: { old: 7 } }, outcomes: {} }, fn);
  check("evidence per item", r.evidence.get(oldI)?.lastUsed === 7 && r.evidence.get(oldI)?.passwordChanged === "2024-01-01T00:00:00Z" && r.evidence.get(oldI)?.passwordChangedIsCreation === false, r.evidence.get(oldI));
  const c = login("c", { password: "x", creationDate: "2020-01-01T00:00:00Z" });
  const r2 = assessGroup(group([c, oldI], false), none, fn);
  check("password date falls back to creation date", r2.evidence.get(c)?.passwordChanged === "2020-01-01T00:00:00Z" && r2.evidence.get(c)?.passwordChangedIsCreation === true);
}

{
  const mk = (id: string, pw: string, extra: Opts = {}) => login(id, { password: pw, ...extra });
  const rec = (m: Record<string, OutcomeRecord>): Evidence => ({ lastUsed: {}, outcomes: { a: m } });
  const ok = (at: number): OutcomeRecord => ({ at, ok: true, rev: "x" });
  const bad = (at: number): OutcomeRecord => ({ at, ok: false, rev: "x" });
  // S1
  const a = mk("a1", "pw1"), b = mk("b1", "pw2"), c = mk("c1", "pw3", { history: ["pw1"] });
  let r = assessGroup(group([a, b, c], false), rec({ a1: ok(1000), b1: bad(2000) }), fn);
  check("S1 working login is never removable", r.recommended === a && !r.removable.includes(a) && !r.outdated.has(a), r);
  // S2
  const d = mk("d1", "pw4", { pwDate: "2026-01-01T00:00:00Z" });
  // (records after d's password date: R15 lets a newer password change beat an older success record)
  const t0 = Date.parse("2026-02-01T00:00:00Z");
  r = assessGroup(group([a, b, d], false), rec({ a1: ok(t0), b1: bad(t0 + 1000) }), fn);
  check("S2 failure of another variant does not block the winner", r.recommended === a && !r.unclear, r);
  // S3
  const b3 = mk("b3", "pw2", { history: ["pw1"] }), c3 = mk("c3", "pw3");
  r = assessGroup(group([a, b3, c3], false), rec({ b3: bad(2000) }), fn);
  check("S3 history of a failed variant outdates nothing", !r.outdated.has(a) && !r.removable.includes(a), r);
  // R6
  const u = mk("u1", "pw9");
  r = assessGroup(group([a, u], false), rec({ a1: ok(1000) }), fn);
  check("R6 unrelated variant stays undecided", r.recommended === a && r.keep.includes(u) && !r.removable.includes(u), r);
  // success variant pointed at by a third variant's history, no winner (tie)
  const x = mk("x1", "pw1"), y = mk("y1", "pw5"), z = mk("z1", "pw6", { history: ["pw1"] });
  r = assessGroup(group([x, y, z], false), rec({ x1: ok(1000), y1: ok(1000) }), fn);
  check("success variant is not outdated by history", !r.outdated.has(x) && !r.removable.includes(x), r);
}

{
  // R19: a password set after every piece of evidence against it is never outdated by that evidence
  const T = Date.parse("2026-03-01T00:00:00Z");
  const okW = { at: T, ok: true, rev: "x" };
  // W changed from P_v to P_w in January, worked in March; V went back to P_v in May, then a (false) failure in June
  const w = login("W", { password: "P_w", pwDate: "2026-01-01T00:00:00Z", history: ["P_v"] });
  const v = login("V", { password: "P_v", pwDate: "2026-05-01T00:00:00Z", history: ["P_w"] });
  let r = assessGroup(group([w, v], false), { lastUsed: {}, outcomes: { a: { W: okW, V: { at: Date.parse("2026-06-01T00:00:00Z"), ok: false, rev: "x" } } } }, fn);
  check("R19 probe: password set after the success, failed later, is not removable", !r.removable.includes(v), r);
  // one-way history, no failure: V's password set after W's success and after W left P_v
  const v2 = login("V", { password: "P_v", pwDate: "2026-05-01T00:00:00Z" });
  r = assessGroup(group([w, v2], false), { lastUsed: {}, outcomes: { a: { W: okW } } }, fn);
  check("R19 one-way history older than the password: not outdated, not removable", !r.outdated.has(v2) && !r.removable.includes(v2), r);
  // control: V's password date older than W's success and V in W's history -> outdated and removable as before
  const v3 = login("V", { password: "P_v", pwDate: "2025-12-01T00:00:00Z" });
  r = assessGroup(group([w, v3], false), { lastUsed: {}, outcomes: { a: { W: okW } } }, fn);
  check("R19 control: older password in the winner's history stays outdated and removable", r.recommended === w && r.outdated.has(v3) && r.removable.includes(v3), r);
  // the winner loop no longer bypasses R16 for a failed variant in the winner's history
  const v4 = login("V", { password: "P_v", pwDate: "2025-12-01T00:00:00Z" });
  r = assessGroup(group([w, v4], false), { lastUsed: {}, outcomes: { a: { W: okW, V: { at: T + 1000, ok: false, rev: "x" } } } }, fn);
  check("R19 winner history does not make a failure newer than every success removable", r.outdated.has(v4) && !r.removable.includes(v4), r);
}

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
