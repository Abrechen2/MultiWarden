// Colour schemes for all extension pages. Variables are set on <html>, so every stylesheet
// (popup, dialogs, inline menu, notification bar) follows the chosen scheme.

export type ThemeMode = "system" | "light" | "dark";
export type ColorScheme = "multiwarden" | "mint" | "tuvia" | "red" | "gray" | "custom";

export interface CustomColors {
  background: string;
  container: string;
  accent: string;
  text: string;
  textMuted: string;
  border: string;
  danger: string;
}

export interface AppearanceSettings {
  theme: ThemeMode;
  colorScheme?: ColorScheme;
  customColors?: Partial<CustomColors>;
  compactMode?: boolean;
  animations?: boolean;
  popupWidth?: "default" | "wide" | "extraWide";
}

interface Palette {
  bg: string;
  bgElev: string;
  surface: string;
  surface2: string;
  border: string;
  borderSoft: string;
  text: string;
  textMuted: string;
  textFaint: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  danger: string;
  success: string;
  warning: string;
  toastBg: string;
  toastFg: string;
  dark: boolean;
}

const MW_LIGHT: Palette = {
  bg: "#f1f4f8",
  bgElev: "#ffffff",
  surface: "#ffffff",
  surface2: "#e9eef5",
  border: "#c5cfdc",
  borderSoft: "#dde4ee",
  text: "#1b2433",
  textMuted: "#58667e",
  textFaint: "#8492a8",
  primary: "#175ddc",
  primaryHover: "#134fbe",
  primaryText: "#ffffff",
  danger: "#c83522",
  success: "#157a3c",
  warning: "#b45f06",
  toastBg: "#1b2433",
  toastFg: "#ffffff",
  dark: false,
};
const MW_DARK: Palette = {
  bg: "#0e1622",
  bgElev: "#152031",
  surface: "#1a2638",
  surface2: "#213049",
  border: "#3b4c66",
  borderSoft: "#26344b",
  text: "#e4ebf5",
  textMuted: "#a2b0c6",
  textFaint: "#75849c",
  primary: "#84aef5",
  primaryHover: "#a1c1f8",
  primaryText: "#0e1622",
  danger: "#ff8f80",
  success: "#6fd496",
  warning: "#f2b86b",
  toastBg: "#e4ebf5",
  toastFg: "#0e1622",
  dark: true,
};

const MINT_LIGHT: Palette = {
  ...MW_LIGHT,
  bg: "#eef7f3",
  surface2: "#e0f0e8",
  border: "#b9d8ca",
  borderSoft: "#d6eadf",
  text: "#13241d",
  textMuted: "#4d6a5e",
  textFaint: "#7f998e",
  primary: "#0e8063",
  primaryHover: "#0b6a52",
  toastBg: "#13241d",
};
const MINT_DARK: Palette = {
  ...MW_DARK,
  bg: "#0c1714",
  bgElev: "#12221d",
  surface: "#162924",
  surface2: "#1e362f",
  border: "#34594c",
  borderSoft: "#203a32",
  text: "#e2f3ec",
  textMuted: "#9dc3b4",
  textFaint: "#6f9184",
  primary: "#5ee3b4",
  primaryHover: "#86ecc7",
  primaryText: "#0c1714",
  toastBg: "#e2f3ec",
  toastFg: "#0c1714",
};

/** Tuvia: accent oklch(0.6903 0.2218 358.3255) = #ff4d9a (dark text on it for contrast) */
const TUVIA = "#ff4d9a";
const TUVIA_LIGHT: Palette = {
  ...MW_LIGHT,
  bg: "#fbf1f6",
  surface2: "#f5e3ec",
  border: "#e3c2d3",
  borderSoft: "#f0dbe6",
  text: "#2b1421",
  textMuted: "#7b5468",
  textFaint: "#a5869a",
  primary: TUVIA,
  primaryHover: "#e8428b",
  primaryText: "#1f0612",
  toastBg: "#2b1421",
};
const TUVIA_DARK: Palette = {
  ...MW_DARK,
  bg: "#190e14",
  bgElev: "#22131b",
  surface: "#28161f",
  surface2: "#36202b",
  border: "#5e3a4c",
  borderSoft: "#3a2330",
  text: "#f7e8ef",
  textMuted: "#c9a5b6",
  textFaint: "#93707f",
  primary: TUVIA,
  primaryHover: "#ff74b0",
  primaryText: "#1f0612",
  toastBg: "#f7e8ef",
  toastFg: "#190e14",
};

