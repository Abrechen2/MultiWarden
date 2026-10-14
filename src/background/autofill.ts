// Background side of autofill: frame discovery, fill orchestration (logins, cards, identities,
// generated passwords), inline menu tokens, autofill on page load, badge.
import { generateTotp } from "../crypto/totp";
import { generateWithSavedOptions } from "../shared/generator";
import { EventType } from "../shared/events";
import type { CollectResult, FillData, InlineMenuData, InlineMenuItem, MenuKind } from "../shared/messages";
import { CipherType, FieldType, ItemView } from "../shared/types";
import { hostnameOf, isBlockedUrl, isFillableUrl } from "../shared/uri";
import { initialsOf, VaultService } from "./vault-service";

import { t } from "../shared/i18n";
interface FrameResult {
  frameId: number;
  result: CollectResult | null;
}

async function runCollect(tabId: number): Promise<FrameResult[]> {
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (globalThis as any).__mwCollect?.() ?? null,
  });
  return res.map((r) => ({ frameId: r.frameId, result: (r.result as CollectResult | null) ?? null }));
}

export async function injectContentScript(tabId: number) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content/autofill.js"] });
  } catch {
    /* some frames may not be injectable */
  }
}

export async function collectFrames(tabId: number): Promise<FrameResult[]> {
  let frames = await runCollect(tabId);
  if (frames.some((f) => f.result === null)) {
    await injectContentScript(tabId);
    frames = await runCollect(tabId);
  }
  return frames.filter((f) => f.result);
}

async function fillFrame(tabId: number, frameId: number, data: FillData): Promise<number> {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (d: any) => (globalThis as any).__mwFill?.(d) ?? { filled: 0 },
      args: [data],
    });
    return (r?.result as any)?.filled ?? 0;
  } catch {
    return 0; // frame gone
  }
}

/** Login saved only for https URLs, but the page is plain http. */
export function insecureFor(item: ItemView, url: string): boolean {
  const uris = item.login?.uris ?? [];
  return uris.length > 0 && uris.every((u) => /^https:/i.test(u.uri.trim())) && /^http:/i.test(url);
}

/** Error codes the popup reacts to (asks before filling anyway). */
export const FILL_MISMATCH = "mismatch";
export const FILL_INSECURE = "insecure";

export interface FillOutcome {
  ok: boolean;
  error?: string;
  code?: typeof FILL_MISMATCH | typeof FILL_INSECURE;
  totp?: string;
}

export async function activeTab(tabId?: number): Promise<chrome.tabs.Tab | undefined> {
  if (tabId != null) return chrome.tabs.get(tabId).catch(() => undefined);
  const [tx] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  if (tx) return tx;
  const [t2] = await chrome.tabs.query({ active: true, windowType: "normal" });
  return t2;
}

export interface FillOptions {
  /** only this frame (inline menu, context menu) */
  frameId?: number;
  targetOpid?: string;
  /** the user confirmed filling a page that does not match / is insecure */
  force?: boolean;
  /** autofill on page load: only empty fields, only login forms */
  pageLoad?: boolean;
}

