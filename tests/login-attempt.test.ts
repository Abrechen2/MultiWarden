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

check("password field again -> failure", classifyOutcome(attempt(), state(frame(LOGIN, { hasPassword: true, hasUsername: true })), NOW) === "failure");
check("password field on the next page of the same site -> failure",
  classifyOutcome(attempt(), state(frame("https://example.de/login?error=1", { hasPassword: true })), NOW) === "failure");
check("totp page -> pending", classifyOutcome(attempt(), state(frame("https://example.de/2fa", { hasTotp: true })), NOW) === "pending");
check("after totp, no fields -> success", classifyOutcome(attempt({ sawTotp: true }), state(frame("https://example.de/home")), NOW) === "success");
check("after totp, same url, no fields -> success", classifyOutcome(attempt({ sawTotp: true }), state(frame(LOGIN)), NOW) === "success");
check("navigated away, no fields -> success", classifyOutcome(attempt(), state(frame("https://example.de/home")), NOW) === "success");
check("subdomain of the same site -> success", classifyOutcome(attempt(), state(frame("https://app.example.de/")), NOW) === "success");
check("same url, no fields at all -> success", classifyOutcome(attempt(), state(frame(LOGIN)), NOW) === "success");
check("same url, username field still there -> unknown", classifyOutcome(attempt(), state(frame(LOGIN, { hasUsername: true })), NOW) === "unknown");
check("hash-only change counts as same page", classifyOutcome(attempt(), state(frame(LOGIN + "#/app", { hasUsername: true })), NOW) === "unknown");
check("hash-only change, no fields -> success", classifyOutcome(attempt(), state(frame(LOGIN + "#/app")), NOW) === "success");
check("other site -> unknown", classifyOutcome(attempt(), state(frame("https://other.example.org/")), NOW) === "unknown");
check("null state -> unknown", classifyOutcome(attempt(), null, NOW) === "unknown");
check("top frame unreachable -> unknown", classifyOutcome(attempt(), state(null, [], "https://example.de/home"), NOW) === "unknown");
check("top frame unreachable, password in subframe -> unknown", classifyOutcome(attempt(), state(null, [frame("https://example.de/x", { hasPassword: true })], "https://example.de/home"), NOW) === "unknown");
check("password field in a cross-origin iframe of another site is ignored",
  classifyOutcome(attempt(), state(frame("https://example.de/home"), [frame("https://ads.example.net/f", { hasPassword: true })]), NOW) === "success");
check("same-site iframe with password field -> failure",
  classifyOutcome(attempt(), state(frame("https://example.de/home"), [frame("https://sso.example.de/f", { hasPassword: true })]), NOW) === "failure");
check("new-password field after navigating -> unknown",
  classifyOutcome(attempt(), state(frame("https://example.de/change", { hasNewPassword: true })), NOW) === "unknown");
check("expired attempt -> unknown", classifyOutcome(attempt(), state(frame("https://example.de/home")), 1_000 + ATTEMPT_TTL + 1) === "unknown");
check("attempt at the TTL boundary still counts", classifyOutcome(attempt(), state(frame("https://example.de/home")), 1_000 + ATTEMPT_TTL) === "success");
check("unparsable attempt url -> unknown", classifyOutcome(attempt({ url: "not a url" }), state(frame("https://example.de/home")), NOW) === "unknown");

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
