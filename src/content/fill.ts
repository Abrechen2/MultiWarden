// Collecting and filling: logins, generated passwords, payment cards, identities, custom fields.
import type { CollectResult, FieldInfo, FillData } from "../shared/messages";
import {
  allFormFields,
  allInputs,
  autofillSpans,
  CardKind,
  classifyScope,
  FormField,
  IdKind,
  isPasswordField,
  isTotpField,
  isUsernameField,
  isVisible,
  labelText,
  newPasswordFields,
  scopeOf,
} from "./fields";

let opidCounter = 0;
const opids = new WeakMap<Element, string>();
const byOpid = new Map<string, WeakRef<Element>>();

export function opidOf(el: Element): string {
  let id = opids.get(el);
  if (!id) {
    id = "__mw" + ++opidCounter;
    opids.set(el, id);
    byOpid.set(id, new WeakRef(el));
  }
  return id;
}

export function elementByOpid(id: string | undefined): Element | undefined {
  return id ? byOpid.get(id)?.deref() : undefined;
}

// ---------------------------------------------------------------------------------------------
// login pairs

export interface LoginPair {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  /** the password field is for a new password (registration / change form) */
  isNew?: boolean;
}

export function findPairs(): { pairs: LoginPair[]; totp: HTMLInputElement[]; inputs: HTMLInputElement[] } {
  const inputs = allInputs().filter((i) => !i.disabled && isVisible(i));
  const passwords = inputs.filter(isPasswordField);
  const newPw = new Set<HTMLInputElement>();
  const byForm = new Map<HTMLFormElement | null, HTMLInputElement[]>();
  for (const i of inputs) {
    const k = i.form ?? null;
    if (!byForm.has(k)) byForm.set(k, []);
    byForm.get(k)!.push(i);
  }
  for (const scope of byForm.values()) newPasswordFields(scope).forEach((p) => newPw.add(p));
  const pairs: LoginPair[] = [];
  for (const p of passwords) {
    // nearest preceding username candidate (same form preferred)
    const scope = p.form ? inputs.filter((i) => i.form === p.form) : inputs;
    const idx = scope.indexOf(p);
    let user: HTMLInputElement | undefined;
    for (let i = idx - 1; i >= 0; i--) {
      const c = scope[i];
      if (isPasswordField(c)) continue;
      if (isUsernameField(c)) {
        user = c;
        break;
      }
    }
    pairs.push({ username: user, password: p, isNew: newPw.has(p) });
  }
  if (!passwords.length) {
    // username-first login steps (e.g. multi-page logins)
    const u = inputs.find((i) => isUsernameField(i, true));
    if (u) pairs.push({ username: u });
  }
  const totp = inputs.filter(isTotpField);
  return { pairs, totp, inputs };
}

function fieldInfo(el: HTMLInputElement): FieldInfo {
  return {
    opid: opidOf(el),
    type: el.type,
    name: el.name,
    id: el.id,
    autocomplete: el.getAttribute("autocomplete") ?? "",
    placeholder: el.placeholder,
    label: labelText(el),
    visible: true,
    form: el.form?.id ?? "",
  };
}

export function collect(): CollectResult {
  const { pairs, totp } = findPairs();
  const fields: FieldInfo[] = [];
  for (const p of pairs) {
    if (p.username) fields.push(fieldInfo(p.username));
    if (p.password) fields.push(fieldInfo(p.password));
  }
  const visibleFields = allFormFields().filter((f) => !f.disabled && isVisible(f));
  const { cards, ids } = classifyScope(visibleFields);
  const cardKinds = new Set(cards.values());
  return {
    url: location.href,
    origin: location.origin,
    hasPassword: pairs.some((p) => p.password && !p.isNew),
    hasNewPassword: pairs.some((p) => p.password && p.isNew),
    hasUsername: pairs.some((p) => p.username),
    hasTotp: totp.length > 0,
    cardFields: cards.size,
    hasCardNumber: cardKinds.has("cc-number") || cardKinds.has("cc-csc"),
    identityFields: ids.size,
    fields,
  };
}

// ---------------------------------------------------------------------------------------------
// setting values the way a user would (frameworks listen to input/change events)

const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
const textareaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;