export async function fillItem(svc: VaultService, tabId: number, item: ItemView, opts: FillOptions = {}): Promise<FillOutcome> {
  if (item.type === CipherType.Card || item.type === CipherType.Identity) return fillCardOrIdentity(svc, tabId, item, opts);
  if (item.type !== CipherType.Login || !item.login)
    return { ok: false, error: t("Nur Logins, Karten und Identitäten können ausgefüllt werden") };
  let frames: FrameResult[];
  try {
    frames = await collectFrames(tabId);
  } catch {
    return { ok: false, error: t("Auf dieser Seite kann nicht ausgefüllt werden") };
  }
  const top = frames.find((f) => f.frameId === 0);
  const topMatches = !!top && svc.itemMatchesUrl(item, top.result!.url);
  // saved only for https, but the page is plain http → possible downgrade, ask first
  const insecure = (url: string) => insecureFor(item, url);
  let blockedInsecure = false;
  const wantsTotp = !!item.login.totp;
  const fillable = (r: CollectResult) =>
    opts.pageLoad ? r.hasPassword : r.hasPassword || r.hasNewPassword || r.hasUsername || (wantsTotp && r.hasTotp);
  let targets = frames.filter((f) => {
    const r = f.result!;
    if (!fillable(r)) return false;
    const eligible =
      svc.itemMatchesUrl(item, r.url) ||
      (topMatches && r.origin === top!.result!.origin) ||
      // explicit user choice from the popup: allow top frame and same-origin frames
      (!!opts.force && !!top && r.origin === top.result!.origin);
    if (eligible && insecure(r.url) && !opts.force) {
      blockedInsecure = true;
      return false;
    }
    return eligible;
  });
  if (opts.frameId != null) targets = targets.filter((f) => f.frameId === opts.frameId);
  if (!targets.length) {
    if (!frames.some((f) => fillable(f.result!))) return { ok: false, error: t("Keine Anmeldefelder auf dieser Seite gefunden") };
    if (blockedInsecure) return { ok: false, code: FILL_INSECURE, error: t("Die Seite verwendet eine unverschlüsselte Verbindung (http)") };
    return { ok: false, code: FILL_MISMATCH, error: t("Die Seite passt nicht zu diesem Eintrag") };
  }
  let totp: string | undefined;
  if (item.login.totp && !opts.pageLoad) totp = (await generateTotp(item.login.totp))?.code;
  const data: FillData = {
    kind: "login",
    username: item.login.username,
    password: item.login.password,
    totp,
    fields: customFields(item),
    targetOpid: opts.targetOpid,
    onlyEmpty: !!opts.pageLoad,
  };
  let filled = 0;
  for (const tx of targets) filled += await fillFrame(tabId, tx.frameId, data);
  if (!filled) return { ok: false, error: t("Es konnten keine Felder ausgefüllt werden") };
  await svc.markUsed(item.accountKey, item.id);
  svc.events.collect(item.accountKey, EventType.CipherClientAutofilled, item);
  return { ok: true, totp };
}

function customFields(item: ItemView) {
  return item.fields.filter((f) => f.type !== FieldType.Linked && f.name).map((f) => ({ name: f.name, value: f.value }));
}

async function fillCardOrIdentity(svc: VaultService, tabId: number, item: ItemView, opts: FillOptions): Promise<FillOutcome> {
  const isCard = item.type === CipherType.Card;
  let frames: FrameResult[];
  try {
    frames = await collectFrames(tabId);
  } catch {
    return { ok: false, error: t("Auf dieser Seite kann nicht ausgefüllt werden") };
  }
  const top = frames.find((f) => f.frameId === 0);
  const topOrigin = top?.result?.origin;
  let targets = frames.filter((f) => (isCard ? f.result!.cardFields > 0 : f.result!.identityFields > 0));
  if (opts.frameId != null) targets = targets.filter((f) => f.frameId === opts.frameId);
  // identities: page + same-origin frames; cards also in hosted payment frames (card number / CVC)
  else targets = targets.filter((f) => f.result!.origin === topOrigin || (isCard && f.result!.hasCardNumber));
  if (!targets.length)
    return {
      ok: false,
      error: isCard ? t("Keine Kartenfelder auf dieser Seite gefunden") : t("Keine Adress- oder Personenfelder auf dieser Seite gefunden"),
    };
  const base: FillData = {
    kind: isCard ? "card" : "identity",
    card: isCard ? item.card : undefined,
    identity: isCard ? undefined : item.identity,
    fields: customFields(item),
    targetOpid: opts.targetOpid,
  };
  let filled = 0;
  for (const tx of targets) {
    const crossOrigin = tx.result!.origin !== topOrigin && opts.frameId == null;
    filled += await fillFrame(tabId, tx.frameId, { ...base, requireCardNumber: crossOrigin });
  }
  if (!filled) return { ok: false, error: t("Es konnten keine Felder ausgefüllt werden") };
  await svc.markUsed(item.accountKey, item.id);
  svc.events.collect(item.accountKey, EventType.CipherClientAutofilled, item);
  return { ok: true };
}

