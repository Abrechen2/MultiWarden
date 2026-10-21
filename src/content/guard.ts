// Pure decision logic of the defences against invisible fields and inline-menu clickjacking:
// how much a CSS filter / clip leaves visible, and whether a focus came from the user.

/** a focus counts as user-initiated this long after the pointer / key event that caused it */
export const INTENT_WINDOW_MS = 1000;
/** below this combined opacity an element counts as invisible (fields) */
export const MIN_FIELD_OPACITY = 0.1;
/** the inline menu must be (almost) fully opaque */
export const MIN_MENU_OPACITY = 0.95;
/** blur radius from which text is no longer readable */
const MAX_BLUR_PX = 4;

/** A user interaction that may legitimately open the inline menu. */
export interface Intent {
  at: number;
  /** pointer: pressed on `target`; tab: Tab key (focus moves afterwards); key: typed into `target` */
  via: "pointer" | "tab" | "key";
  target: Element | null;
}

/** Factor (0…1) by which a CSS `filter` value reduces what the user can perceive of an element. */
export function filterFactor(filter: string): number {
  if (!filter || filter === "none") return 1;
  let f = 1;
  const re = /([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi;
  for (let m = re.exec(filter); m; m = re.exec(filter)) {
    const fn = m[1].toLowerCase();
    const arg = m[2].trim();
    const num = arg.endsWith("%") ? parseFloat(arg) / 100 : parseFloat(arg);
    if (fn === "opacity" || fn === "brightness" || fn === "contrast") {
      if (!Number.isNaN(num)) f *= Math.max(0, Math.min(1, num));
    } else if (fn === "blur") {
      if (parseFloat(arg) > MAX_BLUR_PX) return 0;
    } else if (fn === "invert") {
      // half inverted turns every colour into the same grey
      if (!Number.isNaN(num) && num > 0.3 && num < 0.7) return 0;
    }
  }
  return f;
}

/** The (legacy) `clip` property cuts the element down to (almost) nothing. */
export function clipHidesAll(clip: string): boolean {
  const m = /^rect\((.*)\)$/i.exec((clip || "").trim());
  if (!m) return false;
  const parts = m[1].split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 4) return false;
  const [top, right, bottom, left] = parts.map((p) => (p === "auto" ? NaN : parseFloat(p)));
  const tooNarrow = !Number.isNaN(right) && right - (Number.isNaN(left) ? 0 : left) < 2;
  const tooLow = !Number.isNaN(bottom) && bottom - (Number.isNaN(top) ? 0 : top) < 2;
  return tooNarrow || tooLow;
}

/** `clip-path` cuts the element away completely (inset ≥ 100 % on one axis, zero-radius shapes). */
export function clipPathHidesAll(clipPath: string): boolean {
  const cp = (clipPath || "").trim().toLowerCase();
  if (!cp || cp === "none") return false;
  const inset = /^inset\(([^)]*)\)/.exec(cp);
  if (inset) {
    const vals = inset[1].split(/\s+round\s+/)[0].split(/\s+/).filter(Boolean);
    // only percentages can be judged without the element's size; 50 % on all sides is the usual trick
    const pct = vals.map((v) => (v.endsWith("%") ? parseFloat(v) : parseFloat(v) === 0 ? 0 : NaN));
    const [t, r = t, b = t, l = r] = pct;
    return (!Number.isNaN(t) && !Number.isNaN(b) && t + b >= 100) || (!Number.isNaN(r) && !Number.isNaN(l) && r + l >= 100);
  }
  const shape = /^(circle|ellipse)\(\s*(0(px|%)?)(\s|\))/.exec(cp);
  return !!shape;
}

/** The inline menu may open for `field` only right after the user interacted with it. */
export function intentAllows(intent: Intent | null, field: Element, labels: Element[], now: number): boolean {
  if (!intent || now - intent.at > INTENT_WINDOW_MS || now < intent.at) return false;
  if (intent.via === "tab") return true;
  if (!intent.target) return false;
  if (intent.target === field) return true;
  return intent.via === "pointer" && labels.includes(intent.target);
}
