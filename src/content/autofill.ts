// Content script: field detection, filling, the inline autofill menu (isolated iframe), the
// optional in-field icon, autofill on page load and the "save login?" capture.
import type { CollectResult, FillData, LoginCapture, MenuKind } from "../shared/messages";
import { isBlockedUrl } from "../shared/uri";
import { allInputs, fieldOptions, FormField, isPasswordField, isTextLike, isUsernameField, isVisible, menuKindOf } from "./fields";
import { collect, fill, findPairs, opidOf } from "./fill";

declare global {
  // eslint-disable-next-line no-var
  var __mwLoaded: boolean | undefined;
  // eslint-disable-next-line no-var
  var __mwCollect: (() => CollectResult) | undefined;
  // eslint-disable-next-line no-var
  var __mwFill: ((d: FillData) => { filled: number }) | undefined;
}

/** settings the page side needs (read from extension storage, kept up to date) */
const cfg = {
  inlineMenu: true,
  onIcon: false,
  blocked: [] as string[],
  pageLoad: false,
};

function applySettings(s: any) {
  if (!s || typeof s !== "object") return;
  cfg.inlineMenu = s.inlineMenu !== false;
  cfg.onIcon = !!s.inlineMenuOnIcon;
  cfg.blocked = Array.isArray(s.blockedDomains) ? s.blockedDomains : [];
  cfg.pageLoad = !!s.autofillOnPageLoad;
  fieldOptions.honorIgnore = !!s.honorBwIgnore;
  fieldOptions.honorAutofillSpans = !!s.honorBwAutofill;
}

const blocked = () => isBlockedUrl(location.href, cfg.blocked);

// ---------------------------------------------------------------------------------------------
// Inline menu

let menuHost: HTMLElement | null = null;
let menuFrame: HTMLIFrameElement | null = null;
let menuField: HTMLInputElement | null = null;
let menuToken = "";
let menuHeight = 0;
let suppressUntil = 0;
let dismissedField: HTMLInputElement | null = null;

function closeMenu() {
  menuHost?.remove();
  menuHost = null;
  menuFrame = null;
  menuField = null;
  menuToken = "";
}

function positionMenu() {
  positionIcon();
  if (!menuHost || !menuField) return;
  if (!menuField.isConnected || !isVisible(menuField)) {
    closeMenu();
    return;
  }
  const r = menuField.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 300), 380);
  let left = r.left;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  let top = r.bottom + 4;
  if (top + menuHeight > window.innerHeight - 8 && r.top - menuHeight - 4 > 8) top = r.top - menuHeight - 4;
  Object.assign(menuHost.style, { top: top + "px", left: left + "px", width: width + "px", height: menuHeight + "px" });
}

const isFocused = (field: HTMLInputElement) => document.activeElement === field || (field.getRootNode() as any).activeElement === field;

async function openMenu(field: HTMLInputElement, kind: MenuKind) {
  if (menuField === field && menuHost) return;
  closeMenu();
  let res: any;
  try {
    res = await chrome.runtime.sendMessage({ rpc: "inlineMenuToken", args: { url: location.href, kind, opid: opidOf(field) } });
  } catch {
    return;
  }
  if (!res?.ok || !res.data?.token) return;
  if (!isFocused(field)) return;
  menuToken = res.data.token;
  menuField = field;
  menuHeight = 0;
  const host = document.createElement("mw-inline-menu");
  host.setAttribute(
    "style",
    "all: initial; position: fixed; z-index: 2147483647; display: block; border: 0; margin: 0; padding: 0; height: 0;",
  );
  const shadow = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("inline-menu.html") + "#" + encodeURIComponent(menuToken);
  frame.setAttribute("allowtransparency", "true");
  frame.setAttribute("title", "MultiWarden");
  frame.setAttribute(
    "style",
    "all: initial; display: block; width: 100%; height: 100%; border: 0; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.28); background: transparent; color-scheme: normal;",
  );
  shadow.appendChild(frame);
  menuHost = host;
  menuFrame = frame;
  (document.body ?? document.documentElement).appendChild(host);
  positionMenu();
}

// --- icon inside the field ("open the menu only via the icon") ---

let iconHost: HTMLElement | null = null;
let iconField: HTMLInputElement | null = null;
let iconKind: MenuKind = "login";