/** Generated password into the new-password fields of a frame (or the focused field). */
export async function fillGenerated(tabId: number, frameId: number, password: string, targetOpid?: string): Promise<boolean> {
  return (await fillFrame(tabId, frameId, { kind: "generated", password, targetOpid })) > 0;
}

// ---------------------------------------------------------------------------------------------
// Inline menu tokens

interface MenuToken {
  tabId: number;
  frameId: number;
  url: string;
  kind: MenuKind;
  opid?: string;
  generated?: string;
  created: number;
}

const tokens = new Map<string, MenuToken>();

export function createMenuToken(tabId: number, frameId: number, url: string, kind: MenuKind = "login", opid?: string): string {
  const now = Date.now();
  for (const [k, v] of tokens) if (now - v.created > 10 * 60_000) tokens.delete(k);
  const tx = crypto.randomUUID();
  tokens.set(tx, { tabId, frameId, url, kind, opid, created: now });
  return tx;
}

export function getMenuToken(tx: string): MenuToken | undefined {
  return tokens.get(tx);
}

/** Should the inline menu open for this field? (null: no) */
export async function inlineMenuTokenFor(
  svc: VaultService,
  sender: chrome.runtime.MessageSender,
  args: { url?: string; kind?: MenuKind; opid?: string },
  hasConditionalPasskeys: (tabId: number, frameId: number) => boolean,
): Promise<string | null> {
  const s = svc.settings;
  if (!s.inlineMenu || !sender.tab?.id || sender.frameId == null) return null;
  const url = sender.url ?? args.url;
  if (!isFillableUrl(url) || isBlockedUrl(url, s.blockedDomains)) return null;
  if (!svc.accounts.length) return null;
  const kind: MenuKind = (["login", "newPassword", "card", "identity"] as const).includes(args.kind as any) ? args.kind! : "login";
  const unlocked = svc.anyUnlocked();
  switch (kind) {
    case "login":
      if (unlocked && !hasConditionalPasskeys(sender.tab.id, sender.frameId) && !(await svc.matchesForUrl(url!)).length) return null;
      break;
    case "newPassword":
      break;
    case "card":
      if (!s.inlineMenuCards) return null;
      if (unlocked && !(await svc.itemsOfType(CipherType.Card)).length) return null;
      break;
    case "identity":
      if (!s.inlineMenuIdentities) return null;
      if (unlocked && !(await svc.itemsOfType(CipherType.Identity)).length) return null;
      break;
  }
  return createMenuToken(sender.tab.id, sender.frameId, url!, kind, typeof args.opid === "string" ? args.opid : undefined);
}

function cardSubtitle(i: ItemView) {
  const n = (i.card?.number ?? "").replace(/\s/g, "");
  return [i.card?.brand, n ? "*" + n.slice(-4) : ""].filter(Boolean).join(", ");
}

function identitySubtitle(i: ItemView) {
  const id = i.identity ?? {};
  return [id.firstName, id.lastName].filter(Boolean).join(" ") || id.email || id.address1 || "";
}

export async function inlineMenuData(svc: VaultService, token: string): Promise<InlineMenuData> {
  const tk = tokens.get(token);
  const hasAccounts = svc.accounts.length > 0;
  const theme = svc.settings.theme;
  const multi = svc.accounts.length > 1;
  const empty = { items: [], passkeys: [], showFavicons: false, theme, multi };
  if (!tk) return { kind: "login", locked: false, hasAccounts, ...empty };
  const locked = hasAccounts && !svc.anyUnlocked();
  const items: InlineMenuItem[] = [];
  const data: InlineMenuData = { kind: tk.kind, locked, hasAccounts, ...empty, items, showFavicons: svc.settings.showFavicons };
  if (tk.kind === "newPassword") {
    if (!tk.generated) tk.generated = await generateWithSavedOptions();
    data.generated = tk.generated;
  }
  if (locked) return data;
  const accounts = new Map(svc.accounts.map((a) => [a.key, a]));
  const push = (it: ItemView, sub: string, icon?: string) => {
    const acc = accounts.get(it.accountKey)!;
    items.push({
      accountKey: it.accountKey,
      id: it.id,
      type: it.type,
      name: it.name,
      username: sub,
      accountLabel: acc.label || acc.email,
      accountColor: acc.color,
      accountInitials: initialsOf(acc),
      icon,
    });
  };
  if (tk.kind === "login" || tk.kind === "newPassword") {
    for (const it of (await svc.matchesForUrl(tk.url)).filter((i) => i.reprompt !== 1 && !insecureFor(i, tk.url))) {
      const acc = accounts.get(it.accountKey)!;
      const host = it.login?.uris.map((u) => hostnameOf(u.uri)).find(Boolean);
      push(it, it.login?.username ?? "", svc.settings.showFavicons && host ? `${acc.urls.icons}/${host}/icon.png` : undefined);
    }
  } else if (tk.kind === "card") {
    for (const it of (await svc.itemsOfType(CipherType.Card)).filter((i) => i.reprompt !== 1)) push(it, cardSubtitle(it));
  } else {
    for (const it of (await svc.itemsOfType(CipherType.Identity)).filter((i) => i.reprompt !== 1)) push(it, identitySubtitle(it));
  }
  return data;
}

