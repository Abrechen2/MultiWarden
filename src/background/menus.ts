// Context menu and keyboard shortcuts (fill login / card / identity, copy, generate password).
import { EventType } from "../shared/events";
import { generateTotp } from "../crypto/totp";
import { generateWithSavedOptions } from "../shared/generator";
import { t } from "../shared/i18n";
import { CipherType, ItemView } from "../shared/types";
import { isFillableUrl } from "../shared/uri";
import { activeTab, fillItem, insecureFor } from "./autofill";
import { VaultService } from "./vault-service";

export interface MenuDeps {
  copyText(text: string): Promise<void>;
  openPopup(): Promise<void>;
  openAddItem(type: CipherType, url?: string): Promise<void>;
  /** a password was generated (generator history) */
  generated(password: string, url?: string): void;
}

const CONTEXTS: chrome.contextMenus.ContextType[] = ["editable", "page"];
const MAX_ITEMS = 25;

export class Menus {
  readonly errors: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private cycle = new Map<string, { order: string[]; idx: number; at: number }>();

  constructor(
    private svc: VaultService,
    private deps: MenuDeps,
  ) {
    chrome.contextMenus?.onClicked.addListener((info, tab) => {
      this.onClicked(info, tab).catch((e) => console.warn("context menu", e));
    });
    chrome.commands?.onCommand.addListener((cmd, tab) => {
      this.onCommand(cmd, tab).catch((e) => console.warn("command", e));
    });
  }

  /** Serialised rebuild: concurrent calls run one after another instead of interleaving. */
  rebuild(): Promise<void> {
    if (!chrome.contextMenus) return Promise.resolve();
    this.chain = this.chain.then(
      () => this.build(),
      () => this.build(),
    );
    this.chain = this.chain.catch(() => {});
    return this.chain;
  }

  resetCycle(tabId: number) {
    for (const k of this.cycle.keys()) if (k.endsWith(":" + tabId)) this.cycle.delete(k);
  }

  private mk(props: chrome.contextMenus.CreateProperties) {
    chrome.contextMenus.create({ contexts: CONTEXTS, ...props }, () => {
      const err = chrome.runtime.lastError;
      if (err) this.errors.push(String(err.message));
    });
  }

  private label(i: ItemView, sub?: string) {
    const multi = this.svc.accounts.length > 1;
    const acc = multi ? this.svc.accounts.find((a) => a.key === i.accountKey) : undefined;
    return [i.name + (sub ? ` (${sub})` : ""), acc ? acc.label || acc.email : ""].filter(Boolean).join(" — ");
  }

