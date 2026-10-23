// Login outcome tracking in the notification service: a submitted login that equals a stored item is
// observed after the page settles; certain outcomes are recorded silently, unclear ones are asked about
// only when the item conflicts with another entry (same site + username, different password).
import "./chrome-stub";
import { localData, resetStorage, sessionData } from "./chrome-stub";
import { NotificationService } from "../src/background/notify";
import { LoginOutcomes } from "../src/background/login-outcomes";
import { VaultService } from "../src/background/vault-service";
import { local } from "../src/background/store";
import { CipherType, DEFAULT_SETTINGS, type ItemView } from "../src/shared/types";
import type { CollectResult } from "../src/shared/messages";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const LOGIN_URL = "https://example.de/login";

const login = (accountKey: string, id: string, username: string, password: string): ItemView =>
  ({
    accountKey,
    id,
    type: CipherType.Login,
    name: "Example " + id,
    edit: true,
    revisionDate: "2026-01-01T00:00:00Z",
    login: { username, password, uris: [{ uri: "https://example.de", match: null }], passkeys: 0, passwordRevisionDate: "2026-01-01" },
  }) as unknown as ItemView;

// A and B conflict (same site + username, different passwords), C has no duplicate
const A = login("a1", "A", "alex", "pw-one");
const B = login("a2", "B", "alex", "pw-two");
const C = login("a1", "C", "bob", "pw-bob");
const ITEMS = [A, B, C];

const frame = (url: string, over: Partial<CollectResult> = {}): CollectResult => ({
  url,
  origin: new URL(url).origin,
  hasPassword: false,
  hasNewPassword: false,
  hasUsername: false,
  hasTotp: false,
  cardFields: 0,
  hasCardNumber: false,
  identityFields: 0,
  fields: [],
  ...over,
});
const SUCCESS = { url: "https://example.de/home", topFrame: frame("https://example.de/home"), frames: [] };
const FAILURE = { url: LOGIN_URL, topFrame: frame(LOGIN_URL, { hasPassword: true, hasUsername: true }), frames: [] };

const updated: ((tabId: number, info: any) => void)[] = [];
(globalThis as any).chrome.tabs.onUpdated = { addListener: (f: any) => updated.push(f), removeListener() {} };
const sent: any[] = [];
(globalThis as any).chrome.tabs.sendMessage = async (_tab: number, msg: any) => {
  sent.push(msg);
};

const svc: any = Object.create(VaultService.prototype);
svc.ready = Promise.resolve();
svc.accounts = [{ key: "a1" }, { key: "a2" }];
svc.settings = { ...DEFAULT_SETTINGS };
svc.matchesForUrl = async () => ITEMS;
svc.findItem = async (accountKey: string, id: string) => ITEMS.find((i) => i.accountKey === accountKey && i.id === id);
svc.getVault = async () => ({ items: ITEMS, folders: [] });
svc.isUnlocked = () => true;
svc.publicAccounts = () => [
  { key: "a1", status: "unlocked", label: "Privat", color: "#123456", initials: "P", serverLabel: "example.de" },
  { key: "a2", status: "unlocked", label: "Arbeit", color: "#654321", initials: "A", serverLabel: "example.de" },
];

let probeState: any = null;
const outcomes = new LoginOutcomes(local);
const ns: any = new (NotificationService as any)(
  svc,
  { injectContentScript: async () => {}, probe: async () => probeState },
  outcomes,
);

const settle = () => new Promise((r) => setTimeout(r, 30));

async function reset(over: Record<string, unknown> = {}) {
  resetStorage();
  sent.length = 0;
  svc.settings = { ...DEFAULT_SETTINGS, ...over };
}

/** submit a login form on tab 1, then let the page navigate and finish loading */
async function submit(username: string, password: string, state: any, extra: Record<string, string> = {}) {
  probeState = state;
  await ns.capture({ url: LOGIN_URL, username, password, ...extra }, { tab: { id: 1 }, url: LOGIN_URL, frameId: 0 });
  for (const f of updated) f(1, { status: "loading" });
  await settle();
  for (const f of updated) f(1, { status: "complete" });
  await settle();
}

const recordsOf = (item: ItemView) => outcomes.forAccount(item.accountKey, [item]);
const notifications = () => sent.filter((m) => m?.cmd === "showNotification");

async function kinds(): Promise<string[]> {
  const out: string[] = [];
  for (const m of notifications()) out.push((await ns.dataFor(m.token)).kind);
  return out;
}

async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    check(name, false, String(e?.stack ?? e));
  }
}

