// Own colour picker (saturation/brightness area, hue slider, suggestions). Replaces <input type="color">,
// whose native dialog (e.g. on Windows) takes the focus away and closes the extension popup.
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeHex } from "../shared/appearance";
import { t } from "../shared/i18n";

export type Hsv = { h: number; s: number; v: number };

export function hexToHsv(hex: string): Hsv {
  const n = normalizeHex(hex) ?? "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return (
    "#" +
    [r, g, b]
      .map((u) =>
        Math.round((u + m) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

/** quick suggestions: neutrals for backgrounds/text, a few accent colours */
const PRESETS = ["#ffffff", "#eef1f6", "#1c1d2b", "#111111", "#175ddc", "#0ea5e9", "#0a8f6a", "#7b3fe4", "#e5197e", "#c83522", "#f08c00"];

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function ColorPicker({
  value,
  label,
  onPreview,
  onCommit,
  onClose,
}: {
  value: string;
  label: string;
  /** while dragging / pressing keys: show the colour without saving */
  onPreview: (hex: string) => void;
  /** pointer released, key released or suggestion chosen: save */
  onCommit: (hex: string) => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const cur = useRef(hsv);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  // follow changes from outside (hex field, reset) – greys keep the hue that was set before
  useEffect(() => {
    const n = normalizeHex(value);
    if (!n || n === hsvToHex(cur.current)) return;
    const next = hexToHsv(n);
    if (next.s === 0 || next.v === 0) next.h = cur.current.h;
    cur.current = next;
    setHsv(next);
  }, [value]);

  useEffect(() => {
    svRef.current?.focus({ preventScroll: true });
  }, []);

  const update = (p: Partial<Hsv>, save: boolean) => {
    const next = { ...cur.current, ...p };
    cur.current = next;
    setHsv(next);
    (save ? onCommit : onPreview)(hsvToHex(next));
  };

  /** drag inside an area; pointer capture keeps it working outside the area (clamped) */
  const startDrag = (e: PointerEvent, el: HTMLElement | null, at: (x: number, y: number) => Partial<Hsv>) => {
    if (!el || e.button !== 0) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    const rect = el.getBoundingClientRect();
    const pos = (ev: PointerEvent) => at(clamp((ev.clientX - rect.left) / rect.width), clamp((ev.clientY - rect.top) / rect.height));
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    update(pos(e), false);
    const move = (ev: PointerEvent) => update(pos(ev), false);
    const end = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      update(ev.type === "pointercancel" ? {} : pos(ev), true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  };

  const svKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const { s, v } = cur.current;
    const p: Partial<Hsv> | null =
      e.key === "ArrowLeft"
        ? { s: clamp(s - step) }
        : e.key === "ArrowRight"
          ? { s: clamp(s + step) }
          : e.key === "ArrowUp" || e.key === "PageUp"
            ? { v: clamp(v + (e.key === "PageUp" ? 0.1 : step)) }
            : e.key === "ArrowDown" || e.key === "PageDown"
              ? { v: clamp(v - (e.key === "PageDown" ? 0.1 : step)) }
              : e.key === "Home"
                ? { s: 0 }
                : e.key === "End"
                  ? { s: 1 }
                  : null;
    if (!p) return;
    e.preventDefault();
    update(p, false);
  };

  const hueKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey || e.key.startsWith("Page") ? 10 : 1;
    const { h } = cur.current;
    const p: Partial<Hsv> | null =
      e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown"
        ? { h: clamp(h - step, 0, 359) }
        : e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp"
          ? { h: clamp(h + step, 0, 359) }
          : e.key === "Home"
            ? { h: 0 }
            : e.key === "End"
              ? { h: 359 }
              : null;
    if (!p) return;
    e.preventDefault();
    update(p, false);
  };

  const saveAfterKey = (e: KeyboardEvent) => {
    if (NAV_KEYS.has(e.key)) onCommit(hsvToHex(cur.current));
  };

  const hex = hsvToHex(hsv);
  return (
    <div
      class="cp"
      data-testid="color-picker"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        ref={svRef}
        class="cp-sv"
        style={{ background: `hsl(${hsv.h} 100% 50%)` }}
        role="slider"
        tabIndex={0}
        aria-label={t("{label}: Sättigung und Helligkeit", { label })}
        aria-valuetext={t("Sättigung {s} %, Helligkeit {v} %", { s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) })}
        data-testid="cp-sv"
        onPointerDown={(e) => startDrag(e as unknown as PointerEvent, svRef.current, (x, y) => ({ s: x, v: 1 - y }))}
        onKeyDown={(e) => svKeys(e as unknown as KeyboardEvent)}
        onKeyUp={(e) => saveAfterKey(e as unknown as KeyboardEvent)}
      >
        <span class="cp-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
      </div>
      <div
        ref={hueRef}
        class="cp-hue"
        role="slider"
        tabIndex={0}
        aria-label={t("{label}: Farbton", { label })}
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(hsv.h)}
        data-testid="cp-hue"
        onPointerDown={(e) => startDrag(e as unknown as PointerEvent, hueRef.current, (x) => ({ h: Math.min(359, x * 360) }))}
        onKeyDown={(e) => hueKeys(e as unknown as KeyboardEvent)}
        onKeyUp={(e) => saveAfterKey(e as unknown as KeyboardEvent)}
      >
        <span class="cp-thumb" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
      <div class="cp-presets" role="group" aria-label={t("Farbvorschläge")}>
        {PRESETS.map((c) => (
          <button
            type="button"
            key={c}
            class={"cp-preset" + (c === hex ? " on" : "")}
            style={{ background: c }}
            title={c}
            aria-label={c}
            data-testid={"cp-preset-" + c.slice(1)}
            onClick={() => {
              const next = hexToHsv(c);
              if (next.s === 0 || next.v === 0) next.h = cur.current.h;
              update(next, true);
            }}
          />
        ))}
      </div>
    </div>
  );
}