export async function inlineMenuFill(svc: VaultService, token: string, accountKey: string, itemId: string) {
  const tk = tokens.get(token);
  if (!tk) return { ok: false };
  const item = await svc.findItem(accountKey, itemId);
  if (!item || item.reprompt === 1) return { ok: false };
  const fits =
    tk.kind === "card"
      ? item.type === CipherType.Card
      : tk.kind === "identity"
        ? item.type === CipherType.Identity
        : item.type === CipherType.Login && svc.itemMatchesUrl(item, tk.url);
  if (!fits) return { ok: false };
  const r = await fillItem(svc, tk.tabId, item, { frameId: tk.frameId, targetOpid: tk.opid });
  closeInlineMenu(tk);
  return { ok: r.ok, totp: r.totp };
}

export async function inlineMenuGenerate(token: string): Promise<string> {
  const tk = tokens.get(token);
  if (!tk || tk.kind !== "newPassword") throw new Error(t("Sitzung abgelaufen"));
  tk.generated = await generateWithSavedOptions();
  return tk.generated;
}

export async function inlineMenuFillGenerated(token: string): Promise<{ ok: boolean; password?: string }> {
  const tk = tokens.get(token);
  if (!tk || tk.kind !== "newPassword" || !tk.generated) return { ok: false };
  const ok = await fillGenerated(tk.tabId, tk.frameId, tk.generated, tk.opid);
  closeInlineMenu(tk);
  return { ok, password: ok ? tk.generated : undefined };
}

function closeInlineMenu(tk: MenuToken) {
  chrome.tabs.sendMessage(tk.tabId, { cmd: "closeInlineMenu" }, { frameId: tk.frameId }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Autofill on page load

/** Item to fill when a login form appears: last used of the matches that allow it. */
export async function pageLoadCandidate(svc: VaultService, url: string): Promise<ItemView | undefined> {
  const s = svc.settings;
  if (!s.autofillOnPageLoad || !svc.anyUnlocked() || !isFillableUrl(url) || isBlockedUrl(url, s.blockedDomains)) return undefined;
  const matches = (await svc.matchesForUrl(url)).filter(
    (i) => i.reprompt !== 1 && !insecureFor(i, url) && (i.login?.autofillOnPageLoad ?? s.autofillOnPageLoadDefault),
  );
  return matches[0];
}

// ---------------------------------------------------------------------------------------------
// Badge with number of matching logins

export async function updateBadge(svc: VaultService, tab?: chrome.tabs.Tab) {
  try {
    const tx = tab ?? (await activeTab());
    if (!tx?.id) return;
    if (!svc.anyUnlocked() || svc.settings.badgeCounter === false) {
      await chrome.action.setBadgeText({ tabId: tx.id, text: "" });
      return;
    }
    const n = isFillableUrl(tx.url) ? (await svc.matchesForUrl(tx.url!)).length : 0;
    await chrome.action.setBadgeBackgroundColor({ tabId: tx.id, color: "#175ddc" });
    await chrome.action.setBadgeText({ tabId: tx.id, text: n ? String(n) : "" });
  } catch {
    /* tab closed */
  }
}
