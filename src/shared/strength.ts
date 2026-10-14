// Password strength estimate: the cheapest way to build the password from known patterns (dictionary
// words incl. the EFF list, common passwords, the user's own data, repeats, sequences, keyboard rows,
// years) or single characters, in bits of guessing work. Simplified after the zxcvbn idea; no data
// leaves the device.
import { EFF_WORDS } from "./eff-wordlist";

const COMMON = [
  "password",
  "passwort",
  "kennwort",
  "geheim",
  "secret",
  "admin",
  "administrator",
  "root",
  "user",
  "login",
  "welcome",
  "willkommen",
  "hallo",
  "hello",
  "letmein",
  "master",
  "dragon",
  "monkey",
  "shadow",
  "sunshine",
  "princess",
  "iloveyou",
  "ichliebedich",
  "schatz",
  "sommer",
  "winter",
  "summer",
  "spring",
  "autumn",
  "fruehling",
  "herbst",
  "football",
  "fussball",
  "baseball",
  "soccer",
  "freedom",
  "whatever",
  "trustno",
  "starwars",
  "pokemon",
  "superman",
  "batman",
  "computer",
  "internet",
  "default",
  "changeme",
  "test",
  "testing",
  "guest",
  "access",
  "abc",
  "qwerty",
  "qwertz",
  "asdf",
  "zxcvbn",
  "yxcvbn",
  "passw0rd",
  "familie",
  "family",
  "liebe",
  "love",
  "schule",
  "school",
  "firma",
  "company",
  "januar",
  "februar",
  "march",
  "april",
  "juni",
  "july",
  "august",
  "september",
  "oktober",
  "october",
  "november",
  "dezember",
  "december",
  "montag",
  "monday",
  "friday",
  "freitag",
];

const EFF_SET = new Set(EFF_WORDS.filter((w) => w.length >= 4));
const COMMON_SET = new Set(COMMON);
const EFF_BITS = Math.log2(EFF_WORDS.length);
const COMMON_BITS = Math.log2(COMMON.length) + 1;
const ROWS = ["qwertzuiopü", "asdfghjklöä", "yxcvbnm", "qwertyuiop", "zxcvbnm", "1234567890", "abcdefghijklmnopqrstuvwxyz"];
const LEET: Record<string, string> = { "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "0": "o", $: "s", "5": "s", "7": "t", "8": "b" };

function poolOf(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  return Math.max(pool, 10);
}

function capsBits(s: string): number {
  if (s === s.toLowerCase()) return 0;
  if (s === s.toUpperCase() || (s[0] === s[0].toUpperCase() && s.slice(1) === s.slice(1).toLowerCase())) return 1;
  return Math.min(s.length, [...s].filter((c) => c !== c.toLowerCase()).length + 1);
}

function inRow(s: string): boolean {
  const l = s.toLowerCase();
  const r = [...l].reverse().join("");
  return ROWS.some((row) => row.includes(l) || row.includes(r));
}

/** Words of the user's own data (username, e-mail, site, item name) – the attacker knows them. */
export function userWords(inputs: (string | undefined | null)[]): string[] {
  const out = new Set<string>();
  for (const v of inputs) {
    if (!v) continue;
    for (const part of v.toLowerCase().split(/[^a-z0-9äöüß]+/)) if (part.length >= 3) out.add(part);
  }
  return [...out];
}

/** Estimated entropy in bits. */
export function strengthBits(pw: string, inputs: string[] = []): number {
  const n = pw.length;
  if (!n) return 0;
  const charBits = Math.log2(poolOf(pw));
  const user = new Set(inputs.map((s) => s.toLowerCase()));
  const lower = pw.toLowerCase();
  const leet = [...lower].map((c) => LEET[c] ?? c).join("");
  const best = new Array<number>(n + 1).fill(Infinity);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue;
    // a single character
    best[i + 1] = Math.min(best[i + 1], best[i] + charBits);
    for (let j = i + 3; j <= Math.min(n, i + 24); j++) {
      const raw = pw.slice(i, j);
      const lw = lower.slice(i, j);
      const lt = leet.slice(i, j);
      const leetUsed = lt !== lw ? 1 : 0;
      let cost = Infinity;
      if (user.has(lw) || user.has(lt)) cost = 1 + capsBits(raw) + leetUsed;
      else if (COMMON_SET.has(lw) || COMMON_SET.has(lt)) cost = COMMON_BITS + capsBits(raw) + leetUsed;
      else if (j - i >= 4 && (EFF_SET.has(lw) || EFF_SET.has(lt))) cost = EFF_BITS + capsBits(raw) + leetUsed;
      // the same character repeated
      if (/^(.)\1+$/.test(raw)) cost = Math.min(cost, charBits + Math.log2(j - i));
      // runs along the alphabet, digits or a keyboard row (also backwards)
      if (inRow(raw)) cost = Math.min(cost, Math.log2(26) + Math.log2(j - i) + capsBits(raw));
      // a year
      if (j - i === 4 && /^(19|20)\d\d$/.test(raw)) cost = Math.min(cost, Math.log2(150));
      if (cost < Infinity) best[j] = Math.min(best[j], best[i] + cost);
    }
  }
  return best[n];
}

/** 0 (empty) … 4: 1 = schwach (< 28 bits), 2 = mittel (< 40), 3 = gut (< 60), 4 = stark. */
export function strengthScore(pw: string, inputs: string[] = []): number {
  if (!pw) return 0;
  const bits = strengthBits(pw, inputs);
  return bits < 28 ? 1 : bits < 40 ? 2 : bits < 60 ? 3 : 4;
}
