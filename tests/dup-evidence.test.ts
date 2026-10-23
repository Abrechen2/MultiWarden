// Evidence and recommendation per duplicate group: outcomes, then history, then password date; cautious removal.
import "./chrome-stub";
import { CipherType, ItemView } from "../src/shared/types";
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
  const a = login("a1", { password: "pw1", pwDate: "2025-09-01T00:00:00Z" });
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
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { a1: { at: 2000, ok: true, rev: "x" } } } };
  const r = assessGroup(group([a, b], false), ev, fn);
  check("success record beats history", r.recommended === a && r.outdated.has(b) && !r.outdated.has(a) && ids(r.removable).join() === "b1", r);
}
{
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { new: { at: 2000, ok: false, rev: "x" } } } };
  const r = assessGroup(group([oldI, newI], false), ev, fn);
  check("latest failure outdates a variant", r.outdated.has(newI) && r.recommended === oldI && ids(r.removable).join() === "new", r);
}
{
  const ev: Evidence = { lastUsed: {}, outcomes: { a: { old: { at: 1000, ok: false, rev: "x" }, new: { at: 2000, ok: false, rev: "x" } } } };
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

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
