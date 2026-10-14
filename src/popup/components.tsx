import { ComponentChildren, createContext, JSX } from "preact";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { generateTotp } from "../crypto/totp";
import type { AccountPublic, ItemView } from "../shared/types";
import { Icon, IconName } from "./icons";
import { faviconUrl, TYPE_ICON } from "./util";

import { t } from "../shared/i18n";
// ---------------------------------------------------------------------------------------------
// Toasts

export interface ToastApi {
  show: (msg: string, kind?: "ok" | "error") => void;
}
export const ToastCtx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ComponentChildren }) {
  const [tx, setT] = useState<{ msg: string; kind: string; id: number } | null>(null);
  const timer = useRef<number>();
  const api: ToastApi = {
    show(msg, kind = "ok") {
      window.clearTimeout(timer.current);
      setT({ msg, kind, id: Date.now() });
      timer.current = window.setTimeout(() => setT(null), kind === "error" ? 4200 : 1800);
    },
  };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      {tx && (
        <div class={"toast " + (tx.kind === "error" ? "error" : "")} role="status" key={tx.id}>
          <Icon name={tx.kind === "error" ? "alert" : "check"} size={16} />
          {tx.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Popover menu anchored to an element

export function Popover({
  anchor,
  onClose,
  children,
  align = "start",
  width,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ComponentChildren;
  align?: "start" | "end";
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number }>({ top: -9999, left: -9999, maxH: 340 });
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const r = anchor.getBoundingClientRect();
    const pw = ref.current.offsetWidth;
    const ph = ref.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = align === "end" ? r.right - pw : r.left;
    left = Math.max(6, Math.min(left, vw - pw - 6));
    let top = r.bottom + 4;
    let maxH = Math.min(340, vh - top - 8);
    if (maxH < 160 && r.top > vh / 2) {
      maxH = Math.min(340, r.top - 12);
      top = Math.max(6, r.top - 4 - Math.min(ph, maxH));
    }
    setPos({ top, left, maxH });
  }, [anchor]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu-item:not([disabled])") ?? []);
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLElement);
        const n = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[n].focus();
      }
    };
    document.addEventListener("keydown", k, true);
    const first = ref.current?.querySelector<HTMLElement>(".menu-item.checked, .menu-item");
    first?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", k, true);
  }, []);
  return (
    <>
      <div class="popover-backdrop" onClick={onClose} />
      <div
        class="popover"
        ref={ref}
        role="menu"
        style={{ top: pos.top, left: pos.left, maxHeight: pos.maxH, width: width ? width + "px" : undefined }}
      >
        {children}
      </div>
    </>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  checked,
  danger,
  meta,
  disabled,
  lead,
}: {
  icon?: IconName;
  children: ComponentChildren;
  onClick?: () => void;
  checked?: boolean;
  danger?: boolean;
  meta?: ComponentChildren;
  disabled?: boolean;
  lead?: ComponentChildren;
}) {
  return (
    <button
      class={"menu-item" + (checked ? " checked" : "") + (danger ? " danger" : "")}
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
    >
      {lead}
      {icon && <Icon name={icon} size={16} />}
      <span class="grow">{children}</span>
      {meta && <span class="meta">{meta}</span>}
      {checked && <Icon name="check" size={16} />}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Chip-style select (like the filters of the official popup)

export interface ChipOption {
  value: string;
  label: string;
  meta?: ComponentChildren;
  /** accounts the entry belongs to (badges on the right) */
  accounts?: AccountPublic[];
  icon?: IconName;
  lead?: ComponentChildren;
  header?: boolean;
  indent?: number;
}

export function ChipSelect({
  icon,
  placeholder,
  value,
  options,
  onChange,
  class: cls,
  testid,
}: {
  icon: IconName;
  placeholder: string;
  value: string | null;
  options: ChipOption[];
  onChange: (v: string | null) => void;
  class?: string;
  testid?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const sel = options.find((o) => !o.header && o.value === value);
  return (
    <div class={cls} style={{ minWidth: 0 }}>
      <button
        ref={ref}
        class={"chip" + (sel ? " selected" : "")}
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testid}
        title={sel ? placeholder + ": " + sel.label : placeholder}
      >
        <Icon name={icon} size={16} />
        <span class="label">{sel ? sel.label : placeholder}</span>
        {sel ? (
          <span
            class="clear"
            role="button"
            aria-label={t("Filter entfernen")}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          >
            <Icon name="x" size={14} />
          </span>
        ) : (
          <Icon name="chevronDown" size={16} />
        )}
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)}>
          <MenuItem
            checked={!sel}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            {t("Alle")}
          </MenuItem>
          <div class="menu-sep" />
          {options.length === 0 && <div class="menu-head">{t("Keine Einträge")}</div>}
          {options.map((o) =>
            o.header ? (
              <div class="menu-head" key={"h" + o.label}>
                {o.label}
              </div>
            ) : (
              <MenuItem
                key={o.value}
                icon={o.icon}
                lead={o.lead}
                meta={o.accounts?.length ? <AccountBadges accs={o.accounts} /> : o.meta}
                checked={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span style={{ paddingLeft: (o.indent ?? 0) * 12 }}>{o.label}</span>
              </MenuItem>
            ),
          )}
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Accounts

export function Avatar({ acc, size = "", showState }: { acc: AccountPublic; size?: "" | "sm" | "lg"; showState?: boolean }) {
  return (
    <span
      class={`avatar ${size} ${acc.status !== "unlocked" ? "locked" : ""}`}
      style={{ background: acc.color }}
      title={`${acc.label} (${acc.serverLabel})`}
    >
      <span class="ini">{acc.initials}</span>
      {showState && acc.status !== "unlocked" && (
        <span class="state">
          <Icon name="lock" size={9} />
        </span>
      )}
    </span>
  );
}

/** Badges of several accounts (e.g. a folder name that exists in more than one account). */
export function AccountBadges({ accs }: { accs: AccountPublic[] }) {
  const shown = accs.slice(0, 3);
  return (
    <span class="acct-badges" data-testid="account-badges">
      {shown.map((a) => (
        <AccountBadge acc={a} key={a.key} />
      ))}
      {accs.length > shown.length && <span class="acct-badge more">+{accs.length - shown.length}</span>}
    </span>
  );
}

export function AccountBadge({ acc }: { acc?: AccountPublic }) {
  if (!acc) return null;
  return (
    <span
      class="acct-badge"
      style={{ color: acc.color, borderColor: acc.color + "66", background: acc.color + "1a" }}
      title={`${acc.email} · ${acc.serverLabel}`}
    >
      <span class="dot" style={{ background: acc.color }} />
      {acc.initials}
    </span>
  );
}

export function ItemIcon({ item, acc, favicons }: { item: ItemView; acc?: AccountPublic; favicons: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = faviconUrl(item, acc, favicons);
  return (
    <span class="item-icon">
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={(e) => {
            if ((e.currentTarget as HTMLImageElement).naturalWidth < 4) setFailed(true);
          }}
        />
      ) : (
        <Icon name={TYPE_ICON[item.type] ?? "note"} size={18} />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Form bits

export function Switch({
  checked,
  onChange,
  label,
  testid,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <label class={"switch" + (disabled ? " disabled" : "")} title={label} data-testid={testid}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
        aria-label={label}
      />
      <span />
    </label>
  );
}

export function Field({
  label,
  children,
  hint,
  error,
  group,
}: {
  label: string;
  children: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  /** render as a group (for controls that are not a single input) */
  group?: boolean;
}) {
  const inner = (
    <>
      <span class="lbl">{label}</span>
      {children}
      {hint && <div class="hint">{hint}</div>}
      {error && <div class="error-text">{error}</div>}
    </>
  );
  return group ? (
    <div class="field" role="group" aria-label={label}>
      {inner}
    </div>
  ) : (
    <label class="field">{inner}</label>
  );
}

export function TextInput(
  props: Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "value" | "onInput"> & {
    value: string;
    onValue: (v: string) => void;
    suffix?: ComponentChildren;
    mono?: boolean;
    invalid?: boolean;
    "data-testid"?: string;
  },
) {
  const { value, onValue, suffix, mono, invalid, autoFocus, ...rest } = props as any;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  return (
    <div class={"input-wrap" + (invalid ? " invalid" : "")}>
      <input
        ref={ref}
        {...(rest as any)}
        class={mono ? "mono" : ""}
        value={value}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
      />
      {suffix}
    </div>
  );
}

export function PasswordInput({
  value,
  onValue,
  placeholder,
  autoFocus,
  extra,
  id,
  name,
  autocomplete = "current-password",
  onEnter,
  inputMode,
}: {
  value: string;
  onValue: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  extra?: ComponentChildren;
  id?: string;
  name?: string;
  autocomplete?: string;
  onEnter?: () => void;
  inputMode?: "numeric" | "text";
}) {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  return (
    <div class="input-wrap">
      <input
        ref={ref}
        id={id}
        name={name}
        class="mono"
        type={show ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        autocomplete={autocomplete}
        inputMode={inputMode}
        spellcheck={false}
        onInput={(e) => onValue((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <button
        type="button"
        class="icon-btn sm"
        onClick={() => setShow(!show)}
        title={show ? t("Verbergen") : t("Anzeigen")}
        aria-label={show ? t("Passwort verbergen") : t("Passwort anzeigen")}
      >
        <Icon name={show ? "eyeOff" : "eye"} size={16} />
      </button>
      {extra}
    </div>
  );
}

/** Password with colored digits/specials, like the official client. */
export function ColoredPassword({ value }: { value: string }) {
  return (
    <span class="mono">
      {Array.from(value).map((c, i) =>
        /[0-9]/.test(c) ? (
          <span class="pw-char-digit" key={i}>
            {c}
          </span>
        ) : /[^a-zA-Z0-9]/.test(c) ? (
          <span class="pw-char-special" key={i}>
            {c}
          </span>
        ) : (
          c
        ),
      )}
    </span>
  );
}

export function useTotp(secret?: string) {
  const [st, setSt] = useState<{ code: string; remaining: number; period: number } | null>(null);
  useEffect(() => {
    if (!secret) {
      setSt(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      const r = await generateTotp(secret);
      if (alive) setSt(r);
    };
    tick();
    const tx = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(tx);
    };
  }, [secret]);
  return st;
}

export function TotpRing({ remaining, period }: { remaining: number; period: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  const frac = remaining / period;
  const color = remaining <= 5 ? "var(--danger)" : "var(--primary)";
  return (
    <svg class="ring" viewBox="0 0 22 22" aria-label={`${remaining} Sekunden`}>
      <circle cx="11" cy="11" r={r} fill="none" stroke="var(--surface-2)" stroke-width="2.5" />
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        stroke={color}
        stroke-width="2.5"
        stroke-dasharray={c}
        stroke-dashoffset={c * (1 - frac)}
        transform="rotate(-90 11 11)"
        stroke-linecap="round"
      />
      <text x="11" y="14.5" text-anchor="middle" font-size="9" font-weight="700" fill="var(--text-muted)">
        {remaining}
      </text>
    </svg>
  );
}

export function formatTotp(code: string) {
  if (code.length === 6) return code.slice(0, 3) + " " + code.slice(3);
  if (code.length === 8) return code.slice(0, 4) + " " + code.slice(4);
  return code;
}

export function Spinner() {
  return <span class="spinner" aria-label={t("Lädt")} />;
}