export function setValue(el: FormField, value: string) {
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  if (el instanceof HTMLSelectElement) {
    if (selectSetter) selectSetter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "" }));
  const setter = el instanceof HTMLTextAreaElement ? textareaSetter : inputSetter;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: value }));
  el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "" }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function isEmpty(el: FormField): boolean {
  if (el instanceof HTMLSelectElement) return el.selectedIndex <= 0 || !el.value;
  return !el.value;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");

/** Choose the option matching one of the candidates (value or text, exact first, then numeric, then partial). */
export function selectOption(sel: HTMLSelectElement, candidates: (string | undefined)[]): boolean {
  const cands = candidates.filter((c): c is string => !!c && !!norm(c));
  const opts = Array.from(sel.options).filter((o) => !o.disabled);
  const pick = (o: HTMLOptionElement | undefined) => {
    if (!o) return false;
    setValue(sel, o.value);
    return true;
  };
  for (const c of cands) {
    const n = norm(c);
    if (pick(opts.find((o) => norm(o.value) === n || norm(o.text) === n))) return true;
  }
  for (const c of cands) {
    if (!/^\d+$/.test(c.trim())) continue;
    const n = Number(c);
    if (
      pick(
        opts.find((o) => (/^\d+$/.test(o.value.trim()) && Number(o.value) === n) || (/^\d+$/.test(o.text.trim()) && Number(o.text) === n)),
      )
    )
      return true;
  }
  for (const c of cands) {
    const n = norm(c);
    if (n.length < 4) continue;
    if (pick(opts.find((o) => norm(o.text).startsWith(n) || (norm(o.text).length >= 4 && n.startsWith(norm(o.text)))))) return true;
  }
  return false;
}

function put(el: FormField, value: string | undefined, onlyEmpty: boolean, selectCands?: (string | undefined)[]): boolean {
  if (!value) return false;
  if (onlyEmpty && !isEmpty(el)) return false;
  if (el instanceof HTMLSelectElement) return selectOption(el, selectCands ?? [value]);
  if (el.readOnly) return false;
  let v = value;
  if (el instanceof HTMLInputElement && el.maxLength > 0 && v.length > el.maxLength) v = v.replace(/\s+/g, "");
  setValue(el, v);
  return true;
}

// ---------------------------------------------------------------------------------------------
// cards

const pad2 = (s: string) => (s.length === 1 ? "0" + s : s);

function monthNames(m: number): string[] {
  const out: string[] = [];
  const langs = Array.from(new Set([document.documentElement.lang || "en", "en", "de"]));
  for (const l of langs) {
    for (const month of ["long", "short"] as const) {
      try {
        out.push(new Intl.DateTimeFormat(l, { month }).format(new Date(2020, m - 1, 15)));
      } catch {
        /* unknown language tag */
      }
    }
  }
  return out;
}

const BRAND_ALIASES: Record<string, string[]> = {
  amex: ["amex", "American Express", "americanexpress", "AE"],
  mastercard: ["Mastercard", "Master Card", "MC", "Eurocard"],
  visa: ["Visa", "VI"],
  discover: ["Discover", "DI"],
  dinersclub: ["Diners Club", "Diners", "DC"],
  jcb: ["JCB"],
  maestro: ["Maestro"],
  unionpay: ["UnionPay", "China UnionPay", "CUP"],
  rupay: ["RuPay"],
};

function expFormat(el: HTMLInputElement, a: string, mm: string, yyyy: string): string {
  if (el.type === "month") return `${yyyy}-${mm}`;
  const m = /(mm|m)(\s*[\/\-.]?\s*)(yyyy|jjjj|aaaa|yy|jj|aa)/i.exec(a);
  if (m) return mm + m[2] + (m[3].length === 4 ? yyyy : yyyy.slice(-2));
  const ml = el.maxLength;
  if (ml === 4) return mm + yyyy.slice(-2);
  if (ml === 7) return `${mm}/${yyyy}`;
  return `${mm}/${yyyy.slice(-2)}`;
}

function fillCard(scope: FormField[], card: Record<string, string | undefined>, onlyEmpty: boolean): HTMLElement[] {
  const { cards } = classifyScope(scope);
  const done: HTMLElement[] = [];
  const month = String(parseInt(card.expMonth ?? "", 10) || "");
  const mm = month ? pad2(month) : "";
  let yyyy = (card.expYear ?? "").trim();
  if (/^\d{2}$/.test(yyyy)) yyyy = "20" + yyyy;
  const numberFields = [...cards].filter(([, k]) => k === "cc-number").map(([f]) => f);
  const digits = (card.number ?? "").replace(/\D/g, "");
  const split = numberFields.length > 1 && numberFields.every((f) => f instanceof HTMLInputElement && f.maxLength > 0 && f.maxLength <= 6);
  let offset = 0;
  for (const [el, kind] of cards) {
    let ok = false;
    const a = [el.getAttribute("placeholder") ?? "", labelText(el), el.name, el.id].join(" ");
    switch (kind as CardKind) {
      case "cc-number":
        if (split) {
          const len = (el as HTMLInputElement).maxLength;
          ok = put(el, digits.slice(offset, offset + len), onlyEmpty);
          offset += len;
        } else ok = put(el, card.number, onlyEmpty);
        break;
      case "cc-name":
        ok = put(el, card.cardholderName, onlyEmpty);
        break;
      case "cc-csc":
        ok = put(el, card.code, onlyEmpty);
        break;
      case "cc-type": {
        const key = norm(card.brand ?? "");
        ok = put(el, card.brand, onlyEmpty, [card.brand, ...(BRAND_ALIASES[key] ?? [])]);
        break;
      }
      case "cc-exp-month":
        if (!mm) break;
        ok = put(el, mm, onlyEmpty, [mm, month, ...monthNames(Number(month))]);
        break;
      case "cc-exp-year": {
        if (!yyyy) break;
        const two = el instanceof HTMLInputElement && (el.maxLength === 2 || (/\b(yy|jj|aa)\b/i.test(a) && !/(yyyy|jjjj|aaaa)/i.test(a)));
        ok = put(el, two ? yyyy.slice(-2) : yyyy, onlyEmpty, [yyyy, yyyy.slice(-2)]);
        break;
      }
      case "cc-exp":
        if (!mm || !yyyy) break;
        if (el instanceof HTMLSelectElement)
          ok = put(el, `${mm}/${yyyy.slice(-2)}`, onlyEmpty, [`${mm}/${yyyy.slice(-2)}`, `${mm}/${yyyy}`]);
        else if (el instanceof HTMLInputElement) ok = put(el, expFormat(el, a, mm, yyyy), onlyEmpty);
        break;
    }
    if (ok) done.push(el);
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// identities

const TITLE_ALIASES: Record<string, string[]> = {
  mr: ["Mr", "Mr.", "Herr", "Hr.", "M", "Male", "Mister", "Monsieur", "männlich"],
  mrs: ["Mrs", "Mrs.", "Frau", "Fr.", "Ms", "Female", "Madame", "weiblich"],
  ms: ["Ms", "Ms.", "Frau", "Fr.", "Miss", "Mrs", "Female", "weiblich"],
  mx: ["Mx", "Mx.", "Divers", "D", "Other"],
  dr: ["Dr", "Dr.", "Doctor", "Doktor"],
};
TITLE_ALIASES.herr = TITLE_ALIASES.mr;
TITLE_ALIASES.hr = TITLE_ALIASES.mr;
TITLE_ALIASES.frau = TITLE_ALIASES.mrs;
TITLE_ALIASES.fr = TITLE_ALIASES.mrs;
TITLE_ALIASES.divers = TITLE_ALIASES.mx;

let regionCache: Map<string, string> | null = null;

/** ISO country code for a stored country (code or name in English/German/page language). */
function countryCode(v: string): string | undefined {
  if (/^[a-z]{2}$/i.test(v.trim())) return v.trim().toUpperCase();
  if (!regionCache) {
    regionCache = new Map();
    const langs = Array.from(new Set(["en", "de", document.documentElement.lang || "en"]));
    const names = langs.map((l) => {
      try {
        return new Intl.DisplayNames([l], { type: "region" });
      } catch {
        return null;
      }
    });
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        for (const dn of names) {
          const n = dn?.of(code);
          if (n && n !== code) regionCache.set(norm(n), code);
        }
      }
  }
  return regionCache.get(norm(v));
}

function countryCandidates(v: string): string[] {
  const code = countryCode(v);
  const out = [v];
  if (code) {
    out.push(code);
    for (const l of Array.from(new Set([document.documentElement.lang || "en", "en", "de"]))) {
      try {
        const n = new Intl.DisplayNames([l], { type: "region" }).of(code);
        if (n) out.push(n);
      } catch {
        /* ignore */
      }
    }
    if (code === "GB") out.push("UK", "United Kingdom", "Great Britain", "Großbritannien");
    if (code === "US") out.push("USA", "United States of America", "Vereinigte Staaten");
  }
  return out;
}

/** "Musterstraße 12a" → ["Musterstraße", "12a"], "123 Main St" → ["Main St", "123"]. */
export function splitStreet(address: string): [string, string] {
  const a = address.trim();
  let m = /^(.*?)[\s,]+(\d+\s*[a-zA-Z]?(?:\s*[-\/]\s*\d+\s*[a-zA-Z]?)?)$/.exec(a);
  if (m && m[1]) return [m[1].replace(/,$/, ""), m[2]];
  m = /^(\d+\s*[a-zA-Z]?)\s+(.+)$/.exec(a);
  if (m) return [m[2], m[1]];
  return [a, ""];
}

function fillIdentity(scope: FormField[], id: Record<string, string | undefined>, onlyEmpty: boolean, skip: Set<Element>): HTMLElement[] {
  const { ids } = classifyScope(scope);
  const kinds = new Set(ids.values());
  const done: HTMLElement[] = [];
  const hasHouse = kinds.has("house");
  const [street, house] = hasHouse ? splitStreet(id.address1 ?? "") : [id.address1 ?? "", ""];
  const full = [id.firstName, id.middleName, id.lastName].filter(Boolean).join(" ");
  for (const [el, kind] of ids) {
    if (skip.has(el)) continue;
    let v: string | undefined;
    let cands: (string | undefined)[] | undefined;
    switch (kind as IdKind) {
      case "title":
        v = id.title;
        cands = [id.title, ...(TITLE_ALIASES[norm(id.title ?? "")] ?? [])];
        break;
      case "first":
        v = kinds.has("middle") ? id.firstName : [id.firstName, id.middleName].filter(Boolean).join(" ");
        break;
      case "middle":
        v = id.middleName;
        break;
      case "last":
        v = id.lastName;
        break;
      case "full":
        v = full;
        break;
      case "street":
        v = hasHouse ? street : id.address1;
        break;
      case "house":
        v = house;
        break;
      case "address1":
        if (el instanceof HTMLTextAreaElement) v = [id.address1, id.address2, id.address3].filter(Boolean).join("\n");
        else v = hasHouse && kinds.has("street") ? id.address1 : hasHouse ? street : id.address1;
        break;
      case "address2":
        v = id.address2;
        break;
      case "address3":
        v = id.address3;
        break;
      case "city":
        v = id.city;
        break;
      case "state":
        v = id.state;
        break;
      case "postal":
        v = id.postalCode;
        break;
      case "country":
        v = id.country;
        cands = id.country ? countryCandidates(id.country) : undefined;
        break;
      case "company":
        v = id.company;
        break;
      case "email":
        v = id.email;
        break;
      case "phone":
        v = id.phone;
        break;
      case "ssn":
        v = id.ssn;
        break;
      case "username":
        v = id.username;
        break;
      case "passport":
        v = id.passportNumber;
        break;
      case "license":
        v = id.licenseNumber;
        break;
    }
    if (put(el, v, onlyEmpty, cands)) done.push(el);
  }
  return done;
}

// ---------------------------------------------------------------------------------------------
// fill entry point (called by the background via scripting.executeScript)

function focusLast(el: HTMLElement | undefined) {
  try {
    el?.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function fillLogin(d: FillData): HTMLElement[] {
  const { pairs, totp, inputs } = findPairs();
  let targets = pairs;
  const t = elementByOpid(d.targetOpid) as HTMLInputElement | undefined;
  if (t) {
    const own = pairs.filter(
      (p) => p.username === t || p.password === t || (t.form && (p.username?.form === t.form || p.password?.form === t.form)),
    );
    if (own.length) targets = own;
  }
  // change-password forms: the saved password belongs into the current-password field only
  const hasCurrent = targets.some((p) => p.password && !p.isNew);
  const done: HTMLElement[] = [];
  const filledUser = new Set<HTMLInputElement>();
  for (const p of targets) {
    if (p.isNew && (hasCurrent || d.onlyEmpty)) continue;
    if (p.username && d.username && !filledUser.has(p.username)) {
      filledUser.add(p.username);
      if (put(p.username, d.username, !!d.onlyEmpty)) done.push(p.username);
    }
    if (p.password && d.password && put(p.password, d.password, !!d.onlyEmpty)) done.push(p.password);
  }
  if (d.totp && totp.length && !targets.some((p) => p.password)) {
    if (totp.length > 1 && totp.every((x) => x.maxLength === 1)) {
      // split one-digit inputs
      totp.slice(0, d.totp.length).forEach((x, i) => setValue(x, d.totp![i]));
    } else setValue(totp[0], d.totp);
    done.push(totp[0]);
  }
  fillCustomFields(d, inputs, done);
  return done;
}

function fillCustomFields(d: FillData, inputs: HTMLInputElement[], done: HTMLElement[]) {
  const fields = d.fields ?? [];
  if (!fields.length) return;
  const spans = autofillSpans();
  for (const f of fields) {
    if (!f.name) continue;
    const n = f.name.toLowerCase();
    const el = inputs.find((i) => [i.name, i.id, labelText(i), i.placeholder].some((x) => x && x.toLowerCase() === n));
    if (el && !isPasswordField(el) && el.type !== "hidden") {
      if (el.type === "checkbox" || el.type === "radio") {
        const want = /^(true|1|yes|ja|on)$/i.test(f.value);
        if (el.checked !== want) el.click();
      } else setValue(el, f.value);
      done.push(el);
      continue;
    }
    // <span data-bwautofill="name"> targets (only when the user allowed it)
    const sp = spans.find((s) => [s.getAttribute("data-bwautofill"), s.id].some((x) => x && x.toLowerCase() === n));
    if (sp) {
      sp.textContent = f.value;
      done.push(sp);
    }
  }
}

/** Generated password into the new-password field(s) of the focused form. */
function fillGenerated(d: FillData): HTMLElement[] {
  const pw = d.password;
  if (!pw) return [];
  let target = elementByOpid(d.targetOpid) as HTMLElement | undefined;
  if (!target) {
    // keyboard shortcut / context menu: the focused field of this frame
    if (!document.hasFocus()) return [];
    let a: Element | null = document.activeElement;
    while (a && (a as HTMLElement).shadowRoot?.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
    if (!(a instanceof HTMLInputElement)) return [];
    target = a;
  }
  const scope = (target ? scopeOf(target) : allFormFields()).filter((f): f is HTMLInputElement => f instanceof HTMLInputElement);
  const news = [...newPasswordFields(scope)];
  const done: HTMLElement[] = [];
  if (news.length) {
    for (const f of news) {
      setValue(f, pw);
      done.push(f);
    }
    return done;
  }
  if (target instanceof HTMLInputElement && (isPasswordField(target) || target.type === "text") && !target.readOnly) {
    setValue(target, pw);
    done.push(target);
    // confirmation directly after the target
    const pws = scope.filter(isPasswordField);
    const next = pws[pws.indexOf(target) + 1];
    if (next && !next.value) {
      setValue(next, pw);
      done.push(next);
    }
  }
  return done;
}

export function fill(d: FillData): { filled: number } {
  let done: HTMLElement[] = [];
  const target = elementByOpid(d.targetOpid);
  if (d.kind === "generated") done = fillGenerated(d);
  else if (d.kind === "card" || d.kind === "identity") {
    const scope = target ? scopeOf(target) : allFormFields().filter((f) => !f.disabled && isVisible(f));
    if (d.kind === "card" && d.card) {
      // cross-origin frames only hold payment fields (e.g. hosted card number / CVC frames)
      if (d.requireCardNumber) {
        const kinds = new Set(classifyScope(scope).cards.values());
        if (!kinds.has("cc-number") && !kinds.has("cc-csc")) return { filled: 0 };
      }
      done = fillCard(scope, d.card, !!d.onlyEmpty);
    }
    if (d.kind === "identity" && d.identity) {
      // login fields of the page are not part of an address form
      const skip = new Set<Element>();
      for (const p of findPairs().pairs) if (p.password && !p.isNew && p.username) skip.add(p.username);
      done = fillIdentity(scope, d.identity, !!d.onlyEmpty, skip);
    }
    fillCustomFields(d, allInputs(), done);
  } else done = fillLogin(d);
  focusLast(done[done.length - 1]);
  return { filled: done.length };
}