const RED_LIGHT: Palette = {
  ...MW_LIGHT,
  bg: "#f8f2f2",
  surface2: "#f3e6e6",
  border: "#dcc3c3",
  borderSoft: "#efdddd",
  text: "#2a1a1b",
  textMuted: "#765a5c",
  textFaint: "#a08386",
  primary: "#c4202f",
  primaryHover: "#a31a27",
  danger: "#b3261e",
  toastBg: "#2a1a1b",
};
const RED_DARK: Palette = {
  ...MW_DARK,
  bg: "#1a1012",
  bgElev: "#24161a",
  surface: "#2a191d",
  surface2: "#382227",
  border: "#5e3a41",
  borderSoft: "#3a2328",
  text: "#f5e9ea",
  textMuted: "#c6a9ad",
  textFaint: "#93767a",
  primary: "#ff6b74",
  primaryHover: "#ff8b92",
  primaryText: "#1a1012",
  danger: "#ff8f80",
  toastBg: "#f5e9ea",
  toastFg: "#1a1012",
};

const GRAY_LIGHT: Palette = {
  ...MW_LIGHT,
  bg: "#f2f2f2",
  surface2: "#e8e8e8",
  border: "#c8c8c8",
  borderSoft: "#e0e0e0",
  text: "#1e1e1e",
  textMuted: "#5f5f5f",
  textFaint: "#8c8c8c",
  primary: "#3f3f46",
  primaryHover: "#27272a",
  toastBg: "#1e1e1e",
};
const GRAY_DARK: Palette = {
  ...MW_DARK,
  bg: "#161616",
  bgElev: "#1f1f1f",
  surface: "#232323",
  surface2: "#2e2e2e",
  border: "#4a4a4a",
  borderSoft: "#303030",
  text: "#ececec",
  textMuted: "#a8a8a8",
  textFaint: "#7a7a7a",
  primary: "#d4d4d8",
  primaryHover: "#ffffff",
  primaryText: "#161616",
  toastBg: "#ececec",
  toastFg: "#161616",
};

const PALETTES: Record<Exclude<ColorScheme, "custom">, { light: Palette; dark: Palette }> = {
  multiwarden: { light: MW_LIGHT, dark: MW_DARK },
  mint: { light: MINT_LIGHT, dark: MINT_DARK },
  tuvia: { light: TUVIA_LIGHT, dark: TUVIA_DARK },
  red: { light: RED_LIGHT, dark: RED_DARK },
  gray: { light: GRAY_LIGHT, dark: GRAY_DARK },
};

export const DEFAULT_CUSTOM: CustomColors = {
  background: "#eef1f6",
  container: "#ffffff",
  accent: "#7b3fe4",
  text: "#1c1d2b",
  textMuted: "#5d6278",
  border: "#cfd3df",
  danger: "#c83522",
};

