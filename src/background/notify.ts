// "Login speichern?" / "Passwort aktualisieren?": captured form submissions → notification bar.
// Also observes whether a submitted login that equals a stored item worked (login outcome tracking) and,
// only for entries that conflict with another one, asks "Hat die Anmeldung geklappt?".
import { findDuplicates } from "../shared/duplicates";
import { newLoginItem } from "../shared/items";
import type { LoginCapture, NotificationData } from "../shared/messages";
import { baseDomain } from "../shared/uri";
import { CipherType, ItemView } from "../shared/types";
import { ATTEMPT_TTL, classifyOutcome, type Attempt, type PageState } from "./login-attempt";
import { itemRev, LoginOutcomes } from "./login-outcomes";
import { addNeverAskDomain, addNeverDomain, isNeverAskDomain, isNeverDomain } from "./never-domains";
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

/**
 * A login submission whose username + password equal stored items. Holds no password: only the items,
 * where it happened and the items' password revision at that moment.
 */
interface TrackedAttempt extends Attempt {
  id: string;
  tabId: number;
  items: { accountKey: string; itemId: string; rev: string }[];
  navigating?: boolean;
  /** token of the save/update prompt captured with the same submission */
  promptToken?: string;
  /** that prompt was shown: it wins over the question */
  prompted?: boolean;
  /** the question is shown with this token, about this item */
  token?: string;
  askedAt?: number;
  asked?: { accountKey: string; itemId: string };
}

