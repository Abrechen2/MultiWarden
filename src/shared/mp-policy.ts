// Master password policy of organizations (policy type 1) and password statistics to check it.
import { passwordStrength } from "./generator";
import { tk } from "./i18n";

export interface MpPolicy {
  minComplexity?: number | null;
  minLength?: number | null;
  requireUpper?: boolean | null;
  requireLower?: boolean | null;
  requireNumbers?: boolean | null;
  requireSpecial?: boolean | null;
  enforceOnLogin?: boolean | null;
}

/** Only these properties of a password are kept to evaluate the policy later (never the password). */
export interface PwStats {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  special: boolean;
  score: number;
}

export function pwStats(pw: string): PwStats {
  return {
    length: pw.length,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digits: /[0-9]/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
    score: passwordStrength(pw).score,
  };
}

/** The strictest combination of several policies (several organizations). */
export function mergePolicies(list: (MpPolicy | null | undefined)[]): MpPolicy | null {
  const ps = list.filter(Boolean) as MpPolicy[];
  if (!ps.length) return null;
  return {
    minComplexity: Math.max(0, ...ps.map((p) => p.minComplexity ?? 0)),
    minLength: Math.max(0, ...ps.map((p) => p.minLength ?? 0)),
    requireUpper: ps.some((p) => p.requireUpper),
    requireLower: ps.some((p) => p.requireLower),
    requireNumbers: ps.some((p) => p.requireNumbers),
    requireSpecial: ps.some((p) => p.requireSpecial),
    enforceOnLogin: ps.some((p) => p.enforceOnLogin),
  };
}

/** Unfulfilled requirements as German source texts (translate with t()). */
export function policyViolations(s: PwStats, p: MpPolicy | null | undefined): { text: string; n?: number }[] {
  if (!p) return [];
  const out: { text: string; n?: number }[] = [];
  if (p.minLength && s.length < p.minLength) out.push({ text: tk("Mindestens {n} Zeichen"), n: p.minLength });
  if (p.minComplexity && s.score < p.minComplexity)
    out.push({ text: tk("Höhere Passwortstärke (mindestens {n} von 4)"), n: p.minComplexity });
  if (p.requireUpper && !s.upper) out.push({ text: tk("Mindestens ein Großbuchstabe") });
  if (p.requireLower && !s.lower) out.push({ text: tk("Mindestens ein Kleinbuchstabe") });
  if (p.requireNumbers && !s.digits) out.push({ text: tk("Mindestens eine Zahl") });
  if (p.requireSpecial && !s.special) out.push({ text: tk("Mindestens ein Sonderzeichen") });
  return out;
}

/** All requirements of a policy (for the hint in the change dialog). */
export function policyRequirements(p: MpPolicy | null | undefined): { text: string; n?: number }[] {
  return policyViolations({ length: 0, upper: false, lower: false, digits: false, special: false, score: 0 }, p);
}
