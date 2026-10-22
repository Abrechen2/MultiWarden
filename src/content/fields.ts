// Field discovery and classification (logins, new passwords, TOTP, payment cards, identities).
import { clipHidesAll, clipPathHidesAll, filterFactor, MIN_FIELD_OPACITY } from "./guard";

export type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export type CardKind = "cc-name" | "cc-number" | "cc-exp" | "cc-exp-month" | "cc-exp-year" | "cc-csc" | "cc-type";
export type IdKind =
  | "title"
  | "first"
  | "middle"
  | "last"
  | "full"
  | "street"
  | "house"
  | "address1"
  | "address2"
  | "address3"
  | "city"
  | "state"
  | "postal"
  | "country"
  | "company"
  | "email"
  | "phone"
  | "ssn"
  | "username"
  | "passport"
  | "license";

/** What the inline menu offers for a focused field. */
export type MenuKind = "login" | "newPassword" | "card" | "identity";

export const fieldOptions = { honorIgnore: false, honorAutofillSpans: false };

const IGNORED_TYPES = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
  "file",
  "search",
  "url",
  "date",
  "time",
  "datetime",
  "datetime-local",
  "week",
  "color",
  "range",
  "checkbox",
  "radio",
]);

export function isIgnored(el: Element): boolean {
  return fieldOptions.honorIgnore && el.hasAttribute("data-bwignore");
}

/** All inputs (incl. open shadow roots). */
export function allInputs(): HTMLInputElement[] {
  return allElements("input") as HTMLInputElement[];
}

/** Inputs, selects and textareas usable for card / identity filling. */
export function allFormFields(): FormField[] {
  return (allElements("input, select, textarea") as FormField[]).filter(
    (el) => !(el instanceof HTMLInputElement && IGNORED_TYPES.has((el.type || "text").toLowerCase())),
  );
}

export function autofillSpans(): HTMLSpanElement[] {
  return fieldOptions.honorAutofillSpans ? (allElements("span[data-bwautofill]") as HTMLSpanElement[]) : [];
}

function allElements(selector: string): Element[] {
  const out: Element[] = [];
  const visit = (root: Document | ShadowRoot, depth: number) => {
    root.querySelectorAll(selector).forEach((i) => {
      if (!isIgnored(i)) out.push(i);
    });
    if (depth > 4) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.nextNode() as Element | null;
    let count = 0;
    while (n && count < 8000) {
      const sr = (n as HTMLElement).shadowRoot;
      if (sr) visit(sr, depth + 1);
      n = walker.nextNode() as Element | null;
      count++;
    }
  };
  visit(document, 0);
  return out;
}

/** Parent in the flat tree (slot, then parent element, then shadow host). */
export function composedParent(el: Element): Element | null {
  return el.assignedSlot ?? el.parentElement ?? ((el.getRootNode() as ShadowRoot).host || null);
}

/**
 * The user can actually see the field: rendered, not (nearly) transparent through itself or an ancestor,
 * not clipped away, not pushed out of the document and – when on screen – not covered by other content.
 * Pages hide fields this way to get card / identity data filled into inputs the user never sees.
 */
export function isVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  // closed <details>, content-visibility, display: none anywhere above (Chrome 105+, Firefox 106+)
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ contentVisibilityAuto: true } as any)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const st = getComputedStyle(el);
  if (st.visibility !== "visible" || st.display === "none") return false;
  // outside the document: above / left of it, or right of the viewport (forms do not scroll sideways)
  if (r.bottom + window.scrollY <= 0 || r.right <= 0 || r.left >= window.innerWidth) return false;
  let opacity = 1;
  let box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  // set while walking from an absolute / fixed element up to its containing block: overflow in between does not clip it
  let escaping: "absolute" | "fixed" | null = null;
  for (let a: Element | null = el; a; a = composedParent(a)) {
    const cs = a === el ? st : getComputedStyle(a);
    if (cs.display === "none") return false;
    opacity *= parseFloat(cs.opacity) * filterFactor(cs.filter);
    if (opacity < MIN_FIELD_OPACITY) return false;
    if (clipPathHidesAll(cs.clipPath) || (cs.position === "absolute" || cs.position === "fixed" ? clipHidesAll(cs.clip) : false))
      return false;
    if (a !== el && escaping && (createsFixedContainingBlock(cs) || (escaping === "absolute" && cs.position !== "static"))) escaping = null;
    if (
      a !== el &&
      !escaping &&
      /hidden|clip/.test(cs.overflowX + cs.overflowY) &&
      a !== document.documentElement &&
      a !== document.body
    ) {
      // an ancestor that cuts off its overflow (not a scroll container – those can be scrolled to)
      const ar = a.getBoundingClientRect();
      box = {
        left: Math.max(box.left, ar.left),
        top: Math.max(box.top, ar.top),
        right: Math.min(box.right, ar.right),
        bottom: Math.min(box.bottom, ar.bottom),
      };
      if (box.right - box.left < 2 || box.bottom - box.top < 2) return false;
    }
    if (cs.position === "fixed") escaping = "fixed";
    else if (cs.position === "absolute" && escaping !== "fixed") escaping = "absolute";
  }
  return !isCovered(el, r);
}