/** the MultiWarden logo (same artwork as the extension icon) */
const ICON_SVG =
  '<svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">' +
  '<defs><linearGradient id="mwlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8def"/><stop offset="1" stop-color="#175ddc"/></linearGradient></defs>' +
  '<path d="M16 1.5 4.2 5.9v8.7c0 7.6 4.9 13.2 11.8 15.9 6.9-2.7 11.8-8.3 11.8-15.9V5.9Z" fill="url(#mwlg)"/>' +
  '<path d="M16 5.4v20.9c5-2.1 8.2-6.4 8.2-11.8V8.3Z" fill="#fff" fill-opacity=".2"/>' +
  '<circle cx="12" cy="13.4" r="2.9" fill="#fff"/><circle cx="20.1" cy="13.4" r="2.9" fill="#fff" fill-opacity=".78"/>' +
  '<path d="M7.9 21.8c.8-2.6 2.2-3.9 4.1-3.9s3.3 1.3 4.1 3.9M16 21.8c.8-2.6 2.2-3.9 4.1-3.9s3.3 1.3 4.1 3.9" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/>' +
  "</svg>";

function hideIcon() {
  iconHost?.remove();
  iconHost = null;
  iconField = null;
}

function positionIcon() {
  if (!iconHost || !iconField) return;
  if (!iconField.isConnected || !isVisible(iconField)) {
    hideIcon();
    return;
  }
  const r = iconField.getBoundingClientRect();
  const size = Math.max(16, Math.min(24, r.height - 6));
  Object.assign(iconHost.style, {
    top: r.top + (r.height - size) / 2 + "px",
    left: r.right - size - 6 + "px",
    width: size + "px",
    height: size + "px",
  });
}

function showIcon(field: HTMLInputElement, kind: MenuKind) {
  if (iconField === field && iconHost) return;
  hideIcon();
  const host = document.createElement("mw-inline-button");
  host.setAttribute("style", "all: initial; position: fixed; z-index: 2147483646; display: block;");
  const shadow = host.attachShadow({ mode: "closed" });
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = "MultiWarden";
  btn.setAttribute("aria-label", "MultiWarden");
  btn.innerHTML = ICON_SVG;
  btn.setAttribute(
    "style",
    "all: initial; box-sizing: border-box; display: block; width: 100%; height: 100%; padding: 0; background: transparent; cursor: pointer; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35));",
  );
  // keep the focus in the field; a real click opens the menu (synthetic clicks are ignored)
  btn.addEventListener("mousedown", (ev) => ev.preventDefault());
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!ev.isTrusted || !iconField) return;
    const f = iconField;
    try {
      f.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    if (menuField === f && menuHost) closeMenu();
    else openMenu(f, iconKind);
  });
  shadow.appendChild(btn);
  iconHost = host;
  iconField = field;
  iconKind = kind;
  (document.body ?? document.documentElement).appendChild(host);
  positionIcon();
}

// ---------------------------------------------------------------------------------------------
// "Login speichern?": capture credentials when a login / change-password form is submitted

const SUBMIT_RE =
  /log\s?in|sign\s?in|sign\s?up|anmelden|einloggen|login|weiter|continue|next|submit|absenden|senden|speichern|save|regist|konto erstellen|create account|ändern|aktualisieren|change|update|bestätigen|confirm|^ok$|^go$/i;
let lastCapture = { sig: "", at: 0 };

function looksLikeSubmit(el: Element): boolean {
  if (el instanceof HTMLButtonElement) {
    if (el.type === "submit" && el.form) return true;
    if (el.type === "reset") return false;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "submit" || el.type === "image") return true;
    if (el.type !== "button") return false;
  }
  const text = (
    (el as HTMLElement).innerText ||
    (el as HTMLInputElement).value ||
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    ""
  )
    .trim()
    .slice(0, 60);
  return SUBMIT_RE.test(text) || SUBMIT_RE.test((el as HTMLElement).id + " " + el.getAttribute("name"));
}