(async () => {
  await run("success is recorded silently", async () => {
    await reset();
    await submit("Alex ", "pw-one", SUCCESS);
    const r = await recordsOf(A);
    check("success is recorded silently", r.A?.ok === true && notifications().length === 0, { r, sent });
    check("success: other items untouched", Object.keys(await recordsOf(B)).length === 0);
    check("success: attempt dropped", sessionData["attempt:1"] === undefined, sessionData["attempt:1"]);
  });

  await run("failure is recorded", async () => {
    await reset();
    await submit("alex", "pw-one", FAILURE);
    const r = await recordsOf(A);
    check("failure is recorded", r.A?.ok === false && notifications().length === 0, { r, sent });
  });

  await run("attempt holds no password", async () => {
    await reset();
    probeState = null;
    await ns.capture({ url: LOGIN_URL, username: "alex", password: "pw-one" }, { tab: { id: 1 }, url: LOGIN_URL, frameId: 0 });
    const a = sessionData["attempt:1"];
    check("attempt stored per tab", !!a && a.items?.length === 1 && a.items[0].itemId === "A" && a.url === LOGIN_URL, a);
    check("attempt holds no password", !!a && !JSON.stringify(a).includes("pw-one"), a);
    for (const f of updated) f(1, { status: "complete" });
    await settle();
  });

  await run("unknown + conflict asks", async () => {
    await reset();
    await submit("alex", "pw-one", null);
    const k = await kinds();
    check("unknown + conflict asks", k.length === 1 && k[0] === "confirmLogin", k);
    const d = await ns.dataFor(notifications()[0]?.token);
    check(
      "question names the item and its account",
      d.confirmItem?.name === "Example A" && d.confirmItem.accountLabel === "Privat" && d.confirmItem.accountColor === "#123456",
      d,
    );
    check("nothing recorded before the answer", Object.keys(await recordsOf(A)).length === 0);
  });

  await run("unknown without conflict does not ask", async () => {
    await reset();
    await submit("bob", "pw-bob", null);
    check("unknown without conflict does not ask", notifications().length === 0, sent);
    check("unknown without conflict records nothing", Object.keys(await recordsOf(C)).length === 0);
  });

  await run("answer yes", async () => {
    await reset();
    await submit("alex", "pw-one", null);
    const tok = notifications()[0]?.token;
    await ns.answer(tok, "yes");
    const r = await recordsOf(A);
    check("answer yes records success", r.A?.ok === true, r);
    check("answer yes: token used up", (await ns.dataFor(tok)).kind === "none");
    sent.length = 0;
    await submit("alex", "pw-one", null);
    check("asked at most once per item and password", notifications().length === 0, sent);
  });

  await run("answer no", async () => {
    await reset();
    await submit("alex", "pw-one", null);
    await ns.answer(notifications()[0]?.token, "no");
    const r = await recordsOf(A);
    check("answer no records failure", r.A?.ok === false, r);
  });

  await run("answer never", async () => {
    await reset();
    await submit("alex", "pw-one", null);
    await ns.answer(notifications()[0]?.token, "never");
    check("never adds the host to the never-ask list", (localData.neverAskOutcome ?? []).includes("example.de"), localData);
    check("never records nothing", Object.keys(await recordsOf(A)).length === 0);
    check("never does not touch the save never-list", !(localData.neverDomains ?? []).includes("example.de"), localData);
    sent.length = 0;
    await submit("alex", "pw-one", null);
    check("never-ask host is not asked again", notifications().length === 0, sent);
    await submit("alex", "pw-one", SUCCESS);
    check("never-ask host still records silently", (await recordsOf(A)).A?.ok === true);
  });

  await run("answer with an unknown token", async () => {
    await reset();
    const err = await Promise.resolve(ns.answer("nope", "yes")).then(
      () => null,
      (e: any) => e,
    );
    check("answer with an unknown token records nothing", Object.keys(await recordsOf(A)).length === 0, String(err));
  });

  await run("tracking works with both save prompts off", async () => {
    await reset({ promptSave: false, promptUpdate: false });
    await submit("alex", "pw-one", SUCCESS);
    check("tracking works with both save prompts off", (await recordsOf(A)).A?.ok === true);
    await reset({ promptSave: false, promptUpdate: false });
    await submit("alex", "pw-one", null);
    check("question works with both save prompts off", (await kinds()).join() === "confirmLogin", sent);
  });

  await run("never-domain", async () => {
    await reset();
    localData.neverDomains = ["example.de"];
    await submit("alex", "pw-one", SUCCESS);
    check("never-domain: nothing recorded", Object.keys(await recordsOf(A)).length === 0);
    localData.neverDomains = ["example.de"];
    await submit("alex", "pw-one", null);
    check("never-domain: nothing asked", notifications().length === 0, sent);
  });

  await run("save prompt due wins over the question", async () => {
    await reset();
    await submit("alex", "pw-three", null);
    const k = await kinds();
    check("save prompt due wins over the question", k.length === 1 && (k[0] === "update" || k[0] === "save"), k);
    check("unsaved password: nothing recorded", Object.keys(await recordsOf(A)).length === 0 && Object.keys(await recordsOf(B)).length === 0);
  });

  await run("change-password form is no login attempt", async () => {
    await reset();
    await submit("alex", "pw-one", SUCCESS, { newPassword: "pw-new", currentPassword: "pw-one" });
    check("change-password form is no login attempt", Object.keys(await recordsOf(A)).length === 0);
  });

  await run("trackLoginOutcome off", async () => {
    await reset({ trackLoginOutcome: false });
    await submit("alex", "pw-one", SUCCESS);
    check("trackLoginOutcome off: nothing recorded", Object.keys(await recordsOf(A)).length === 0);
    await reset({ trackLoginOutcome: false });
    await submit("alex", "pw-one", null);
    check("trackLoginOutcome off: nothing asked", notifications().length === 0, sent);
  });

  await run("askLoginOutcome off", async () => {
    await reset({ askLoginOutcome: false });
    await submit("alex", "pw-one", null);
    check("askLoginOutcome off: nothing asked", notifications().length === 0, sent);
  });

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
})();
