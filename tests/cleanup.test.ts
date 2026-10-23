// Cleanup checks: logins without a usable website, port-less IP / localhost URIs, logins not used on
// this device for a year, and passwords reused across accounts.
import { CipherType, ItemView } from "../src/shared/types";
import { portlessLocalUris, reusedAcrossAccounts, staleOnThisDevice, STALE_MS, withoutWebsite } from "../src/shared/cleanup";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

let seq = 0;
const login = (uris: string[], extra: Partial<ItemView> = {}, password = "pw-" + seq): ItemView => ({
  id: "i" + ++seq,
  accountKey: "a",
  collectionIds: [],
  type: CipherType.Login,
  name: "item" + seq,
  favorite: false,
  reprompt: 0,
  edit: true,
  viewPassword: true,
  login: { username: "u", password, uris: uris.map((uri) => ({ uri })), passkeys: 0 },
  fields: [],
  passwordHistory: [],
  attachments: [],
  ...extra,
});
const names = (xs: ItemView[]) => xs.map((i) => i.name);

// withoutWebsite
const noUri = login([]);
const garbage = login(["http://"]);
const ftp = login(["ftp://example.de"]);
const web = login(["https://example.de"]);
const app = login(["androidapp://com.example"]);
const mixed = login(["http://", "https://example.de"]);
const trashed = login([], { deletedDate: "2026-01-01" });
const archived = login([], { archivedDate: "2026-01-01" });
const broken = login([], { decryptError: "x" });
const note = login([], { type: CipherType.SecureNote });
const res = names(withoutWebsite([noUri, garbage, ftp, web, app, mixed, trashed, archived, broken, note]));
check("no URI listed", res.includes(noUri.name), res);
check("unparsable URI listed", res.includes(garbage.name), res);
check("non-web non-app scheme listed", res.includes(ftp.name), res);
check("web URI not listed", !res.includes(web.name), res);
check("androidapp URI not listed", !res.includes(app.name), res);
check("one valid URI among bad ones is fine", !res.includes(mixed.name), res);
check("deleted, archived, undecryptable and non-login ignored", [trashed, archived, broken, note].every((i) => !res.includes(i.name)), res);

// portlessLocalUris
const ip = login(["https://10.0.0.5"]);
const ipPort = login(["https://10.0.0.5:8443"]);
const dns = login(["https://example.de"]);
const local = login(["http://localhost"]);
const single = login(["nas"]);
const appLocal = login(["androidapp://nas"]);
const p = portlessLocalUris([ip, ipPort, dns, local, single, appLocal, login(["http://10.0.0.6"], { deletedDate: "2026-01-01" })]);
const pn = p.map((x) => x.item.name);
check("IP without port flagged", pn.includes(ip.name), pn);
check("IP with port not flagged", !pn.includes(ipPort.name), pn);
check("domain not flagged", !pn.includes(dns.name), pn);
check("localhost and single-label host flagged", pn.includes(local.name) && pn.includes(single.name), pn);
check("app URI not flagged", !pn.includes(appLocal.name), pn);
check("deleted ignored", p.length === 3, p.length);
check("flagged URI is reported", p.find((x) => x.item === ip)?.uri === "https://10.0.0.5", p);

// staleOnThisDevice
const now = Date.UTC(2026, 9, 23);
const never = login(["https://example.de"]);
const old = login(["https://example.de"]);
const recent = login(["https://example.de"]);
const lastUsed = { a: { [old.id]: now - 400 * 24 * 60 * 60 * 1000, [recent.id]: now - 30 * 24 * 60 * 60 * 1000 } };
const st = staleOnThisDevice([never, old, recent, login([], { deletedDate: "2026-01-01" })], lastUsed, now);
check("never used is stale", st.some((x) => x.item === never && x.lastUsed === undefined), st);
check("used 13 months ago is stale", st.some((x) => x.item === old && x.lastUsed === lastUsed.a[old.id]), st);
check("used last month is not stale", !st.some((x) => x.item === recent), st);
check("deleted ignored", st.length === 2, st.length);
check("boundary: exactly a year is not stale", staleOnThisDevice([never], { a: { [never.id]: now - STALE_MS } }, now).length === 0);

// reusedAcrossAccounts
const same = (acc: string, pw: string, extra: Partial<ItemView> = {}) => login(["https://example.de"], { accountKey: acc, ...extra }, pw);
const r1 = same("a", "shared-pw");
const r2 = same("b", "shared-pw");
const r3 = same("a", "shared-pw");
const g = reusedAcrossAccounts([r1, r2, r3]);
check("password across two accounts listed as one group", g.length === 1 && g[0].length === 3, g.map((x) => x.length));
const w1 = same("a", "own-pw");
const w2 = same("a", "own-pw");
check("reuse within one account not listed", reusedAcrossAccounts([w1, w2]).length === 0);
const org1 = same("a", "org-pw", { organizationId: "o1", id: "shared-1" });
const org2 = same("b", "org-pw", { organizationId: "o1", id: "shared-1" });
check("shared org item in two accounts is not reuse", reusedAcrossAccounts([org1, org2]).length === 0);
const org3 = same("b", "org-pw");
check("shared item counted once, other account's own item is reuse", reusedAcrossAccounts([org1, org2, org3]).length === 1);
check("empty passwords never reused", reusedAcrossAccounts([same("a", ""), same("b", "")]).length === 0);
check("deleted entries ignored", reusedAcrossAccounts([same("a", "x1"), same("b", "x1", { deletedDate: "2026-01-01" })]).length === 0);

console.log(failed ? failed + " FAILED" : "ALL PASSED");
process.exit(failed ? 1 : 0);