function captureLogin(origin: Element | null) {
  try {
    const form: HTMLFormElement | null =
      origin instanceof HTMLFormElement ? origin : ((origin as any)?.form ?? origin?.closest?.("form") ?? null);
    const all = allInputs().filter((i) => !i.disabled && i.type !== "hidden");
    let scope = form ? all.filter((i) => i.form === form || form.contains(i)) : all;
    let pws = scope.filter((i) => isPasswordField(i) && i.value);
    if (!pws.length && form) {
      scope = all;
      pws = all.filter((i) => isPasswordField(i) && i.value);
    }
    // username: nearest filled text field before the first password field, else any filled username field
    let username = "";
    const firstPw = pws[0];
    if (firstPw) {
      const idx = scope.indexOf(firstPw);
      for (let i = idx - 1; i >= 0; i--) {
        const c = scope[i];
        if (isPasswordField(c) || !c.value.trim()) continue;
        if (isUsernameField(c)) {
          username = c.value.trim();
          break;
        }
      }
    }
    if (!username) {
      const u = scope.find((i) => i.value.trim() && isUsernameField(i, true) && !isPasswordField(i));
      if (u) username = u.value.trim();
    }
    const cap: LoginCapture = { url: location.href, username };
    if (pws.length >= 3) {
      // current, new, confirmation
      cap.currentPassword = pws[0].value;
      cap.newPassword = pws[pws.length - 1].value;
    } else if (pws.length === 2) {
      if (pws[0].value === pws[1].value)
        cap.password = pws[0].value; // registration: new + confirmation
      else {
        cap.currentPassword = pws[0].value;
        cap.newPassword = pws[1].value;
      }
    } else if (pws.length === 1) cap.password = pws[0].value;
    else if (!username) return;
    const sig = [cap.username, cap.password, cap.newPassword].join("\u0000");
    const now = Date.now();
    if (sig === lastCapture.sig && now - lastCapture.at < 4000) return;
    lastCapture = { sig, at: now };
    chrome.runtime.sendMessage({ rpc: "notifyCapture", args: cap }).catch(() => {});
  } catch {
    /* never break the page */
  }
}

// ---------------------------------------------------------------------------------------------
// notification bar (top frame only)

let barHost: HTMLElement | null = null;
let barFrame: HTMLIFrameElement | null = null;
let barToken = "";

function closeBar() {
  barHost?.remove();
  barHost = null;
  barFrame = null;
  barToken = "";
}

function showBar(token: string) {
  closeBar();
  barToken = token;
  const host = document.createElement("mw-notification");
  host.setAttribute(
    "style",
    "all: initial; position: fixed; z-index: 2147483647; top: 12px; right: 12px; width: min(420px, calc(100vw - 24px)); height: 0; display: block;",
  );
  const shadow = host.attachShadow({ mode: "closed" });
  const frame = document.createElement("iframe");
  frame.src = chrome.runtime.getURL("notification.html") + "#" + encodeURIComponent(token);
  frame.setAttribute("title", "MultiWarden");
  frame.setAttribute(
    "style",
    "all: initial; display: block; width: 100%; height: 100%; border: 0; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.3); background: transparent; color-scheme: normal;",
  );
  shadow.appendChild(frame);
  barHost = host;
  barFrame = frame;
  (document.body ?? document.documentElement).appendChild(host);
}

function candidateField(t: EventTarget | null): { el: HTMLInputElement; kind: MenuKind } | null {
  let el = t as HTMLElement | null;
  // event retargeting through shadow roots
  if (el && (el as any).shadowRoot && (el as any).shadowRoot.activeElement) el = (el as any).shadowRoot.activeElement;
  if (!(el instanceof HTMLInputElement)) return null;
  if (el.disabled || el.readOnly || !(isPasswordField(el) || isTextLike(el))) return null;
  const kind = menuKindOf(el as FormField, (u) => findPairs().pairs.some((p) => p.username === u));
  return kind ? { el, kind } : null;
}

// ---------------------------------------------------------------------------------------------
// Autofill on page load: ask the background once per page when a login form is there

let pageLoadAsked = false;

function maybePageLoadFill() {
  if (pageLoadAsked || !cfg.pageLoad || blocked()) return;
  const { pairs } = findPairs();
  if (!pairs.some((p) => p.password && !p.isNew)) return;
  pageLoadAsked = true;
  chrome.runtime.sendMessage({ rpc: "pageLoadFill", args: { url: location.href } }).catch(() => {});
}

function watchForLoginForms() {
  maybePageLoadFill();
  if (pageLoadAsked) return;
  // single-page apps render their login forms later
  let timer: ReturnType<typeof setTimeout> | undefined;
  const mo = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      maybePageLoadFill();
      if (pageLoadAsked) mo.disconnect();
    }, 400);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 15_000);
}