/**
 * The element is the containing block of fixed (and absolute) descendants although it is not positioned.
 * When in doubt it must say yes: a wrong "no" would skip an overflow that really clips the field.
 */
function createsFixedContainingBlock(cs: CSSStyleDeclaration): boolean {
  const willChange = cs.willChange ?? "";
  return (
    (cs.transform && cs.transform !== "none") ||
    (cs.translate && cs.translate !== "none") ||
    (cs.rotate && cs.rotate !== "none") ||
    (cs.scale && cs.scale !== "none") ||
    (cs.perspective && cs.perspective !== "none") ||
    (cs.filter && cs.filter !== "none") ||
    ((cs as any).backdropFilter && (cs as any).backdropFilter !== "none") ||
    /paint|layout|strict|content/.test(cs.contain ?? "") ||
    (cs.containerType && cs.containerType !== "normal") ||
    /transform|perspective|filter|translate|rotate|scale|contain/.test(willChange)
  ) as boolean;
}

/**
 * The extension's own overlays (inline menu, field icon, notification bar). The open inline menu lies over
 * the field below the focused one; it must not make that field count as covered. Only the instances the
 * content script created count – a page element that merely carries the same tag name is a cover like any other.
 */
const ownHosts = new WeakSet<Element>();
export function registerOwnHost(host: Element) {
  ownHosts.add(host);
}

/** Another element is painted over the centre of the (on-screen) field. */
function isCovered(el: HTMLElement, r: DOMRect): boolean {
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return false; // below the fold: scrollable
  const root = el.getRootNode() as Document | ShadowRoot;
  const stack = (root.elementsFromPoint ? root.elementsFromPoint(x, y) : document.elementsFromPoint(x, y)) as Element[];
  // look through our own overlays at what the page itself paints there
  const hit = stack.find((e) => !ownHosts.has(e)) ?? null;
  if (!hit || hit === el || el.contains(hit)) return false;
  // its own label drawn on top (floating labels)
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) if (l === hit || l.contains(hit)) return false;
  return true;
}

export function labelText(el: FormField): string {
  let t = "";
  if (el.labels && el.labels.length)
    t = Array.from(el.labels)
      .map((l) => l.textContent ?? "")
      .join(" ");
  if (!t) t = el.getAttribute("aria-label") ?? "";
  if (!t) {
    const lb = el.getAttribute("aria-labelledby");
    if (lb)
      t = lb
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
  }
  if (!t) {
    // text directly in front of the field (e.g. "<td>PLZ</td><td><input></td>" or "<span>PLZ</span><input>")
    const prev = el.previousElementSibling;
    if (prev && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(prev.tagName)) t = prev.textContent ?? "";
    if (!t && el.parentElement?.tagName === "TD") t = el.parentElement.previousElementSibling?.textContent ?? "";
  }
  return t.replace(/\s+/g, " ").trim().slice(0, 100);
}

export function attrs(el: FormField): string {
  return [
    el.name,
    el.id,
    el.getAttribute("autocomplete") ?? "",
    (el as HTMLInputElement).placeholder ?? "",
    labelText(el),
    el.getAttribute("data-testid") ?? "",
    el.className.toString().slice(0, 60),
  ].join(" ");
}

