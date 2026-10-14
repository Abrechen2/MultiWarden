// "Login speichern?" / "Passwort aktualisieren?": captured form submissions → notification bar.
import { newLoginItem } from "../shared/items";
import type { LoginCapture, NotificationData } from "../shared/messages";
import { CipherType, ItemView } from "../shared/types";
import { addNeverDomain, isNeverDomain } from "./never-domains";
import { session } from "./store";
import { VaultService } from "./vault-service";

import { t } from "../shared/i18n";
interface Pending {
  token: string;
  tabId: number;
  url: string;
  host: string;
  username: string;
  password: string;
  /** change-password form: the old password */
  currentPassword?: string;
  created: number;
  shown: boolean;
  navigating?: boolean;
}

const TTL = 5 * 60_000;
const SHOW_DELAY = 2500;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function itemName(host: string) {
  return host.replace(/^www\./, "");
}

export class NotificationService {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private svc: VaultService,
    private hooks: { injectContentScript(tabId: number): Promise<void> },
  ) {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === "loading") this.markNavigating(tabId).catch(() => {});
      if (info.status === "complete") this.maybeShow(tabId, true).catch(() => {});
    });
    chrome.tabs.onRemoved.addListener(async (tabId) => {
      const p = await session.get<Pending>("notify:" + tabId).catch(() => undefined);
      if (p) await this.drop(p).catch(() => {});
      await session.remove("notifyUser:" + tabId).catch(() => {});
    });
  }

  private async get(tabId: number): Promise<Pending | undefined> {
    const p = await session.get<Pending>("notify:" + tabId);
    if (p && Date.now() - p.created > TTL) {
      await this.drop(p);
      return undefined;
    }
    return p;
  }

  private async put(p: Pending) {
    await session.set("notify:" + p.tabId, p);
    await session.set("notifyTok:" + p.token, p.tabId);
  }

  private async byToken(token: string): Promise<Pending | undefined> {
    if (typeof token !== "string" || !token) return undefined;
    const tabId = await session.get<number>("notifyTok:" + token);
    if (tabId == null) return undefined;
    const p = await this.get(tabId);
    return p?.token === token ? p : undefined;
  }

  private async drop(p: Pending) {
    await session.remove(["notify:" + p.tabId, "notifyTok:" + p.token]);
  }

  // -------------------------------------------------------------------------------------------
  // capture from the content script

  async capture(c: LoginCapture, sender: chrome.runtime.MessageSender) {
    await this.svc.ready;
    const tabId = sender.tab?.id;
    if (tabId == null || !this.svc.accounts.length) return;
    const url = sender.url ?? c.url;
    if (!/^https?:/i.test(url)) return;
    const s = this.svc.settings;
    if (!s.promptSave && !s.promptUpdate) return;
    const host = hostOf(url);
    if (!host || (await isNeverDomain(host))) return;
    const password = c.newPassword || c.password;
    let username = (c.username ?? "").trim();
    if (!password) {
      // username step of a multi-page login: remember it for the password step
      if (username) await session.set("notifyUser:" + tabId, { host, username, at: Date.now() });
      return;
    }
    if (!username) {
      const prev = await session.get<{ host: string; username: string; at: number }>("notifyUser:" + tabId);
      if (prev && prev.host === host && Date.now() - prev.at < TTL) username = prev.username;
    }
    const p: Pending = {
      token: crypto.randomUUID(),
      tabId,
      url,
      host,
      username,
      password,
      currentPassword: c.newPassword ? c.currentPassword : undefined,
      created: Date.now(),
      shown: false,
    };
    const old = await this.get(tabId);
    if (old) await this.drop(old);
    await this.put(p);
    clearTimeout(this.timers.get(tabId));
    // SPA logins don't navigate: show after a moment unless a navigation started
    this.timers.set(
      tabId,
      setTimeout(() => this.maybeShow(tabId, false).catch(() => {}), SHOW_DELAY),
    );
  }

  private async markNavigating(tabId: number) {
    const p = await this.get(tabId);
    if (p && !p.shown && !p.navigating) {
      p.navigating = true;
      await this.put(p);
    }
  }

  private async maybeShow(tabId: number, afterNavigation: boolean) {
    const p = await this.get(tabId);
    if (!p || p.shown) return;
    if (!afterNavigation && p.navigating) return; // wait for the page load to complete
    clearTimeout(this.timers.get(tabId));
    const data = await this.data(p);
    if (data.kind === "none") {
      await this.drop(p);
      return;
    }
    p.shown = true;
    await this.put(p);
    const msg = { cmd: "showNotification", token: p.token };
    try {
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    } catch {
      await this.hooks.injectContentScript(tabId);
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------------------------
  // decision

  private async matching(p: Pending): Promise<ItemView[]> {
    return (await this.svc.matchesForUrl(p.url)).filter((i) => i.type === CipherType.Login && i.login && !i.deletedDate);
  }

  async data(p: Pending): Promise<NotificationData> {
    const s = this.svc.settings;
    const pub = this.svc.publicAccounts();
    const unlocked = pub.filter((a) => a.status === "unlocked");
    const base: NotificationData = {
      kind: "none",
      locked: unlocked.length === 0,
      host: p.host,
      username: p.username,
      accounts: unlocked.map((a) => ({ key: a.key, label: a.label, color: a.color, initials: a.initials, serverLabel: a.serverLabel })),
      folders: [],
      targets: [],
      theme: s.theme,
    };
    if (base.locked) {
      if (s.promptSave || s.promptUpdate) base.kind = "save";
      return base;
    }
    const items = await this.matching(p);
    const sameUser = (i: ItemView) => (i.login?.username ?? "").trim().toLowerCase() === p.username.toLowerCase();
    let candidates = items.filter(sameUser);
    if (p.currentPassword) {
      // change-password form: the login that had the old password
      const withOld = items.filter((i) => i.login?.password === p.currentPassword);
      if (withOld.length) candidates = withOld;
    }
    if (candidates.some((i) => i.login?.password === p.password)) return base; // already saved
    if (candidates.length) {
      if (!s.promptUpdate) return base;
      const editable = candidates.filter((i) => i.edit);
      if (!editable.length) return base;
      base.kind = "update";
      base.targets = editable.map((i) => {
        const a = pub.find((x) => x.key === i.accountKey)!;
        return { accountKey: i.accountKey, itemId: i.id, name: i.name, accountLabel: a.label, accountColor: a.color };
      });
      return base;
    }
    if (!s.promptSave || p.currentPassword) return base;
    base.kind = "save";
    const vault = await this.svc.getVault();
    base.folders = vault.folders.map((f) => ({ accountKey: f.accountKey, id: f.id, name: f.name }));
    // default: the account that already has logins for this site, else the first one
    base.defaultAccount = items[0]?.accountKey ?? unlocked[0]?.key;
    return base;
  }

  // -------------------------------------------------------------------------------------------
  // RPCs of the notification bar

  async dataFor(token: string): Promise<NotificationData> {
    const p = await this.byToken(token);
    if (!p)
      return {
        kind: "none",
        locked: false,
        host: "",
        username: "",
        accounts: [],
        folders: [],
        targets: [],
        theme: this.svc.settings.theme,
      };
    return this.data(p);
  }

  async save(token: string, accountKey: string, folderId?: string): Promise<{ ok: boolean; error?: string }> {
    const p = await this.byToken(token);
    if (!p) return { ok: false, error: t("Die Anfrage ist abgelaufen") };
    if (!this.svc.isUnlocked(accountKey)) return { ok: false, error: t("Konto ist gesperrt") };
    let origin = p.url;
    try {
      origin = new URL(p.url).origin;
    } catch {
      /* keep */
    }
    const item = newLoginItem(accountKey, {
      name: itemName(p.host),
      username: p.username,
      password: p.password,
      uri: origin,
      folderId: folderId || null,
    });
    try {
      await this.svc.saveItem(accountKey, item, true);
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
    await this.drop(p);
    return { ok: true };
  }

  async update(token: string, targets: { accountKey: string; itemId: string }[]): Promise<{ ok: boolean; error?: string }> {
    const p = await this.byToken(token);
    if (!p) return { ok: false, error: t("Die Anfrage ist abgelaufen") };
    const d = await this.data(p);
    const allowed = d.targets.filter((tx) => targets.some((x) => x.accountKey === tx.accountKey && x.itemId === tx.itemId));
    if (!allowed.length) return { ok: false, error: t("Kein passender Eintrag") };
    for (const tx of allowed) {
      const it = await this.svc.findItem(tx.accountKey, tx.itemId);
      if (!it?.login) continue;
      const updated: ItemView = structuredClone(it);
      const old = it.login.password;
      updated.login!.password = p.password;
      updated.login!.passwordRevisionDate = new Date().toISOString();
      if (old)
        updated.passwordHistory = [{ password: old, lastUsedDate: new Date().toISOString() }, ...(it.passwordHistory ?? [])].slice(0, 5);
      try {
        await this.svc.saveItem(tx.accountKey, updated, false);
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    }
    await this.drop(p);
    return { ok: true };
  }

  async never(token: string) {
    const p = await this.byToken(token);
    if (!p) return;
    await addNeverDomain(p.host);
    await this.drop(p);
  }

  async close(token: string) {
    const p = await this.byToken(token);
    if (p) await this.drop(p);
  }
}