type Hooks = {
  injectContentScript(tabId: number): Promise<void>;
  /** page state of the tab for classifyOutcome; null when it cannot be read */
  probe(tabId: number): Promise<PageState | null>;
};

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
  /** tabs whose attempt is being observed right now (load event and timer may overlap) */
  private observing = new Set<number>();

  constructor(
    private svc: VaultService,
    private hooks: Hooks,
    private outcomes: LoginOutcomes,
  ) {
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (info.status === "loading") this.markNavigating(tabId).catch(() => {});
      if (info.status === "complete") this.settled(tabId, true).catch(() => {});
    });
    chrome.tabs.onRemoved.addListener(async (tabId) => {
      const p = await session.get<Pending>("notify:" + tabId).catch(() => undefined);
      if (p) await this.drop(p).catch(() => {});
      const a = await session.get<TrackedAttempt>("attempt:" + tabId).catch(() => undefined);
      if (a) await this.dropAttempt(a).catch(() => {});
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

  private async getAttempt(tabId: number): Promise<TrackedAttempt | undefined> {
    const a = await session.get<TrackedAttempt>("attempt:" + tabId);
    if (!a) return undefined;
    // an unanswered question expires like a prompt; an unobserved attempt is too old to ask about
    const expired = a.token ? !(Date.now() - (a.askedAt ?? 0) <= TTL) : !(Date.now() - a.at <= ATTEMPT_TTL);
    if (expired) {
      await this.dropAttempt(a);
      return undefined;
    }
    return a;
  }

  private async putAttempt(a: TrackedAttempt) {
    await session.set("attempt:" + a.tabId, a);
    if (a.token) await session.set("attemptTok:" + a.token, a.tabId);
  }

  private async attemptByToken(token: string): Promise<TrackedAttempt | undefined> {
    if (typeof token !== "string" || !token) return undefined;
    const tabId = await session.get<number>("attemptTok:" + token);
    if (tabId == null) return undefined;
    const a = await this.getAttempt(tabId);
    return a?.token === token ? a : undefined;
  }

  private async dropAttempt(a: TrackedAttempt) {
    await session.remove(a.token ? ["attempt:" + a.tabId, "attemptTok:" + a.token] : "attempt:" + a.tabId);
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
    const prompts = s.promptSave || s.promptUpdate;
    if (!prompts && !s.trackLoginOutcome) return;
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
    // a new submission replaces the attempt of an earlier one on this tab
    const oldAttempt = await session.get<TrackedAttempt>("attempt:" + tabId);
    if (oldAttempt) await this.dropAttempt(oldAttempt);
    // change-password forms are no login attempts
    const attempt =
      s.trackLoginOutcome && !c.newPassword && c.password ? await this.newAttempt(tabId, url, host, username, c.password) : undefined;
    if (!prompts) {
      if (attempt) {
        await this.putAttempt(attempt);
        this.arm(tabId);
      }
      return;
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
    if (attempt) await this.putAttempt({ ...attempt, promptToken: p.token });
    this.arm(tabId);
  }

  /** SPA logins don't navigate: act after a moment unless a navigation started */
  private arm(tabId: number) {
    clearTimeout(this.timers.get(tabId));
    this.timers.set(
      tabId,
      setTimeout(() => this.settled(tabId, false).catch(() => {}), SHOW_DELAY),
    );
  }

  /** The items a submitted login equals: same username (trimmed, case-insensitive), same password (exact). */
  private async newAttempt(tabId: number, url: string, host: string, username: string, password: string): Promise<TrackedAttempt | undefined> {
    const user = username.trim().toLowerCase();
    const items = (await this.matching(url)).filter(
      (i) => (i.login?.username ?? "").trim().toLowerCase() === user && i.login?.password === password,
    );
    if (!items.length) return undefined;
    return {
      id: crypto.randomUUID(),
      tabId,
      url,
      host,
      site: baseDomain(url) ?? host,
      items: items.map((i) => ({ accountKey: i.accountKey, itemId: i.id, rev: itemRev(i) })),
      at: Date.now(),
      sawTotp: false,
    };
  }

  private async markNavigating(tabId: number) {
    const p = await this.get(tabId);
    if (p && !p.shown && !p.navigating) {
      p.navigating = true;
      await this.put(p);
    }
    const a = await this.getAttempt(tabId);
    if (a && !a.token && !a.navigating) await this.putAttempt({ ...a, navigating: true });
  }

  /** the page loaded (afterNavigation) or the SPA delay passed: the prompt first, then the outcome */
  private async settled(tabId: number, afterNavigation: boolean) {
    if (afterNavigation) clearTimeout(this.timers.get(tabId));
    await this.maybeShow(tabId, afterNavigation).catch(() => {});
    await this.observe(tabId, afterNavigation);
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
    const a = await this.getAttempt(tabId);
    if (a && a.promptToken === p.token) await this.putAttempt({ ...a, prompted: true });
    await this.showBar(tabId, p.token);
  }

  private async showBar(tabId: number, token: string) {
    const msg = { cmd: "showNotification", token };
    try {
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    } catch {
      await this.hooks.injectContentScript(tabId);
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------------------------
  // login outcome

  private async observe(tabId: number, afterNavigation: boolean) {
    if (this.observing.has(tabId)) return;
    this.observing.add(tabId);
    try {
      const a = await this.getAttempt(tabId);
      if (!a || a.token) return;
      if (!afterNavigation && a.navigating) return; // wait for the page load to complete
      if (!this.svc.settings.trackLoginOutcome) {
        await this.dropAttempt(a);
        return;
      }
      const state = await this.hooks.probe(tabId).catch(() => null);
      const outcome = classifyOutcome(a, state, Date.now());
      // a newer submission may have replaced the attempt while the page was probed
      if ((await this.getAttempt(tabId))?.id !== a.id) return;
      if (outcome === "pending") {
        await this.putAttempt({ ...a, sawTotp: true, navigating: false });
        return;
      }
      if (outcome !== "unknown") {
        await this.recordAttempt(a, outcome === "success");
        await this.dropAttempt(a);
        return;
      }
      const item = await this.questionFor(a);
      if (!item) {
        await this.dropAttempt(a);
        return;
      }
      const token = crypto.randomUUID();
      await this.putAttempt({ ...a, token, askedAt: Date.now(), asked: { accountKey: item.accountKey, itemId: item.id } });
      await this.showBar(tabId, token);
    } finally {
      this.observing.delete(tabId);
    }
  }

  /** current items of the attempt whose password is unchanged since the submission */
  private async attemptItems(a: TrackedAttempt): Promise<ItemView[]> {
    const out: ItemView[] = [];
    for (const x of a.items) {
      const item = await this.svc.findItem(x.accountKey, x.itemId);
      if (item?.login && !item.deletedDate && itemRev(item) === x.rev) out.push(item);
    }
    return out;
  }

  private async recordAttempt(a: TrackedAttempt, ok: boolean) {
    for (const item of await this.attemptItems(a)) await this.outcomes.record(item, ok);
  }

  /**
   * The item to ask about, or undefined. Only asked when the item conflicts with another matching login
   * (same site + username, different password), at most once per item and password revision, never when
   * the save/update prompt of the same submission was shown.
   */
  private async questionFor(a: TrackedAttempt): Promise<ItemView | undefined> {
    if (!this.svc.settings.askLoginOutcome || a.prompted) return undefined;
    if (await isNeverAskDomain(a.host)) return undefined;
    const items = await this.attemptItems(a);
    if (!items.length) return undefined;
    const groups = findDuplicates(await this.matching(a.url), "site");
    const same = (x: ItemView, y: ItemView) => x.accountKey === y.accountKey && x.id === y.id;
    for (const item of items) {
      const group = groups.find((g) => g.items.some((i) => same(i, item)));
      if (group?.samePassword !== false) continue;
      const known = await this.outcomes.forAccount(item.accountKey, [item]);
      if (!known[item.id]) return item;
    }
    return undefined;
  }

  private async confirmData(a: TrackedAttempt): Promise<NotificationData> {
    const item = a.asked && (await this.svc.findItem(a.asked.accountKey, a.asked.itemId));
    const acc = item && this.svc.publicAccounts().find((x) => x.key === item.accountKey && x.status === "unlocked");
    if (!item || !acc) return this.empty();
    return {
      ...this.empty(),
      kind: "confirmLogin",
      host: a.host,
      username: item.login?.username ?? "",
      confirmItem: { name: item.name, accountLabel: acc.label, accountColor: acc.color },
    };
  }

  /** answer of the question in the bar */
  async answer(token: string, answer: "yes" | "no" | "never"): Promise<{ ok: true }> {
    const a = await this.attemptByToken(token);
    if (!a) throw new Error(t("Die Anfrage ist abgelaufen"));
    if (answer === "never") await addNeverAskDomain(a.host);
    else if (answer === "yes" || answer === "no") await this.recordAttempt(a, answer === "yes");
    else throw new Error(t("Fehler"));
    await this.dropAttempt(a);
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------
  // decision

  private async matching(url: string): Promise<ItemView[]> {
    return (await this.svc.matchesForUrl(url)).filter((i) => i.type === CipherType.Login && i.login && !i.deletedDate);
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
    const items = await this.matching(p.url);
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

  private empty(): NotificationData {
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
  }

  async dataFor(token: string): Promise<NotificationData> {
    const p = await this.byToken(token);
    if (p) return this.data(p);
    const a = await this.attemptByToken(token);
    return a ? this.confirmData(a) : this.empty();
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
    const a = await this.attemptByToken(token);
    if (a) await this.dropAttempt(a);
  }
}