export function autocompleteTokens(el: Element): string[] {
  return (el.getAttribute("autocomplete") ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x && !x.startsWith("section-") && !["shipping", "billing", "home", "work", "mobile", "fax", "pager"].includes(x));
}

export function isTextLike(el: Element): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = (el.type || "text").toLowerCase();
  return ["text", "email", "tel", "number", ""].includes(t) || !el.getAttribute("type");
}

// ---------------------------------------------------------------------------------------------
// logins

const USER_RE =
  /user|e-?mail|login|account|benutzer|anmelde|kennung|kunden|nutzer|identifier|logon|signin|sign-in|mitglied|member|mail|uid/i;
const TOTP_RE =
  /otp|totp|2fa|mfa|one.?time|verification.?code|auth.?code|security.?code|sicherheitscode|bestätigungscode|einmal|token|pin.?code|twofactor|two-factor/i;
const SEARCH_RE = /search|suche|query|captcha|newsletter|coupon|gutschein|promo/i;
const NEW_PW_RE =
  /new|neu|confirm|bestätig|wiederhol|repeat|retype|re-?enter|again|erneut|nochmal|verify|register|regist|signup|sign-up|create|choose|wählen|vergeben/i;
const CURRENT_PW_RE = /current|old|aktuell|alt(es)?\b|bisher|existing/i;

export function isPasswordField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type.toLowerCase() === "password") return true;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  return /current-password|new-password/.test(ac) && isTextLike(el);
}

export function isTotpField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (ac.includes("one-time-code")) return true;
  if (!isTextLike(el)) return false;
  const a = attrs(el);
  if (CSC_STRONG_RE.test(a)) return false;
  return TOTP_RE.test(a) && !USER_RE.test(el.name + " " + el.id) && (el.maxLength <= 0 || el.maxLength <= 12);
}

export function isUsernameField(el: Element, strongOnly = false): boolean {
  if (!isTextLike(el) || el.readOnly || el.disabled) return false;
  if (isTotpField(el)) return false;
  const a = attrs(el);
  if (SEARCH_RE.test(el.name + " " + el.id + " " + el.placeholder) && !USER_RE.test(el.name + " " + el.id)) return false;
  const ac = (el.getAttribute("autocomplete") ?? "").toLowerCase();
  if (/username|email/.test(ac)) return true;
  if (el.type === "email") return true;
  if (USER_RE.test(a)) return true;
  return !strongOnly;
}

/** Password fields of one form/scope that are meant for a new password (registration, change). */
export function newPasswordFields(scope: HTMLInputElement[]): Set<HTMLInputElement> {
  const pws = scope.filter(isPasswordField);
  const out = new Set<HTMLInputElement>();
  const ac = (el: HTMLInputElement) => (el.getAttribute("autocomplete") ?? "").toLowerCase();
  for (const p of pws) {
    if (ac(p).includes("new-password")) out.add(p);
    else if (!ac(p).includes("current-password") && NEW_PW_RE.test(attrs(p)) && !CURRENT_PW_RE.test(attrs(p))) out.add(p);
  }
  if (pws.length === 2 && !pws.some((p) => ac(p).includes("current-password") || CURRENT_PW_RE.test(attrs(p)))) {
    // password + confirmation
    if (out.size > 0) pws.forEach((p) => out.add(p));
  }
  if (pws.length >= 3) pws.slice(1).forEach((p) => out.add(p));
  return out;
}

export function isNewPasswordField(el: HTMLInputElement): boolean {
  if (!isPasswordField(el)) return false;
  const scope = el.form ? allInputs().filter((i) => i.form === el.form) : allInputs();
  return newPasswordFields(scope.filter((i) => !i.disabled && (i === el || isVisible(i)))).has(el);
}

// ---------------------------------------------------------------------------------------------
// payment cards and identities

const CARD_AC: Record<string, CardKind> = {
  "cc-name": "cc-name",
  "cc-given-name": "cc-name",
  "cc-family-name": "cc-name",
  "cc-number": "cc-number",
  "cc-exp": "cc-exp",
  "cc-exp-month": "cc-exp-month",
  "cc-exp-year": "cc-exp-year",
  "cc-csc": "cc-csc",
  "cc-type": "cc-type",
};