function init() {
  window.addEventListener(
    "message",
    (ev) => {
      if (!menuFrame || ev.source !== menuFrame.contentWindow) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.mwToken !== menuToken) return;
      if (typeof d.height === "number") {
        menuHeight = Math.max(0, Math.min(d.height, 460));
        positionMenu();
      }
      if (d.close) {
        dismissedField = menuField;
        closeMenu();
      }
    },
    true,
  );

  document.addEventListener(
    "focusin",
    (ev) => {
      const path = ev.composedPath();
      if (iconHost && path.includes(iconHost)) return;
      if (Date.now() < suppressUntil || !cfg.inlineMenu || blocked()) return;
      const c = candidateField(path[0] ?? ev.target);
      if (!c) {
        if (menuHost && !path.includes(menuHost)) closeMenu();
        hideIcon();
        return;
      }
      if (cfg.onIcon) {
        if (menuField && menuField !== c.el) closeMenu();
        showIcon(c.el, c.kind);
        return;
      }
      if (c.el === dismissedField) return;
      openMenu(c.el, c.kind);
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (ev) => {
      const target = ev.composedPath()[0];
      setTimeout(() => {
        const active = document.activeElement;
        if (iconField && target === iconField && !isFocused(iconField) && active !== menuHost) hideIcon();
        if (!menuHost || target !== menuField) return;
        if (active === menuHost) return; // focus moved into the menu iframe
        if (menuField && isFocused(menuField)) return;
        closeMenu();
      }, 120);
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (ev) => {
      if (!menuHost || ev.composedPath()[0] !== menuField) return;
      if (ev.key === "Escape") {
        dismissedField = menuField;
        closeMenu();
      } else if (ev.key === "ArrowDown" && menuFrame?.contentWindow) {
        ev.preventDefault();
        menuFrame.focus();
        menuFrame.contentWindow.postMessage({ mwToken: menuToken, focusFirst: true }, "*");
      }
    },
    true,
  );

  document.addEventListener(
    "mousedown",
    (ev) => {
      const path = ev.composedPath();
      if (iconHost && path.includes(iconHost)) return;
      if (menuHost && !path.includes(menuHost) && !path.includes(menuField as any)) closeMenu();
      // clicking a dismissed field re-opens the menu
      if (cfg.onIcon || !cfg.inlineMenu || blocked()) return;
      const c = candidateField(path[0] ?? null);
      if (c && c.el === dismissedField) {
        dismissedField = null;
        setTimeout(() => openMenu(c.el, c.kind), 0);
      }
    },
    true,
  );

  // save-login capture
  document.addEventListener(
    "submit",
    (ev) => {
      if (!blocked()) captureLogin(ev.target as Element);
    },
    true,
  );
  document.addEventListener(
    "click",
    (ev) => {
      if (blocked()) return;
      const t = ev.composedPath()[0] as Element | undefined;
      const el = t?.closest?.('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a');
      if (el && looksLikeSubmit(el)) captureLogin(el);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Enter" || ev.isComposing || blocked()) return;
      const t = ev.composedPath()[0];
      if (t instanceof HTMLInputElement && t.value) captureLogin(t);
    },
    true,
  );
  window.addEventListener(
    "message",
    (ev) => {
      if (!barFrame || ev.source !== barFrame.contentWindow) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.mwNotify !== barToken) return;
      if (typeof d.height === "number" && barHost) barHost.style.height = Math.max(0, Math.min(d.height, 480)) + "px";
      if (d.close) closeBar();
    },
    true,
  );

  window.addEventListener("scroll", () => positionMenu(), { capture: true, passive: true });
  window.addEventListener("resize", () => positionMenu(), { passive: true });
  globalThis.__mwCollect = collect;
  globalThis.__mwFill = (d) => {
    suppressUntil = Date.now() + 600;
    const r = fill(d);
    closeMenu();
    return r;
  };
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.cmd === "closeInlineMenu") closeMenu();
    if (msg?.cmd === "showNotification" && typeof msg.token === "string" && window.top === window) showBar(msg.token);
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.settings) {
      applySettings(ch.settings.newValue);
      if (!cfg.inlineMenu || blocked()) {
        closeMenu();
        hideIcon();
      }
      if (cfg.onIcon) closeMenu();
      else hideIcon();
    }
  });
  chrome.storage.local
    .get("settings")
    .then((r) => {
      applySettings(r.settings);
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchForLoginForms, { once: true });
      else watchForLoginForms();
    })
    .catch(() => {});
}

if (!globalThis.__mwLoaded) {
  globalThis.__mwLoaded = true;
  init();
}
