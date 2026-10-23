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

export type Outcome = "success" | "failure" | "pending" | "unknown";

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

/** sandboxed / data: frames report the origin "null", which baseDomain would read as a host */
function isOpaque(origin: string): boolean {
  return origin === "null" || baseDomain(origin) === null;
}

export function classifyOutcome(a: Attempt, s: PageState | null, now: number): Outcome {
  // written so that NaN timestamps count as expired
  if (!s || !s.topFrame || !(now - a.at <= ATTEMPT_TTL)) return "unknown";
  if (baseDomain(s.url) !== a.site || baseDomain(s.topFrame.url) !== a.site) return "unknown";

  // the probe may or may not list the top frame among the frames; duplicates are harmless
  const all = [s.topFrame, ...s.frames];
  // frames of other sites (ads, embedded widgets) say nothing about our login
  const own = all.filter((f) => baseDomain(f.origin) === a.site);
  if (own.some((f) => f.hasPassword)) return "failure";
  if (all.some((f) => f.hasTotp)) return "pending";
  // a password field in a frame whose site cannot be told (opaque origin) might be ours
  if (all.some((f) => f.hasPassword && isOpaque(f.origin))) return "unknown";
  // a new-password form (change / registration) afterwards is not clear evidence either way
  if (own.some((f) => f.hasNewPassword)) return "unknown";
  // a username-only page (e.g. a redirect back to the login after a wrong password) is not a success
  if (s.topFrame.hasUsername) return "unknown";

  const here = withoutHash(s.url);
  const before = withoutHash(a.url);
  if (here === null || before === null) return "unknown";
  // moved away from the login page, finished a TOTP step, or the page shows no login field at all
  return "success";
}