const ID_AC: Record<string, IdKind> = {
  "honorific-prefix": "title",
  "given-name": "first",
  "additional-name": "middle",
  "family-name": "last",
  name: "full",
  "street-address": "address1",
  "address-line1": "address1",
  "address-line2": "address2",
  "address-line3": "address3",
  "address-level2": "city",
  "address-level1": "state",
  "postal-code": "postal",
  country: "country",
  "country-name": "country",
  organization: "company",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  username: "username",
};

const CC_NUMBER_RE =
  /card.?(number|no\b|num|nr)|cc.?(num|number|no\b)|kartennummer|karten.?nr|kreditkarten.?nummer|creditcard|credit.?card|cardnum|\bpan\b|debit.?card/i;
const CC_NAME_RE = /(card|cc).?(holder|owner|name)|name.?on.?card|karten.?inhaber|inhaber|nameoncard|name auf der karte/i;
const CSC_STRONG_RE = /cvc|cvv|\bcsc|cvn|card.?code|card.?verification|kartenprüf|prüfnummer|prüfziffer|card.?security/i;
const CSC_WEAK_RE = /security.?code|sicherheitscode|sicherheitsnummer|\bcid\b/i;
const EXP_RE = /expir|\bexp\b|exp.?date|ablauf|gültig|valid.?(thru|until|to)|verfall|mm.?\/.?(yy|jj)/i;
const MONTH_RE = /month|monat|\bmm\b|exp.?m\b|expm/i;
const YEAR_RE = /year|jahr|\byy|\bjj|exp.?y\b|expy/i;
const CC_TYPE_RE = /card.?(type|brand)|cc.?(type|brand)|karten.?(typ|art)|zahlungsart|payment.?method/i;

const ID_RULES: [IdKind, RegExp][] = [
  ["email", /e-?mail/i],
  ["passport", /passport|reisepass/i],
  ["license", /licen[cs]e|führerschein/i],
  ["ssn", /\bssn\b|social.?security|sozialversicherung/i],
  ["phone", /phone|\btel\b|telefon|mobil|handy|\bcell/i],
  ["username", /user.?name|benutzername|nickname|spitzname|login.?name|anzeigename/i],
  ["company", /company|organi[sz]ation|firma|firmenname|unternehmen|business.?name|employer|arbeitgeber/i],
  ["title", /anrede|salutation|honorific/i],
  ["first", /first.?name|\bfname|given.?name|vorname|forename|\bfirst\b/i],
  ["middle", /middle.?name|\bmname|zweiter.?vorname|\bmiddle\b/i],
  ["last", /last.?name|\blname|surname|family.?name|nachname|familienname|zuname|\blast\b/i],
  ["house", /house.?(no|number|nr)|hausnummer|hausnr|haus.?nr|street.?(no|number)|\bhnr\b/i],
  ["address2", /address.?(line)?.?2|addr2|adresszusatz|zusatz|apartment|\bapt\b|suite|c\/o/i],
  ["address3", /address.?(line)?.?3|addr3/i],
  ["street", /\bstreet\b|straße|strasse|\bstr\b/i],
  ["address1", /address.?(line)?.?1|addr1|address|adresse|anschrift/i],
  ["postal", /\bzip|postal|post.?code|\bplz\b|postleitzahl/i],
  ["city", /city|town|stadt|\bort\b|wohnort|locality|ortschaft|gemeinde/i],
  ["state", /\bstate\b|province|provinz|region|bundesland|bundesstaat|county|kanton/i],
  ["country", /country|\bland\b|staat|nation/i],
  ["full", /full.?name|your.?name|ihr.?name|vor-? und nachname|\bname\b/i],
];

