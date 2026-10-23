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
const BASE_ITEMS = [A, B, C];
let ITEMS = BASE_ITEMS;

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
/** replaces the probe for one test (reset() restores the default) */
let probeImpl: (() => Promise<any>) | null = null;
const outcomes = new LoginOutcomes(local);
const ns: any = new (NotificationService as any)(
  svc,
  { injectContentScript: async () => {}, probe: async () => (probeImpl ? probeImpl() : probeState) },
  outcomes,
);

const settle = () => new Promise((r) => setTimeout(r, 30));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a bit more than SHOW_DELAY (2.5 s) of notify.ts */
const DELAY = 2700;

async function reset(over: Record<string, unknown> = {}) {
  resetStorage();
  sent.length = 0;
  probeImpl = null;
  ITEMS = BASE_ITEMS;
  svc.settings = { ...DEFAULT_SETTINGS, ...over };
}

/** submit without any navigation: only the SPA timer observes */
async function submitSpa(username: string, password: string) {
  await ns.capture({ url: LOGIN_URL, username, password }, { tab: { id: 1 }, url: LOGIN_URL, frameId: 0 });
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

  // an attempt needs an exact saved match, so no save/update prompt is ever due for it (the guard in
  // notify.ts is defensive); this checks the reachable case: an unsaved password gets the prompt only
  await run("unsaved password: update prompt, no question", async () => {
    await reset();
    await submit("alex", "pw-three", null);
    const k = await kinds();
    check("unsaved password: update prompt, no question", k.length === 1 && (k[0] === "update" || k[0] === "save"), k);
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

  await run("closed question is not asked again", async () => {
    await reset();
    await submit("alex", "pw-one", null);
    const tok = notifications()[0]?.token;
    check("closed question: first asked", !!tok);
    await ns.close(tok);
    check("closed question: nothing recorded", Object.keys(await recordsOf(A)).length === 0);
    check("closed question: marker holds no password", !JSON.stringify(localData).includes("pw-one"), localData);
    sent.length = 0;
    await submit("alex", "pw-one", null);
    check("closed question is not asked again", notifications().length === 0, sent);
    // a new password revision of the item invalidates the marker
    ITEMS = [login("a1", "A", "alex", "pw-one"), B, C];
    (ITEMS[0].login as any).passwordRevisionDate = "2026-02-02";
    sent.length = 0;
    await submit("alex", "pw-one", null);
    check("changed password revision: asked again", (await kinds()).join() === "confirmLogin", sent);
    // clearing the stored outcomes clears the markers too
    ITEMS = BASE_ITEMS;
    await ns.close(notifications()[0]?.token);
    await outcomes.clear();
    sent.length = 0;
    await submit("alex", "pw-one", null);
    check("after clearing outcomes: asked again", (await kinds()).join() === "confirmLogin", sent);
  });

  await run("no question on a page blocked for autofill", async () => {
    const away = { url: "https://sso.example.org/x", topFrame: frame("https://sso.example.org/x"), frames: [] };
    await reset();
    await submit("alex", "pw-one", away);
    check("control: unknown on another site asks", (await kinds()).join() === "confirmLogin", sent);
    await reset({ blockedDomains: ["sso.example.org"] });
    await submit("alex", "pw-one", away);
    check("no question on a page blocked for autofill", notifications().length === 0, sent);
  });

  await run("shared organization item", async () => {
    await reset();
    // the same organization item seen through both accounts; findDuplicates keeps only the first copy
    const S1 = { ...login("a1", "S", "alex", "pw-one"), organizationId: "org1" } as ItemView;
    const S2 = { ...login("a2", "S", "alex", "pw-one"), organizationId: "org1" } as ItemView;
    ITEMS = [S1, S2, B, C];
    await outcomes.record(S1, true); // the first copy is known, the second is not
    await submit("alex", "pw-one", null);
    const d = notifications()[0] ? await ns.dataFor(notifications()[0].token) : null;
    check("shared item: conflict found through the other account's copy", d?.kind === "confirmLogin" && d.confirmItem?.accountLabel === "Arbeit", d);
  });

  await run("SPA timer path", async () => {
    await reset({ promptSave: false, promptUpdate: false });
    probeState = SUCCESS;
    await submitSpa("alex", "pw-one");
    await sleep(DELAY);
    check("SPA timer path records success without navigation", (await recordsOf(A)).A?.ok === true);
  });

  await run("SPA failure is re-checked", async () => {
    await reset({ promptSave: false, promptUpdate: false });
    let calls = 0;
    probeImpl = async () => (++calls === 1 ? FAILURE : SUCCESS);
    await submitSpa("alex", "pw-one");
    await sleep(DELAY);
    check("SPA failure: not recorded on the first look", Object.keys(await recordsOf(A)).length === 0, await recordsOf(A));
    await sleep(DELAY);
    const r = await recordsOf(A);
    check("SPA slow login: form gone on re-check is no failure", r.A?.ok !== false && calls === 2, { r, calls });
  });

  await run("SPA failure confirmed on re-check", async () => {
    await reset({ promptSave: false, promptUpdate: false });
    probeState = FAILURE;
    await submitSpa("alex", "pw-one");
    await sleep(2 * DELAY);
    check("SPA failure confirmed on re-check is recorded", (await recordsOf(A)).A?.ok === false);
  });

  await run("timer and navigation overlap", async () => {
    await reset({ promptSave: false, promptUpdate: false });
    let release: (v: any) => void = () => {};
    let calls = 0;
    probeImpl = () => (++calls === 1 ? new Promise((r) => (release = r)) : Promise.resolve(SUCCESS));
    await submitSpa("alex", "pw-one");
    await sleep(DELAY); // the timer's probe is now running
    for (const f of updated) f(1, { status: "loading" });
    await settle();
    for (const f of updated) f(1, { status: "complete" });
    await settle();
    release(FAILURE); // the timer saw the old login page
    await settle();
    await settle();
    const r = await recordsOf(A);
    check("overlap: old page seen by the timer is no failure", r.A?.ok !== false, { r, calls });
    check("overlap: the load-complete observation decides", r.A?.ok === true && calls === 2, { r, calls });
  });

  console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
})();
