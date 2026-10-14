import { strengthScore } from "./strength";
import { EFF_WORDS } from "./eff-wordlist";
import { t, tk } from "./i18n";
import type { GeneratorPolicy } from "./policies";

export interface PasswordOptions {
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  special: boolean;
  minDigits: number;
  minSpecial: number;
  avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
}

export const DEFAULT_PASSWORD: PasswordOptions = {
  length: 20,
  upper: true,
  lower: true,
  digits: true,
  special: true,
  minDigits: 1,
  minSpecial: 1,
  avoidAmbiguous: false,
};

export const DEFAULT_PASSPHRASE: PassphraseOptions = { words: 5, separator: "-", capitalize: true, includeNumber: true };

function randInt(max: number): number {
  // unbiased random integer in [0, max)
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function generatePassword(o: PasswordOptions): string {
  let upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let lower = "abcdefghijklmnopqrstuvwxyz";
  let digits = "0123456789";
  const special = "!@#$%^&*";
  if (o.avoidAmbiguous) {
    upper = upper.replace(/[IO]/g, "");
    lower = lower.replace(/[l]/g, "");
    digits = digits.replace(/[01]/g, "");
  }
  const sets: string[] = [];
  const required: string[] = [];
  if (o.upper) {
    sets.push(upper);
    required.push(upper[randInt(upper.length)]);
  }
  if (o.lower) {
    sets.push(lower);
    required.push(lower[randInt(lower.length)]);
  }
  if (o.digits) {
    sets.push(digits);
    for (let i = 0; i < Math.max(1, o.minDigits); i++) required.push(digits[randInt(digits.length)]);
  }
  if (o.special) {
    sets.push(special);
    for (let i = 0; i < Math.max(1, o.minSpecial); i++) required.push(special[randInt(special.length)]);
  }
  if (!sets.length) {
    sets.push(lower);
  }
  const all = sets.join("");
  const len = Math.max(o.length, required.length, 5);
  const chars = [...required];
  while (chars.length < len) chars.push(all[randInt(all.length)]);
  return shuffle(chars).join("");
}

export function generatePassphrase(o: PassphraseOptions): string {
  const n = Math.max(3, Math.min(20, o.words));
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = EFF_WORDS[randInt(EFF_WORDS.length)];
    if (o.capitalize) w = w[0].toUpperCase() + w.slice(1);
    words.push(w);
  }
  if (o.includeNumber) {
    const i = randInt(words.length);
    words[i] = words[i] + randInt(10);
  }
  return words.join(o.separator);
}

export function passwordStrength(pw: string, inputs: string[] = []): { score: number; label: string } {
  if (!pw) return { score: 0, label: "" };
  const score = strengthScore(pw, inputs);
  return { score, label: t(["", tk("Schwach"), tk("Mittel"), tk("Gut"), tk("Stark")][score]) };
}

// ---------------------------------------------------------------------------------------------
// organization policy "password generator"

/** Password options raised to the organization's minimums. */
export function applyPasswordPolicy(o: PasswordOptions, p?: GeneratorPolicy | null): PasswordOptions {
  if (!p) return o;
  const r = { ...o };
  if (p.useUpper) r.upper = true;
  if (p.useLower) r.lower = true;
  if (p.useNumbers || p.minNumbers) r.digits = true;
  if (p.useSpecial || p.minSpecial) r.special = true;
  if (r.digits) r.minDigits = Math.max(r.minDigits, p.minNumbers, p.useNumbers ? 1 : 0);
  if (r.special) r.minSpecial = Math.max(r.minSpecial, p.minSpecial, p.useSpecial ? 1 : 0);
  r.length = Math.min(
    128,
    Math.max(r.length, p.minLength, (r.upper ? 1 : 0) + (r.lower ? 1 : 0) + (r.digits ? r.minDigits : 0) + (r.special ? r.minSpecial : 0)),
  );
  return r;
}