/** Card field kind; `cardContext` = the scope contains a card number field. */
export function cardKind(el: FormField, cardContext: boolean): CardKind | null {
  for (const tok of autocompleteTokens(el)) if (CARD_AC[tok]) return CARD_AC[tok];
  if (el instanceof HTMLInputElement && el.type === "password" && !CSC_STRONG_RE.test(attrs(el))) return null;
  const a = attrs(el);
  if (CC_NUMBER_RE.test(a) && !CSC_STRONG_RE.test(a) && !EXP_RE.test(a) && !CC_NAME_RE.test(a)) return "cc-number";
  if (CSC_STRONG_RE.test(a)) return "cc-csc";
  if (CC_NAME_RE.test(a) && (cardContext || /card|karte/i.test(a))) return "cc-name";
  const exp = EXP_RE.test(a) || /\b(cc|card)/i.test(a);
  if ((exp || cardContext) && MONTH_RE.test(a) && !YEAR_RE.test(a)) return "cc-exp-month";
  if ((exp || cardContext) && YEAR_RE.test(a) && !MONTH_RE.test(a)) return "cc-exp-year";
  if (EXP_RE.test(a) && (cardContext || /card|karte|cc/i.test(a))) return "cc-exp";
  if (cardContext && CC_TYPE_RE.test(a)) return "cc-type";
  if (cardContext && CSC_WEAK_RE.test(a)) return "cc-csc";
  return null;
}

export function identityKind(el: FormField): IdKind | null {
  for (const tok of autocompleteTokens(el)) {
    if (tok.startsWith("cc-") || tok.includes("password") || tok === "one-time-code") return null;
    if (ID_AC[tok]) return ID_AC[tok];
  }
  if (el instanceof HTMLInputElement && el.type === "password") return null;
  if (el instanceof HTMLInputElement && el.type === "email") return "email";
  if (el instanceof HTMLInputElement && el.type === "tel") return "phone";
  const a = attrs(el);
  if (CC_NUMBER_RE.test(a) || CSC_STRONG_RE.test(a) || CC_NAME_RE.test(a)) return null;
  if (SEARCH_RE.test(el.name + " " + el.id)) return null;
  // honorific: a select ("Herr/Frau") or a field explicitly named so
  if (el instanceof HTMLSelectElement && /\btit(le|el)\b|\bprefix\b/i.test(a)) return "title";
  if (/^nr\.?$/i.test(labelText(el))) return "house";
  for (const [k, re] of ID_RULES) if (re.test(a)) return k;
  return null;
}

/** Card / identity fields of a scope, each field at most once. */
export function classifyScope(fields: FormField[]): { cards: Map<FormField, CardKind>; ids: Map<FormField, IdKind> } {
  const cards = new Map<FormField, CardKind>();
  const ids = new Map<FormField, IdKind>();
  const cardContext = fields.some((f) => cardKind(f, false) === "cc-number");
  for (const f of fields) {
    const c = cardKind(f, cardContext);
    if (c) {
      cards.set(f, c);
      continue;
    }
    if (isPasswordField(f) || isTotpField(f)) continue;
    const i = identityKind(f);
    if (i) ids.set(f, i);
  }
  // a generic "name" next to first/last name fields is something else (e.g. company or nickname)
  const kinds = new Set(ids.values());
  if (kinds.has("first") || kinds.has("last"))
    for (const [f, k] of ids) if (k === "full" && !autocompleteTokens(f).includes("name")) ids.delete(f);
  return { cards, ids };
}

/** Which inline-menu list fits a focused field (null: no menu). */
export function menuKindOf(el: FormField, loginUsername: (el: HTMLInputElement) => boolean): MenuKind | null {
  if (el instanceof HTMLInputElement) {
    if (isPasswordField(el)) return isNewPasswordField(el) ? "newPassword" : "login";
    if (isUsernameField(el) && loginUsername(el)) return "login";
  }
  const scope = scopeOf(el);
  const { cards, ids } = classifyScope(scope);
  if (cards.has(el) && [...cards.values()].includes("cc-number")) return "card";
  const k = ids.get(el);
  if (k && !["username", "email", "phone"].includes(k)) {
    // at least two identity fields → address / personal data form
    if (ids.size >= 2) return "identity";
  } else if (k && ids.size >= 3) return "identity";
  return null;
}

/** The form a field belongs to, or all fields of the document when it has none. */
export function scopeOf(el: Element): FormField[] {
  const all = allFormFields().filter((f) => !f.disabled && (f === el || isVisible(f)));
  const form = (el as FormField).form ?? el.closest?.("form");
  if (form) {
    const inForm = all.filter((f) => f.form === form || form.contains(f));
    if (inForm.length) return inForm;
  }
  return all;
}
