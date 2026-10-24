// "Move into my personal vault": an organization item is copied into the personal vault of the same
// account, and only then the original goes to the organization's trash. The original is kept when the
// copy is incomplete (attachment failed) and a failed removal is reported, never hidden.
import "./chrome-stub";
import { canCopyInto } from "../src/shared/items";
import { VaultService } from "../src/background/vault-service";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};
const rejectsWith = async (p: Promise<unknown>, part: string) => p.then(() => false, (e) => String(e?.message ?? e).includes(part));

const A = "a.test|user-a";
const B = "b.test|user-b";

// copy targets: another account always, the own account only for organization items
check("personal item → other account", canCopyInto({ accountKey: A, organizationId: null }, B));
check("personal item → same account refused", !canCopyInto({ accountKey: A, organizationId: null }, A));
check("org item → own personal vault", canCopyInto({ accountKey: A, organizationId: "org1" }, A));
check("org item → other account", canCopyInto({ accountKey: A, organizationId: "org1" }, B));

(async () => {
  const items: Record<string, any> = {
    org1: { id: "org1", accountKey: A, organizationId: "org1", name: "Router", edit: true, revisionDate: "r1" },
    stale1: { id: "stale1", accountKey: A, organizationId: "org1", name: "Alt", edit: true, revisionDate: "r0" },
    own1: { id: "own1", accountKey: A, organizationId: null, name: "Privat", edit: true },
  };
  const calls: string[] = [];
  let attachmentsFailed: string[] = [];
  let deleteFails = false;
  const svc: any = Object.create(VaultService.prototype);
  svc.findItem = async (_acc: string, id: string) => items[id];
  svc.copyItemToAccount = async (src: string, id: string, target: string, folder: string | null) => {
    calls.push(`copy ${src} ${id} ${target} ${folder}`);
    return { id: "new1", attachmentsFailed };
  };
  svc.sync = async () => {};
  svc.rawSync = async () => ({ ciphers: [{ id: "org1", revisionDate: "r1" }, { id: "stale1", revisionDate: "r1" }] });
  svc.account = (k: string) => ({ key: k });
  svc.api = () => ({
    send: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (deleteFails) throw new Error("Keine Berechtigung");
    },
  });
  const move = svc.moveItemToPersonal?.bind(svc);
  check("moveItemToPersonal exists", typeof move === "function");
  if (typeof move !== "function") {
    console.log(`${failed} FAILED`);
    process.exit(1);
  }

  const r1 = await move(A, "org1", "f1");
  check("copies into the own personal vault", calls[0] === `copy ${A} org1 ${A} f1`, calls);
  check("then moves the original to the trash (not permanently)", calls[1] === "PUT /ciphers/org1/delete", calls);
  check("reports success", r1.id === "new1" && r1.originalRemoved === true && !r1.removeError, r1);

  calls.length = 0;
  attachmentsFailed = ["plan.pdf"];
  const r2 = await move(A, "org1", null);
  check("incomplete copy keeps the original", calls.length === 1 && r2.originalRemoved === false, { calls, r2 });
  check("incomplete copy reports the attachment", JSON.stringify(r2.attachmentsFailed) === JSON.stringify(["plan.pdf"]), r2);
  attachmentsFailed = [];

  calls.length = 0;
  deleteFails = true;
  const r3 = await move(A, "org1", null);
  check("failed removal is reported, copy kept", r3.id === "new1" && r3.originalRemoved === false && /Berechtigung/.test(r3.removeError ?? ""), r3);
  deleteFails = false;

  calls.length = 0;
  let first = true;
  svc.sync = async () => {
    // the sync before the copy works, the one after it fails
    if (!first) throw new Error("offline");
    first = false;
  };
  const r4 = await move(A, "org1", null);
  check("failed sync after the copy keeps the original", r4.originalRemoved === false && calls.length === 1 && /offline/.test(r4.removeError ?? ""), { calls, r4 });
  svc.sync = async () => {};

  calls.length = 0;
  check("personal item refused", await rejectsWith(move(A, "own1", null), "Organisation"));
  check("unknown item refused", await rejectsWith(move(A, "nope", null), "nicht gefunden"));
  check("decrypted view older than the server refused", await rejectsWith(move(A, "stale1", null), "aktualisiert"));
  check("refusals change nothing", calls.length === 0, calls);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