function hex(c: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex([r, g, b]: [number, number, number]) {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(Math.max(0, Math.min(255, v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function mix(a: string, b: string, w: number): string {
  const x = hex(a);
  const y = hex(b);
  if (!x || !y) return a;
  return toHex([x[0] * (1 - w) + y[0] * w, x[1] * (1 - w) + y[1] * w, x[2] * (1 - w) + y[2] * w]);
}

export function luminance(c: string): number {
  const v = hex(c);
  if (!v) return 1;
  const f = (u: number) => {
    const s = u / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]);
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

function customPalette(c: Partial<CustomColors>): Palette {
  const col = { ...DEFAULT_CUSTOM, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v && hex(v))) } as CustomColors;
  const dark = luminance(col.background) < 0.25;
  const primaryText = contrast(col.accent, "#ffffff") >= contrast(col.accent, "#111111") ? "#ffffff" : "#111111";
  return {
    bg: col.background,
    bgElev: col.container,
    surface: col.container,
    surface2: mix(col.container, col.text, 0.07),
    border: col.border,
    borderSoft: mix(col.container, col.border, 0.55),
    text: col.text,
    textMuted: col.textMuted,
    textFaint: mix(col.textMuted, col.container, 0.35),
    primary: col.accent,
    primaryHover: mix(col.accent, dark ? "#ffffff" : "#000000", 0.15),
    primaryText,
    danger: col.danger,
    success: dark ? "#6fd496" : "#157a3c",
    warning: dark ? "#f2b86b" : "#b45f06",
    toastBg: col.text,
    toastFg: col.container,
    dark,
  };
}

export function resolveDark(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Known scheme (removed ones such as the former "bitwarden" fall back to MultiWarden). */
export function schemeOf(s: { colorScheme?: string }): ColorScheme {
  const c = s.colorScheme as ColorScheme | undefined;
  return c === "custom" || (c && c in PALETTES) ? c : "multiwarden";
}

/** Hex colour (#rgb / #rrggbb) normalised to #rrggbb, or null. */
export function normalizeHex(c: string): string | null {
  const v = hex(c);
  return v ? toHex(v) : null;
}

export function palette(s: AppearanceSettings): Palette {
  const scheme = schemeOf(s);
  if (scheme === "custom") return customPalette(s.customColors ?? {});
  const p = PALETTES[scheme] ?? PALETTES.multiwarden;
  return resolveDark(s.theme) ? p.dark : p.light;
}

function rgba(c: string, a: number) {
  const v = hex(c);
  return v ? `rgba(${v[0]}, ${v[1]}, ${v[2]}, ${a})` : c;
}

/** CSS custom properties for a palette (incl. aliases used by the inline menu and notification bar). */
export function cssVars(p: Palette): Record<string, string> {
  return {
    "--bg": p.bg,
    "--bg-elev": p.bgElev,
    "--surface": p.surface,
    "--surface-2": p.surface2,
    "--border": p.border,
    "--border-soft": p.borderSoft,
    "--text": p.text,
    "--text-muted": p.textMuted,
    "--text-faint": p.textFaint,
    "--primary": p.primary,
    "--primary-hover": p.primaryHover,
    "--primary-text": p.primaryText,
    "--primary-soft": rgba(p.primary, p.dark ? 0.16 : 0.1),
    "--focus": p.primary,
    "--danger": p.danger,
    "--danger-soft": rgba(p.danger, p.dark ? 0.14 : 0.1),
    "--success": p.success,
    "--warning": p.warning,
    "--toast-bg": p.toastBg,
    "--toast-fg": p.toastFg,
    "--shadow": p.dark ? "0 1px 2px rgba(0,0,0,.3)" : "0 1px 2px rgba(20,30,50,.06), 0 2px 8px rgba(20,30,50,.06)",
    "--shadow-pop": p.dark
      ? "0 10px 30px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4)"
      : "0 8px 28px rgba(15,25,45,.18), 0 1px 3px rgba(15,25,45,.12)",
    // aliases (inline menu / notification bar)
    "--hover": p.surface2,
    "--muted": p.textMuted,
    "color-scheme": p.dark ? "dark" : "light",
  };
}

let mql: MediaQueryList | null = null;
let lastSettings: AppearanceSettings | null = null;

/** Applies the scheme to the document; `surface` = page background for small embedded pages. */
export function applyAppearance(s: AppearanceSettings, opts: { surfaceAsBg?: boolean } = {}) {
  lastSettings = s;
  const p = palette(s);
  const root = document.documentElement;
  const vars = cssVars(p);
  for (const [k, v] of Object.entries(vars)) {
    if (k === "color-scheme") root.style.colorScheme = v;
    else root.style.setProperty(k, v);
  }
  if (opts.surfaceAsBg) root.style.setProperty("--bg", p.surface);
  root.setAttribute("data-theme", p.dark ? "dark" : "light");
  root.setAttribute("data-scheme", schemeOf(s));
  root.classList.toggle("compact", !!s.compactMode);
  root.classList.toggle("no-anim", s.animations === false);
  if (!mql) {
    try {
      mql = matchMedia("(prefers-color-scheme: dark)");
      mql.addEventListener("change", () => lastSettings && applyAppearance(lastSettings, opts));
    } catch {
      /* no matchMedia */
    }
  }
}

/** Reads the appearance from storage, applies it and follows changes. */
export async function initAppearance(opts: { surfaceAsBg?: boolean } = {}) {
  try {
    const r = await chrome.storage.local.get("settings");
    if (r.settings) applyAppearance(r.settings as AppearanceSettings, opts);
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.settings?.newValue) applyAppearance(ch.settings.newValue as AppearanceSettings, opts);
    });
  } catch {
    /* defaults from CSS */
  }
}
