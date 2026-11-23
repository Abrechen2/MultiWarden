// The save/update prompt after a fill: the entry that was just filled into the tab decides, not every login
// that happens to match the URL with the same username. Plus "Ausfüllen und speichern": the page's
// address is added to the chosen entry.
import "./chrome-stub";
import { resetStorage } from "./chrome-stub";
import { NotificationService } from "../src/background/notify";
import { LoginOutcomes } from "../src/background/login-outcomes";
import { recordFill } from "../src/background/filled";
import { VaultService } from "../src/background/vault-service";
import { local } from "../src/background/store";
import { withSiteUri } from "../src/shared/items";
import { CipherType, DEFAULT_SETTINGS, type ItemView } from "../src/shared/types";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const URL_ = "https://192.0.2.10:9443/login";

const login = (id: string, username: string, password: string, uri: string, edit = true): ItemView =>
  ({
    accountKey: "a1",
    id,
    type: CipherType.Login,
    name: "Item " + id,
    edit,
    revisionDate: "2026-01-01T00:00:00Z",
    login: { username, password, uris: [{ uri, match: null }], passkeys: 0 },
  }) as unknown as ItemView;

// the filled entry is stored for another address; three other "admin" logins match the page
const E = login("E", "admin", "right", "https://device.example.de");
const W = [1, 2, 3].map((n) => login("W" + n, "admin", "other-" + n, "https://192.0.2.10:9443"));
let ITEMS: ItemView[] = [E, ...W];

const svc: any = Object.create(VaultService.prototype);
svc.ready = Promise.resolve();
svc.accounts = [{ key: "a1" }];
svc.settings = { ...DEFAULT_SETTINGS };
svc.matchesForUrl = async () => W;
svc.findItem = async (accountKey: string, id: string) => ITEMS.find((i) => i.accountKey === accountKey && i.id === id);
svc.getVault = async () => ({ items: ITEMS, folders: [] });
svc.publicAccounts = () => [{ key: "a1", status: "unlocked", label: "Privat", color: "#123456", initials: "P", serverLabel: "x" }];

const ns: any = new (NotificationService as any)(
  svc,
  { injectContentScript: async () => {}, probe: async () => null },
  new LoginOutcomes(local),
);

const pending = (username: string, password: string, over: Record<string, unknown> = {}) => ({
  token: "t",
  tabId: 1,
  url: URL_,
  host: "192.0.2.10:9443",
  username,
  password,
  created: Date.now(),
  shown: false,
  ...over,
});
const ids = (d: any) => d.targets.map((x: any) => x.itemId).join(",");

(async () => {
  // without a fill: unchanged behaviour (all matching logins with that username)
  resetStorage();
  let d = await ns.data(pending("admin", "right"));
  check("no fill: matching logins offered", d.kind === "update" && ids(d) === "W1,W2,W3", d);

  // filled E, logged in with E's data: nothing to save
  resetStorage();
  await recordFill(1, E, "https://192.0.2.10:9443/login");
  d = await ns.data(pending("admin", "right"));
  check("filled entry unchanged: no prompt", d.kind === "none", d);
  d = await ns.data(pending("", "right"));
  check("filled entry, no username captured: no prompt", d.kind === "none", d);
  d = await ns.data(pending("ADMIN ", "right"));
  check("filled entry, username differs only in case/space: no prompt", d.kind === "none", d);

  // filled E, then typed another password: update E only
  d = await ns.data(pending("admin", "new-pw"));
  check("filled entry, password changed: only that entry", d.kind === "update" && ids(d) === "E", d);

  // change-password form with E's old password
  d = await ns.data(pending("admin", "new-pw", { currentPassword: "right" }));
  check("change-password form: the filled entry", d.kind === "update" && ids(d) === "E", d);

  // another username was submitted: the fill does not decide
  d = await ns.data(pending("root", "right"));
  check("other username: fill ignored", d.kind !== "update" || !ids(d).includes("E"), d);

  // a fill on another port / host or in another tab does not count
  resetStorage();
  await recordFill(1, E, "https://192.0.2.10:8080/login");
  d = await ns.data(pending("admin", "right"));
  check("fill on another port: ignored", d.kind === "update" && ids(d) === "W1,W2,W3", d);
  resetStorage();
  await recordFill(2, E, URL_);
  d = await ns.data(pending("admin", "right"));
  check("fill in another tab: ignored", d.kind === "update" && ids(d) === "W1,W2,W3", d);

  // a read-only filled entry with a changed password: no prompt (never the wrong entries)
  resetStorage();
  const RO = login("RO", "admin", "right", "https://device.example.de", false);
  ITEMS = [RO, ...W];
  await recordFill(1, RO, URL_);
  d = await ns.data(pending("admin", "new-pw"));
  check("read-only filled entry: no prompt", d.kind === "none", d);
  ITEMS = [E, ...W];

  // a stale fill record is ignored
  resetStorage();
  await recordFill(1, E, URL_, Date.now() - 10 * 60_000);
  d = await ns.data(pending("admin", "right"));
  check("old fill: ignored", d.kind === "update" && ids(d) === "W1,W2,W3", d);

  // outcome tracking counts the filled entry too
  resetStorage();
  svc.settings = { ...DEFAULT_SETTINGS, trackLoginOutcome: true };
  await recordFill(1, E, URL_);
  const a = await ns.newAttempt(1, URL_, "192.0.2.10:9443", "admin", "right");
  check("attempt includes the filled entry", !!a && a.items.some((i: any) => i.itemId === "E"), a);

  // "Ausfüllen und speichern": the page's origin is added once
  const s1 = withSiteUri(E, "https://192.0.2.10:9443/login?x=1");
  check("site uri added as origin", s1.login!.uris.map((u) => u.uri).join(" ") === "https://device.example.de https://192.0.2.10:9443", s1.login);
  check("original item untouched", E.login!.uris.length === 1);
  const s2 = withSiteUri(s1, "https://192.0.2.10:9443/other");
  check("same origin not added twice", s2.login!.uris.length === 2, s2.login);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
