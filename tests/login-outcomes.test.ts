// Per-item login outcomes: the store keeps success/failure, time and the password revision of the
// item at that moment (never a password or a hash); a changed password invalidates the record.
import "./chrome-stub";
import { itemRev, LoginOutcomes } from "../src/background/login-outcomes";
import type { ItemView } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

function memStore() {
  const m = new Map<string, unknown>();
  return {
    m,
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async set(k: string, v: unknown) {
      m.set(k, JSON.parse(JSON.stringify(v)));
    },
    async remove(k: string | string[]) {
      for (const x of Array.isArray(k) ? k : [k]) m.delete(x);
    },
  };
}

const item = (id: string, over: Partial<ItemView> & { rev?: string | null } = {}): ItemView =>
  ({
    id,
    accountKey: over.accountKey ?? "a1",
    name: id,
    login: { username: "u", password: "s3cret-pw-" + id, uris: [], passkeys: 0, passwordRevisionDate: over.rev === undefined ? "2026-01-01" : over.rev },
    revisionDate: over.revisionDate,
  }) as unknown as ItemView;

(async () => {
  {
    const s = memStore();
    const o = new LoginOutcomes(s);
    const it = item("i1");
    await o.record(it, true, 1000);
    const r = await o.forAccount("a1", [it]);
    check("record then forAccount returns it", r.i1?.at === 1000 && r.i1.ok === true && r.i1.rev === "2026-01-01", r);
  }
  {
    const o = new LoginOutcomes(memStore());
    const it = item("i1");
    await o.record(it, true, 1000);
    await o.record(it, false, 2000);
    const r = await o.forAccount("a1", [it]);
    check("record keeps only the latest per item", r.i1.at === 2000 && r.i1.ok === false && Object.keys(r).length === 1, r);
  }
  {
    const s = memStore();
    const o = new LoginOutcomes(s);
    await o.record(item("i1"), true, 1000);
    await o.record(item("i2"), true, 1000);
    const r = await o.forAccount("a1", [item("i1", { rev: "2026-06-01" }), item("i2")]);
    const stored = s.m.get("loginOutcome:a1") as Record<string, unknown>;
    check("a password change hides the record", !r.i1 && !!r.i2, r);
    check("a password change prunes the stored record", !("i1" in stored) && "i2" in stored, stored);
  }
  {
    const o = new LoginOutcomes(memStore());
    const it = item("i1", { rev: null, revisionDate: "2026-02-02" });
    check("itemRev falls back to revisionDate", itemRev(it) === "2026-02-02");
    await o.record(it, true, 5);
    const r = await o.forAccount("a1", [it]);
    check("fallback rev uses revisionDate", r.i1?.rev === "2026-02-02", r);
  }
  {
    const s = memStore();
    const o = new LoginOutcomes(s);
    await o.record(item("i1", { accountKey: "a1" }), true, 1);
    await o.record(item("i2", { accountKey: "a2" }), true, 1);
    await o.clear("a1");
    check("clear(account) removes only that account", !s.m.has("loginOutcome:a1") && s.m.has("loginOutcome:a2"), [...s.m.keys()]);
    await o.record(item("i1", { accountKey: "a1" }), true, 1);
    await o.clear();
    check("clear() removes all", !s.m.has("loginOutcome:a1") && !s.m.has("loginOutcome:a2"), [...s.m.keys()]);
  }
  {
    const s = memStore();
    const o = new LoginOutcomes(s);
    const it = item("i1");
    await o.record(it, true, 1);
    const json = JSON.stringify([...s.m.entries()]);
    check("stored value contains no password", !json.includes(it.login!.password!), json);
  }
  process.exit(failed ? (console.log(failed + " FAILED"), 1) : (console.log("ALL PASSED"), 0));
})();