export function applyPassphrasePolicy(o: PassphraseOptions, p?: GeneratorPolicy | null): PassphraseOptions {
  if (!p) return o;
  return {
    ...o,
    words: Math.min(20, Math.max(o.words, p.minNumberWords)),
    capitalize: o.capitalize || p.capitalize,
    includeNumber: o.includeNumber || p.includeNumber,
  };
}

/** The generator type the policy allows ("username" is never affected). */
export function policyMode<M extends string>(mode: M, p?: GeneratorPolicy | null): M | "password" | "passphrase" {
  if (!p?.overrideType || mode === "username") return mode;
  return p.overrideType;
}

export async function loadGeneratorPolicy(): Promise<GeneratorPolicy | null> {
  try {
    return ((await chrome.storage.local.get("generatorPolicy")).generatorPolicy as GeneratorPolicy) ?? null;
  } catch {
    return null;
  }
}

/** A password with the options last used in the generator (popup), for the inline menu / context menu / shortcut. */
export async function generateWithSavedOptions(): Promise<string> {
  let o: any;
  try {
    o = (await chrome.storage.local.get("generatorOptions")).generatorOptions;
  } catch {
    /* no storage (tests) */
  }
  const policy = await loadGeneratorPolicy();
  const mode = policyMode(o?.mode === "passphrase" ? "passphrase" : "password", policy);
  if (mode === "passphrase") return generatePassphrase(applyPassphrasePolicy({ ...DEFAULT_PASSPHRASE, ...(o?.passphrase ?? {}) }, policy));
  return generatePassword(applyPasswordPolicy({ ...DEFAULT_PASSWORD, ...(o?.password ?? {}) }, policy));
}

// ---------------------------------------------------------------------------------------------
// usernames

export type UsernameKind = "word" | "plus" | "catchall" | "forwarded";

export interface UsernameOptions {
  kind: UsernameKind;
  wordCapitalize: boolean;
  wordIncludeNumber: boolean;
  /** plus addressing: base address */
  email: string;
  plusMode: "random" | "website";
  /** catch-all: own domain */
  domain: string;
  catchallMode: "random" | "website";
  forwarder: string;
}

export const DEFAULT_USERNAME: UsernameOptions = {
  kind: "word",
  wordCapitalize: false,
  wordIncludeNumber: true,
  email: "",
  plusMode: "random",
  domain: "",
  catchallMode: "random",
  forwarder: "simplelogin",
};

function randomChars(n: number): string {
  const set = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += set[randInt(set.length)];
  return s;
}

function websitePart(website: string): string {
  let h = website.trim();
  try {
    h = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(h) ? h : "https://" + h).hostname;
  } catch {
    /* keep */
  }
  return h.replace(/^www\./, "").toLowerCase();
}

/** Username for the non-forwarding kinds. Throws with a user message when settings are missing. */
export function generateUsername(o: UsernameOptions, website = ""): string {
  switch (o.kind) {
    case "plus": {
      const email = o.email.trim();
      const at = email.lastIndexOf("@");
      if (at < 1 || at === email.length - 1) throw new Error(t("Bitte eine gültige E-Mail-Adresse eingeben"));
      const tag = o.plusMode === "website" && website ? websitePart(website) : randomChars(8);
      return `${email.slice(0, at)}+${tag}${email.slice(at)}`;
    }
    case "catchall": {
      const domain = o.domain.trim().replace(/^@/, "");
      if (!/^[^\s@]+\.[^\s@]+$/.test(domain)) throw new Error(t("Bitte eine Domain eingeben"));
      const local = o.catchallMode === "website" && website ? websitePart(website) : randomChars(8);
      return `${local}@${domain}`;
    }
    default: {
      let w = EFF_WORDS[randInt(EFF_WORDS.length)];
      if (o.wordCapitalize) w = w[0].toUpperCase() + w.slice(1);
      if (o.wordIncludeNumber) w += String(randInt(10000)).padStart(4, "0");
      return w;
    }
  }
}