  private async build() {
    await chrome.contextMenus.removeAll();
    const s = this.svc.settings;
    if (!s.contextMenu) return;
    this.mk({ id: "mw-root", title: "MultiWarden" });
    if (!this.svc.anyUnlocked()) {
      this.mk({ id: "mw-unlock", parentId: "mw-root", title: t("Tresor entsperren …") });
      this.mk({ id: "mw-sep0", parentId: "mw-root", type: "separator" });
      this.mk({ id: "mw-gen", parentId: "mw-root", title: t("Passwort generieren (kopiert)") });
      return;
    }
    const tx = await activeTab();
    const url = tx?.url && isFillableUrl(tx.url) ? tx.url : undefined;
    const matches = url ? (await this.svc.matchesForUrl(url)).filter((i) => i.reprompt !== 1).slice(0, MAX_ITEMS) : [];

    const sub = (id: string, title: string, items: ItemView[], prefix: string, text: (i: ItemView) => string | undefined) => {
      this.mk({ id, parentId: "mw-root", title });
      if (!items.length) this.mk({ id: id + "-none", parentId: id, title: t("Keine passenden Logins"), enabled: false });
      for (const i of items) this.mk({ id: `${prefix}|${i.accountKey}|${i.id}`, parentId: id, title: this.label(i, text(i)) });
    };
    sub("mw-fill", t("Login ausfüllen"), matches, "mw-fill", (i) => i.login?.username);
    sub(
      "mw-cu",
      t("Benutzername kopieren"),
      matches.filter((i) => i.login?.username),
      "mw-cu",
      () => undefined,
    );
    sub(
      "mw-cp",
      t("Passwort kopieren"),
      matches.filter((i) => i.login?.password && i.viewPassword),
      "mw-cp",
      (i) => i.login?.username,
    );
    sub(
      "mw-ct",
      t("Bestätigungscode kopieren"),
      matches.filter((i) => i.login?.totp),
      "mw-ct",
      (i) => i.login?.username,
    );
    this.mk({ id: "mw-sep1", parentId: "mw-root", type: "separator" });

    const cards = (await this.svc.itemsOfType(CipherType.Card)).filter((i) => i.reprompt !== 1).slice(0, MAX_ITEMS);
    const ids = (await this.svc.itemsOfType(CipherType.Identity)).filter((i) => i.reprompt !== 1).slice(0, MAX_ITEMS);
    this.mk({ id: "mw-cards", parentId: "mw-root", title: t("Karte ausfüllen") });
    for (const c of cards) {
      const n = (c.card?.number ?? "").replace(/\s/g, "");
      this.mk({ id: `mw-fc|${c.accountKey}|${c.id}`, parentId: "mw-cards", title: this.label(c, n ? "*" + n.slice(-4) : undefined) });
    }
    if (cards.length) this.mk({ id: "mw-cards-sep", parentId: "mw-cards", type: "separator" });
    this.mk({ id: "mw-add-card", parentId: "mw-cards", title: t("Neue Karte hinzufügen") });
    this.mk({ id: "mw-ids", parentId: "mw-root", title: t("Identität ausfüllen") });
    for (const i of ids) {
      const name = [i.identity?.firstName, i.identity?.lastName].filter(Boolean).join(" ");
      this.mk({ id: `mw-fi|${i.accountKey}|${i.id}`, parentId: "mw-ids", title: this.label(i, name || undefined) });
    }
    if (ids.length) this.mk({ id: "mw-ids-sep", parentId: "mw-ids", type: "separator" });
    this.mk({ id: "mw-add-identity", parentId: "mw-ids", title: t("Neue Identität hinzufügen") });
    this.mk({ id: "mw-sep2", parentId: "mw-root", type: "separator" });
    this.mk({ id: "mw-gen", parentId: "mw-root", title: t("Passwort generieren (kopiert)") });
    this.mk({ id: "mw-add-login", parentId: "mw-root", title: t("Login hinzufügen …") });
    this.mk({ id: "mw-sep3", parentId: "mw-root", type: "separator" });
    this.mk({ id: "mw-lock", parentId: "mw-root", title: t("Alle Tresore sperren") });
  }

  private async onClicked(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
    const id = String(info.menuItemId);
    await this.svc.ready;
    if (id === "mw-unlock") return this.deps.openPopup();
    if (id === "mw-lock") return this.svc.lock();
    if (id === "mw-gen") return this.generate(tab, info.frameId, !!info.editable);
    if (id === "mw-add-login") return this.deps.openAddItem(CipherType.Login, tab?.url);
    if (id === "mw-add-card") return this.deps.openAddItem(CipherType.Card, tab?.url);
    if (id === "mw-add-identity") return this.deps.openAddItem(CipherType.Identity, tab?.url);
    // "<kind>|<accountKey>|<itemId>" – the account key itself contains "|"
    const first = id.indexOf("|");
    const last = id.lastIndexOf("|");
    if (first < 0 || last <= first) return;
    const kind = id.slice(0, first);
    const accountKey = id.slice(first + 1, last);
    const itemId = id.slice(last + 1);
    const item = await this.svc.findItem(accountKey, itemId);
    if (!item || item.reprompt === 1) return;
    await this.svc.touch();
    switch (kind) {
      case "mw-fill":
      case "mw-fc":
      case "mw-fi": {
        if (!tab?.id) return;
        const r = await fillItem(this.svc, tab.id, item, { frameId: info.frameId });
        if (r.ok && r.totp && this.svc.settings.autoCopyTotp) await this.deps.copyText(r.totp);
        return;
      }
      case "mw-cu":
        if (item.login?.username) await this.deps.copyText(item.login.username);
        return;
      case "mw-cp":
        if (item.login?.password && item.viewPassword) {
          await this.deps.copyText(item.login.password);
          await this.svc.markUsed(item.accountKey, item.id);
          this.svc.events.collect(item.accountKey, EventType.CipherClientCopiedPassword, item);
        }
        return;
      case "mw-ct": {
        const code = item.login?.totp ? (await generateTotp(item.login.totp))?.code : undefined;
        if (code) await this.deps.copyText(code);
        return;
      }
    }
  }

