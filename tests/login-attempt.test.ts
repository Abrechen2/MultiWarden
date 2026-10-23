// Classification of a login attempt from the page state seen afterwards. A wrong "success" feeds the
// clean-up recommendation, so every ambiguous case must come out as "unknown".
import "./chrome-stub";
import { ATTEMPT_TTL, classifyOutcome, type Attempt, type PageState } from "../src/background/login-attempt";
import type { CollectResult } from "../src/shared/messages";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const LOGIN = "https://example.de/login";
const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  host: "example.de", site: "example.de", url: LOGIN, items: [{ accountKey: "a", itemId: "1" }],
  at: 1_000, sawTotp: false, ...over,
});
const frame = (url: string, over: Partial<CollectResult> = {}): CollectResult => ({
  url, origin: new URL(url).origin, hasPassword: false, hasNewPassword: false, hasUsername: false, hasTotp: false,
  cardFields: 0, hasCardNumber: false, identityFields: 0, fields: [], ...over,
});
const state = (top: CollectResult | null, others: CollectResult[] = [], url = top?.url ?? LOGIN): PageState => ({
  url, topFrame: top, frames: top ? [top, ...others] : others,
});
const NOW = 2_000;
/** after a completed page load unless `nav` is false (SPA timer path: no navigation seen) */
const cls = (a: Attempt, s: PageState | null, now: number, nav = true) => classifyOutcome(a, s, now, nav);

check("password field again -> failure", cls(attempt(), state(frame(LOGIN, { hasPassword: true, hasUsername: true })), NOW) === "failure");
check("password field on the next page of the same site -> failure",
  cls(attempt(), state(frame("https://example.de/login?error=1", { hasPassword: true })), NOW) === "failure");
check("totp page -> pending", cls(attempt(), state(frame("https://example.de/2fa", { hasTotp: true })), NOW) === "pending");
check("after totp, no fields -> success", cls(attempt({ sawTotp: true }), state(frame("https://example.de/home")), NOW) === "success");
check("after totp, same url, no fields -> success", cls(attempt({ sawTotp: true }), state(frame(LOGIN)), NOW) === "success");
check("navigated away, no fields -> success", cls(attempt(), state(frame("https://example.de/home")), NOW) === "success");
check("subdomain of the same site -> success", cls(attempt(), state(frame("https://app.example.de/")), NOW) === "success");
check("same url reloaded, no fields at all -> success", cls(attempt(), state(frame(LOGIN)), NOW) === "success");
check("timer path, same url, no fields -> settling (look again before recording)",
  cls(attempt(), state(frame(LOGIN)), NOW, false) === "settling");
check("timer path, hash-only change, no fields -> settling", cls(attempt(), state(frame(LOGIN + "#/app")), NOW, false) === "settling");
check("timer path, url changed (SPA route), no fields -> success", cls(attempt(), state(frame("https://example.de/home")), NOW, false) === "success");
check("timer path, password field -> failure", cls(attempt(), state(frame(LOGIN, { hasPassword: true })), NOW, false) === "failure");
check("same url, username field still there -> unknown", cls(attempt(), state(frame(LOGIN, { hasUsername: true })), NOW) === "unknown");
check("hash-only change counts as same page", cls(attempt(), state(frame(LOGIN + "#/app", { hasUsername: true })), NOW) === "unknown");
check("hash-only change, no fields -> success", cls(attempt(), state(frame(LOGIN + "#/app")), NOW) === "success");
check("other site -> unknown", cls(attempt(), state(frame("https://other.example.org/")), NOW) === "unknown");
check("null state -> unknown", cls(attempt(), null, NOW) === "unknown");
check("top frame unreachable -> unknown", cls(attempt(), state(null, [], "https://example.de/home"), NOW) === "unknown");
check("top frame unreachable, password in subframe -> unknown", cls(attempt(), state(null, [frame("https://example.de/x", { hasPassword: true })], "https://example.de/home"), NOW) === "unknown");
check("password field in a cross-origin iframe of another site is ignored",
  cls(attempt(), state(frame("https://example.de/home"), [frame("https://ads.example.net/f", { hasPassword: true })]), NOW) === "success");
check("same-site iframe on another host with a password field -> unknown",
  cls(attempt(), state(frame("https://example.de/home"), [frame("https://sso.example.de/f", { hasPassword: true })]), NOW) === "unknown");
check("same-host iframe with a password field -> failure",
  cls(attempt(), state(frame("https://example.de/home"), [frame("https://example.de/f", { hasPassword: true })]), NOW) === "failure");
check("SSO: login on sso.example.de, then the app's login form on app.example.de -> unknown",
  cls(attempt({ host: "sso.example.de", url: "https://sso.example.de/login" }),
    state(frame("https://app.example.de/login", { hasPassword: true, hasUsername: true })), NOW) === "unknown");
check("other port of the same host is another host -> unknown",
  cls(attempt(), state(frame("https://example.de:8443/login", { hasPassword: true })), NOW) === "unknown");
check("after a TOTP step, a password field again -> unknown",
  cls(attempt({ sawTotp: true }), state(frame(LOGIN, { hasPassword: true })), NOW) === "unknown");
check("opaque-origin frame with a new-password field -> unknown",
  cls(attempt(), state(frame("https://example.de/home"), [{ ...frame("https://example.de/f", { hasNewPassword: true }), origin: "null" }]), NOW) === "unknown");
check("new-password field after navigating -> unknown",
  cls(attempt(), state(frame("https://example.de/change", { hasNewPassword: true })), NOW) === "unknown");
check("expired attempt -> unknown", cls(attempt(), state(frame("https://example.de/home")), 1_000 + ATTEMPT_TTL + 1) === "unknown");
check("attempt at the TTL boundary still counts", cls(attempt(), state(frame("https://example.de/home")), 1_000 + ATTEMPT_TTL) === "success");
check("unparsable attempt url -> unknown", cls(attempt({ url: "not a url" }), state(frame("https://example.de/home")), NOW) === "unknown");
check("redirect to /login?error=1 with only a username field -> unknown",
  cls(attempt(), state(frame("https://example.de/login?error=1", { hasUsername: true })), NOW) === "unknown");
check("sawTotp, then a username-only page -> unknown",
  cls(attempt({ sawTotp: true }), state(frame("https://example.de/login", { hasUsername: true })), NOW) === "unknown");
check("top frame password with an empty frames list -> failure",
  cls(attempt(), { url: LOGIN, topFrame: frame(LOGIN, { hasPassword: true }), frames: [] }, NOW) === "failure");
check("top frame totp with an empty frames list -> pending",
  cls(attempt(), { url: LOGIN, topFrame: frame(LOGIN, { hasTotp: true }), frames: [] }, NOW) === "pending");
check("opaque-origin frame with a password field -> unknown",
  cls(attempt(), state(frame("https://example.de/home"), [{ ...frame("https://example.de/f", { hasPassword: true }), origin: "null" }]), NOW) === "unknown");
check("NaN now -> unknown", cls(attempt(), state(frame("https://example.de/home")), NaN) === "unknown");
check("NaN attempt time -> unknown", cls(attempt({ at: NaN }), state(frame("https://example.de/home")), NOW) === "unknown");
check("top frame url on another site than state url -> unknown",
  cls(attempt(), { url: "https://example.de/home", topFrame: frame("https://evil.example.net/"), frames: [] }, NOW) === "unknown");

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
