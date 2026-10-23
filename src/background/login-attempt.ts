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

export function classifyOutcome(a: Attempt, s: PageState | null, now: number): Outcome {
  if (!s || !s.topFrame || now - a.at > ATTEMPT_TTL) return "unknown";
  if (baseDomain(s.url) !== a.site) return "unknown";

  // frames of other sites (ads, embedded widgets) say nothing about our login
  const own = s.frames.filter((f) => baseDomain(f.origin) === a.site);
  if (own.some((f) => f.hasPassword)) return "failure";
  if (s.frames.some((f) => f.hasTotp)) return "pending";
  // a new-password form (change / registration) afterwards is not clear evidence either way
  if (own.some((f) => f.hasNewPassword)) return "unknown";

  const here = withoutHash(s.url);
  const before = withoutHash(a.url);
  if (here === null || before === null) return "unknown";
  if (here !== before || a.sawTotp) return "success";
  return s.topFrame.hasUsername ? "unknown" : "success";
}