  /** Generate a password, copy it and put it into the focused password field. */
  async generate(tab: chrome.tabs.Tab | undefined, frameId: number | undefined, editable: boolean) {
    const pw = await generateWithSavedOptions();
    await this.deps.copyText(pw);
    this.deps.generated(pw, tab?.url);
    if (!tab?.id || !editable || !isFillableUrl(tab.url)) return;
    try {
      await chrome.scripting.executeScript({
        target: frameId != null ? { tabId: tab.id, frameIds: [frameId] } : { tabId: tab.id, allFrames: true },
        func: (p: string) => (globalThis as any).__mwFill?.({ kind: "generated", password: p }),
        args: [pw],
      });
    } catch {
      /* page not scriptable */
    }
  }

  // -------------------------------------------------------------------------------------------
  // keyboard shortcuts

  private async onCommand(cmd: string, tab?: chrome.tabs.Tab) {
    await this.svc.ready;
    if (cmd === "lock_all") return this.svc.lock();
    const tx = tab?.id ? tab : await activeTab();
    if (cmd === "generate_password") return this.generate(tx, undefined, true);
    if (!tx?.id || !isFillableUrl(tx.url)) return;
    if (!this.svc.anyUnlocked()) return this.deps.openPopup();
    let items: ItemView[];
    if (cmd === "autofill_login") items = (await this.svc.matchesForUrl(tx.url!)).filter((i) => !insecureFor(i, tx.url!));
    else if (cmd === "autofill_card") items = await this.svc.itemsOfType(CipherType.Card);
    else if (cmd === "autofill_identity") items = await this.svc.itemsOfType(CipherType.Identity);
    else return;
    // items protected by master password re-prompt need the popup
    const usable = items.filter((i) => i.reprompt !== 1);
    if (!usable.length) {
      if (items.length) await this.deps.openPopup();
      return;
    }
    // repeated presses cycle through the items (most recently used first, order kept while cycling)
    const key = cmd + ":" + tx.id;
    const keys = usable.map((i) => i.accountKey + "|" + i.id);
    let c = this.cycle.get(key);
    const same = c && c.order.length === keys.length && keys.every((k) => c!.order.includes(k)) && Date.now() - c.at < 60_000;
    if (!c || !same) c = { order: keys, idx: -1, at: 0 };
    c.idx = (c.idx + 1) % c.order.length;
    c.at = Date.now();
    this.cycle.set(key, c);
    const item = usable[keys.indexOf(c.order[c.idx])];
    await this.svc.touch();
    const r = await fillItem(this.svc, tx.id, item);
    if (r.ok && r.totp && this.svc.settings.autoCopyTotp) await this.deps.copyText(r.totp);
  }

  /** test hook */
  command(cmd: string, tab?: chrome.tabs.Tab) {
    return this.onCommand(cmd, tab);
  }

  /** test hook */
  click(menuItemId: string, tab?: chrome.tabs.Tab, extra: Partial<chrome.contextMenus.OnClickData> = {}) {
    return this.onClicked({ menuItemId, editable: false, pageUrl: tab?.url ?? "", ...extra } as any, tab);
  }
}
