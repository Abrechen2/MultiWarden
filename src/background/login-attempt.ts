// Decides what became of a login attempt from the page state observed afterwards (pure; the probe that
// collects the state lives elsewhere). A wrong "success" can end up recommending an entry, so whenever
// the evidence is ambiguous the answer is "unknown" - that only means a question may be asked.
import { baseDomain } from "../shared/uri";
import type { CollectResult } from "../shared/messages";

export interface Attempt {
  host: string;
  /** baseDomain(url) of the page the form was submitted on */
  site: string;
  /** URL of the page where the login form was submitted */
  url: string;
  items: { accountKey: string; itemId: string }[];
  at: number;
  /** a TOTP page was seen after the submission */
  sawTotp: boolean;
}

export interface PageState {
  url: string;
  topFrame: CollectResult | null;
  frames: CollectResult[];
}

/**
 * "settling": no login field is left, but the page neither loaded nor changed its URL (SPA timer path) -
 * the form may only be hidden for a moment; the caller looks once more before it counts as a success.
 */
export type Outcome = "success" | "failure" | "pending" | "settling" | "unknown";

/** how long after the submission an attempt can still be classified */
export const ATTEMPT_TTL = 5 * 60_000;

function withoutHash(url: string): string | null {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/** host (with port) of a URL or origin; null when it has none */
function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** sandboxed / data: frames report the origin "null", which baseDomain would read as a host */
function isOpaque(origin: string): boolean {
  return origin === "null" || baseDomain(origin) === null;
}

/**
 * @param afterNavigation the state was taken after a completed page load (false: SPA timer path, no
 *   navigation seen - an unchanged URL without login fields is then only "settling")
 */
export function classifyOutcome(a: Attempt, s: PageState | null, now: number, afterNavigation: boolean): Outcome {
  // written so that NaN timestamps count as expired
  if (!s || !s.topFrame || !(now - a.at <= ATTEMPT_TTL)) return "unknown";
  if (baseDomain(s.url) !== a.site || baseDomain(s.topFrame.url) !== a.site) return "unknown";

  // the probe may or may not list the top frame among the frames; duplicates are harmless
  const all = [s.topFrame, ...s.frames];
  const loginHost = hostOfUrl(a.url);
  const sameHost = (f: { origin: string }) => !isOpaque(f.origin) && loginHost !== null && hostOfUrl(f.origin) === loginHost;
  // frames of other sites (ads, embedded widgets) say nothing about our login
  const sameSite = (f: { origin: string }) => !isOpaque(f.origin) && baseDomain(f.origin) === a.site;
  // the login form again where it was submitted; after a TOTP step it may as well be a new session's login
  if (all.some((f) => f.hasPassword && sameHost(f))) return a.sawTotp ? "unknown" : "failure";
  // another host of the site (SSO, the app's own login, a login widget) may ask for a different login
  if (all.some((f) => f.hasPassword && sameSite(f))) return "unknown";
  if (all.some((f) => f.hasTotp)) return "pending";
  // a password field in a frame whose site cannot be told (opaque origin) might be ours
  if (all.some((f) => (f.hasPassword || f.hasNewPassword) && isOpaque(f.origin))) return "unknown";
  // a new-password form (change / registration) afterwards is not clear evidence either way
  if (all.some((f) => f.hasNewPassword && sameSite(f))) return "unknown";
  // a username-only page (e.g. a redirect back to the login after a wrong password) is not a success
  if (s.topFrame.hasUsername) return "unknown";

  const here = withoutHash(s.url);
  const before = withoutHash(a.url);
  if (here === null || before === null) return "unknown";
  // a completed load or a new URL without login fields: moved on from the login
  if (afterNavigation || here !== before) return "success";
  // same document, fields gone: possibly only hidden while the login is still running
  return "settling";
}
