// Service worker / background script entry point.
import { PhishingGuard } from "./phishing";
import { LiveSync } from "./live-sync";
import { EventType } from "../shared/events";
import type { RpcMessage, RpcName, Rpc } from "../shared/messages";
import { isBlockedUrl, isFillableUrl } from "../shared/uri";
import { CipherType, type OutcomeRecord } from "../shared/types";
import {
  activeTab,
  collectFrames,
  FILL_INSECURE,
  FILL_MISMATCH,
  fillItem,
  getMenuToken,
  injectContentScript,
  inlineMenuData,
  inlineMenuFill,
  inlineMenuFillGenerated,
  inlineMenuGenerate,
  inlineMenuTokenFor,
  pageLoadCandidate,
  updateBadge,
} from "./autofill";
import { BasicAuth } from "./basic-auth";
import { createAlias } from "./forwarders";
import { SecretStore } from "./secret-store";
import { Menus } from "./menus";
import { NotificationService } from "./notify";
import { LoginOutcomes } from "./login-outcomes";
import { Fido2Service } from "./fido2";
import { neverDomains, removeNeverDomain } from "./never-domains";
import { local, restrictSessionAccess } from "./store";
import { LoginFlows } from "./login-flow";
import { customEnvFor, setCustomEnv, urlsFor, VaultService } from "./vault-service";
import { receiveSend, receiveSendFile } from "./send-receive";
import { anonJson } from "./api";

import { initLanguage, t } from "../shared/i18n";
const VERSION = chrome.runtime.getManifest().version;
// context menu + shortcuts (created further below, once copyText / handlers exist)
let menus: Menus | undefined;
// language of notifications, menus and error messages created here (follows the settings)
initLanguage(() => menus?.rebuild().catch(() => {}));

function broadcast(event: "stateChanged" | "vaultChanged" | "sendsChanged" | "locked") {
  chrome.runtime.sendMessage({ event }).catch(() => {});
  if (event === "sendsChanged") return;
  if (event !== "vaultChanged") updateLiveSync();
  if (event !== "stateChanged") {
    updateBadge(svc).catch(() => {});
    menus?.rebuild().catch(() => {});
  }
}

const svc = new VaultService(broadcast);
// live sync: changes from other devices arrive right away (SignalR notifications hub)
const live = new LiveSync(svc, (key, n) => {
  svc
    .handleNotification(key, n)
    .then((r) => {
      if (r === "authRequest") checkAuthRequests().catch(() => {});
    })
    .catch((e) => console.warn("notification", e));
});
let liveTimer: ReturnType<typeof setTimeout> | undefined;
function updateLiveSync() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    liveTimer = undefined;
    svc.ready.then(() => live.update()).catch(() => {});
  }, 300);
}
updateLiveSync();
const secrets = new SecretStore(svc);
restrictSessionAccess();

// ---------------------------------------------------------------------------------------------
// Login window: flows that need a browser tab (SSO, Duo, security keys) continue in a small
// extension window, because the action popup closes as soon as another tab gets focus.

const POPUP_URL = chrome.runtime.getURL("popup.html");

async function findLoginWindow(): Promise<chrome.windows.Window | undefined> {
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  return wins.find((w) => w.tabs?.some((tx) => (tx.url ?? tx.pendingUrl ?? "").startsWith(POPUP_URL)));
}

const flows = new LoginFlows(svc, {
  async openLoginWindow() {
    if (await findLoginWindow()) return;
    await chrome.windows.create({ url: POPUP_URL + "?popout=1", type: "popup", width: 420, height: 680 });
  },
  async focusLoginWindow() {
    const w = await findLoginWindow();
    if (w?.id != null) await chrome.windows.update(w.id, { focused: true }).catch(() => {});
    else await chrome.windows.create({ url: POPUP_URL + "?popout=1", type: "popup", width: 420, height: 680 });
  },
  changed() {
    chrome.runtime.sendMessage({ event: "loginFlowChanged" }).catch(() => {});
  },
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) flows.onTabUpdated(tabId, info.url).catch((e) => console.warn("flow tab", e));
  if (info.url)
    phishing
      .check(tabId, info.url)
      .then((warn) => {
        if (warn) return chrome.tabs.update(tabId, { url: warn });
      })
      .catch((e) => console.warn("phishing", e));
});

// phishing warning: known phishing links (Bitwarden's list) open a warning page instead
const phishing = new PhishingGuard(() => !!svc.settings.phishingWarning);

const outcomes = new LoginOutcomes(local);
const notifications = new NotificationService(
  svc,
  {
    injectContentScript,
    // page state after a login submission: the top frame (frameId 0) and all other frames
    async probe(tabId) {
      try {
        const frames = await collectFrames(tabId);
        const tab = await chrome.tabs.get(tabId);
        return {
          url: tab.url ?? "",
          topFrame: frames.find((f) => f.frameId === 0)?.result ?? null,
          frames: frames.filter((f) => f.frameId !== 0 && f.result).map((f) => f.result!),
        };
      } catch {
        return null;
      }
    },
  },
  outcomes,
);

// passkeys (must be created synchronously so its onConnect listener exists when the worker wakes up)
const fido2 = new Fido2Service(svc, {
  async openPopup() {
    await handlers.openPopup({}, {} as any);
  },
  extraVaultOrigin: () => flows.activeWebVaultOrigin(),
});
chrome.tabs.onRemoved.addListener((tabId) => {
  flows.onTabRemoved(tabId).catch(() => {});
  phishing.tabClosed(tabId);
});

// ---------------------------------------------------------------------------------------------
// Clipboard (background contexts have no direct clipboard access in Chrome)

/** set by build.mjs: the Firefox build has no offscreen documents (its background page can use the clipboard) */
declare const __FIREFOX__: boolean;

async function copyText(text: string) {
  try {
    if (!__FIREFOX__ && (chrome as any).offscreen) {
      const has = await (chrome as any).offscreen.hasDocument?.();
      if (!has) {
        await (chrome as any).offscreen.createDocument({
          url: "offscreen.html",
          reasons: ["CLIPBOARD"],
          justification: t("Kopieren von TOTP-Codes in die Zwischenablage"),
        });
      }
      await chrome.runtime.sendMessage({ offscreen: "copy", text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    scheduleClipboardClear();
  } catch (e) {
    console.warn("copy failed", e);
  }
}

let clipTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleClipboardClear() {
  const s = svc.settings.clearClipboardSeconds;
  if (s <= 0) return;
  // alarms are clamped to >= 30 s, so use a timer for short delays and the alarm as fallback
  clearTimeout(clipTimer);
  clipTimer = setTimeout(() => clearClipboard(), s * 1000);
  chrome.alarms.create("clear-clipboard", { when: Date.now() + Math.max(s, 30) * 1000 });
}

async function clearClipboard() {
  try {
    if (!__FIREFOX__ && (chrome as any).offscreen) {
      const has = await (chrome as any).offscreen.hasDocument?.();
      if (has) await chrome.runtime.sendMessage({ offscreen: "copy", text: " " });
    } else await navigator.clipboard.writeText(" ");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// RPC

const CONTENT_ALLOWED = new Set<RpcName>(["inlineMenuToken", "notifyCapture", "pageLoadFill"]);

function isExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  const base = chrome.runtime.getURL("");
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(base);
}

type Handler = (args: any, sender: chrome.runtime.MessageSender) => Promise<any>;

/** After a password change the server ends all sessions: log in again with the new password. */
async function silentRelogin(accountKey: string, password: string): Promise<boolean> {
  const a = svc.accounts.find((x) => x.key === accountKey);
  if (!a) return false;
  try {
    const f = await flows.startPassword({
      server: a.server,
      baseUrl: a.server === "selfhosted" ? (a.urls.base ?? a.urls.webVault) : undefined,
      email: a.email,
      password,
    });
    if (f.step === "done") {
      await flows.ack();
      return true;
    }
  } catch {
    /* fall through */
  }
  await flows.cancel().catch(() => {});
  return false;
}

/** { ok, error } wrapper for actions whose errors the popup shows as a message */
async function result(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await svc.touch();
    await fn();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

const handlers: Record<string, Handler> = {
  async getState() {
    await svc.ready;
    return { accounts: svc.publicAccounts(), settings: svc.settings, version: VERSION };
  },
  // --- login flows ---
  loginGet: () => flows.current(),
  loginStart: (args) => flows.startPassword(args),
  loginSsoLookup: async (args) => ({ identifier: await flows.lookupSsoIdentifier(args) }),
  async loginSsoStart(args) {
    if (args.accountKey) {
      const a = svc.getAccount(args.accountKey);
      if (!a) throw new Error(t("Unbekanntes Konto"));
      return flows.startSso({
        server: a.server,
        baseUrl: a.server === "selfhosted" ? (a.urls.base ?? a.urls.webVault) : undefined,
        email: a.email,
        orgIdentifier: a.ssoOrgIdentifier ?? args.orgIdentifier ?? "",
        existingAccountKey: a.key,
      });
    }
    return flows.startSso(args);
  },
  loginTwoFactor: (args) => flows.submitTwoFactor(args),
  loginSendEmail: () => flows.sendEmailCode(),
  loginDuo: (args) => flows.startDuo(args),
  loginWebAuthn: (args) => flows.startWebAuthn(args),
  loginNewDevice: (args) => flows.submitNewDevice(args.otp),
  loginResendDevice: () => flows.resendNewDevice(),
  loginMasterPassword: (args) => flows.submitMasterPassword(args),
  loginTde: (args) => flows.tdeChoose(args),
  loginTdeCreate: (args) => flows.tdeCreateUser(args),
  loginPoll: () => flows.poll(),
  loginSetPassword: (args) => flows.setInitialPassword(args),
  loginKeyConnector: () => flows.confirmKeyConnector(),
  loginPasskey: (args) => flows.startPasskey({ server: args.server, baseUrl: args.baseUrl }),
  async loginCancel() {
    await flows.cancel();
    return { ok: true };
  },
  async loginAck() {
    await flows.ack();
    return { ok: true };
  },
  async unlock(args) {
    return { results: await svc.unlock(args.password, args.accountKeys) };
  },
  async unlockPin(args) {
    return svc.unlockWithPin(args.pin);
  },
  async biometricEnable(args) {
    await svc.enableBiometric(String(args.credentialId), String(args.salt), String(args.prf));
    return { ok: true };
  },
  async biometricDisable() {
    await svc.disableBiometric();
    return { ok: true };
  },
  async unlockBiometric(args) {
    return svc.unlockWithBiometric(String(args.prf));
  },
  async setPin(args) {
    await svc.setPin(args.pin, args.lockAfterRestart);
    return { ok: true };
  },
  async disablePin() {
    await svc.disablePin();
    return { ok: true };
  },
  async lock(args) {
    await svc.lock(args.accountKey);
    return { ok: true };
  },
  async logout(args) {
    await svc.logout(args.accountKey);
    return { ok: true };
  },
  async sync(args) {
    await svc.ready;
    if (args.accountKey) {
      try {
        await svc.sync(args.accountKey);
        return { ok: true, errors: {} };
      } catch (e: any) {
        return { ok: false, errors: { [args.accountKey]: e.message } };
      }
    }
    const errors = await svc.syncAll();
    return { ok: Object.keys(errors).length === 0, errors };
  },
  async getVault() {
    await svc.touch();
    return svc.getVault();
  },
  async getPageMatches(args) {
    await svc.ready;
    let url = args.url as string | undefined;
    if (!url) url = (await activeTab(args.tabId))?.url;
    if (!url || !isFillableUrl(url)) return { url: url ?? "", host: "", itemIds: [] };
    return svc.pageMatches(url);
  },
  async autofill(args) {
    await svc.ready;
    await svc.touch();
    const tab = await activeTab(args.tabId);
    if (!tab?.id) return { ok: false, error: t("Kein aktiver Tab") };
    const item = await svc.findItem(args.accountKey, args.itemId);
    if (!item) return { ok: false, error: t("Eintrag nicht gefunden") };
    const r = await fillItem(svc, tab.id, item, { force: !!args.force });
    if (r.ok && r.totp && svc.settings.autoCopyTotp) return { ok: true, totpCopied: r.totp };
    return { ok: r.ok, error: r.error, code: r.code };
  },
  async saveItem(args) {
    await svc.touch();
    try {
      const item = await svc.saveItem(args.accountKey, args.item, args.isNew);
      return { ok: true, item };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  async deleteItem(args) {
    try {
      await svc.deleteItem(args.accountKey, args.itemId, args.permanent);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  async restoreItem(args) {
    try {
      await svc.restoreItem(args.accountKey, args.itemId);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  async createFolder(args) {
    try {
      const id = await svc.createFolder(args.accountKey, args.name);
      return { ok: true, id };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  async register(args) {
    return flows.register(args);
  },
  // --- login requests of other devices ---
  loginDevice: (args) => flows.startDevice(args),
  async authRequests() {
    await svc.ready;
    const out = [];
    for (const a of svc.accounts) {
      if (!svc.isUnlocked(a.key)) continue;
      try {
        out.push(...(await svc.pendingAuthRequests(a.key)));
      } catch {
        /* server not reachable */
      }
    }
    return { requests: out };
  },
  async authRequestRespond(args) {
    await svc.touch();
    await svc.respondAuthRequest(args.accountKey, args.id, !!args.approve, typeof args.publicKey === "string" ? args.publicKey : undefined);
    seenAuthRequests.add(args.id);
    return { ok: true };
  },
  async fingerprint(args) {
    return { phrase: await svc.fingerprint(args.accountKey) };
  },
  async devices(args) {
    return { devices: await svc.devices(args.accountKey) };
  },
  deviceRemove: (args) => result(() => svc.removeDevice(args.accountKey, args.id)),
  // --- master password ---
  async masterPasswordPolicy(args) {
    return { policy: await svc.masterPasswordPolicy(args.accountKey) };
  },
  async changeMasterPassword(args) {
    await svc.touch();
    const next = String(args.next ?? "");
    const r = await svc.changeMasterPassword(args.accountKey, String(args.current ?? ""), next, String(args.hint ?? ""));
    if (r.relogin) {
      // new session with the new password; otherwise the user has to sign in again
      r.relogin = !(await silentRelogin(args.accountKey, next));
      if (r.relogin) await svc.passwordChangeLoggedOut(args.accountKey);
    }
    return r;
  },
  async updateTempPassword(args) {
    await svc.touch();
    const next = String(args.next ?? "");
    const r = await svc.updateTempPassword(args.accountKey, next, String(args.hint ?? ""));
    if (r.relogin) {
      // new session with the new password; otherwise the user has to sign in again
      r.relogin = !(await silentRelogin(args.accountKey, next));
      if (r.relogin) await svc.passwordChangeLoggedOut(args.accountKey);
    }
    return r;
  },
  async removeMasterPassword(args) {
    await svc.touch();
    await svc.removeMasterPassword(args.accountKey, String(args.password ?? ""));
    return { ok: true };
  },
  async leaveOrganization(args) {
    await svc.leaveOrganization(args.accountKey, String(args.orgId));
    return { ok: true };
  },
  async requestPasswordHint(args) {
    const urls = urlsFor(args.server, args.baseUrl);
    await anonJson(urls.api + "/accounts/password-hint", "POST", { email: String(args.email ?? "").trim() });
    return { ok: true };
  },
  // --- export / import ---
  async verifyMethods(args) {
    return svc.verificationMethods(args.accountKey);
  },
  async exportRequestOtp(args) {
    await svc.requestOtp(args.accountKey);
    return { ok: true };
  },
  async exportVault(args) {
    await svc.touch();
    const formats = ["json", "csv", "encrypted_json", "password_json"];
    if (!formats.includes(args.format)) throw new Error("format");
    const r = await svc.exportVault(
      args.accountKey,
      args.format,
      { mode: args.mode, secret: String(args.secret ?? "") },
      args.filePassword,
    );
    svc.events.collect(args.accountKey, EventType.UserClientExportedVault);
    return r;
  },
  async collectEvent(args) {
    const allowed: number[] = Object.values(EventType);
    if (!allowed.includes(args.type) || args.type === EventType.UserClientExportedVault) return { ok: true };
    const item = (await svc.ensureVault(args.accountKey))?.items.find((i) => i.id === args.itemId);
    if (item) await svc.events.collect(args.accountKey, args.type, item);
    return { ok: true };
  },
  async getCustomEnv(args) {
    await svc.ready;
    return { env: customEnvFor(String(args.baseUrl ?? "")) ?? {} };
  },
  async setCustomEnv(args) {
    await svc.ready;
    await setCustomEnv(String(args.baseUrl ?? ""), args.env ?? {});
    return { ok: true };
  },
  async phishingContinue(args, sender) {
    const tabId = sender.tab?.id;
    const url = String(args.url ?? "");
    if (tabId == null || !/^https?:/i.test(url)) return { ok: true };
    phishing.allow(tabId, url);
    await chrome.tabs.update(tabId, { url });
    return { ok: true };
  },
  async phishingLeave(_args, sender) {
    if (sender.tab?.id != null) await chrome.tabs.remove(sender.tab.id).catch(() => {});
    return { ok: true };
  },
  async changePasswordUrl(args) {
    return { url: await changePasswordUrl(String(args.uri ?? "")) };
  },
  async pendingEvents() {
    return { events: await svc.events.pending() };
  },
  async importDecrypt(args) {
    await svc.touch();
    return { doc: await svc.decryptImportFile(args.accountKey, args.doc, args.password) };
  },
  async importItems(args) {
    await svc.touch();
    if (!Array.isArray(args.items)) throw new Error("items");
    return svc.importItems(args.accountKey, args.items);
  },
  // --- generator history + forwarding services (encrypted secret store) ---
  async generatorHistory() {
    const d = await secrets.load();
    return { locked: !d, history: d?.history ?? [] };
  },
  async generatorHistoryAdd(args) {
    const kinds = ["password", "passphrase", "username", "email"];
    await secrets.addHistory({
      value: String(args.value ?? ""),
      kind: kinds.includes(args.kind) ? args.kind : "password",
      site: args.site ? String(args.site) : undefined,
    });
    return { ok: true };
  },
  async generatorHistoryClear() {
    await secrets.clearHistory();
    return { ok: true };
  },
  async forwarderSettings() {
    const d = await secrets.load();
    return { forwarders: d?.forwarders ?? {} };
  },
  async forwarderSave(args) {
    const s = args.settings ?? {};
    await secrets.setForwarder(args.id, {
      token: s.token ? String(s.token) : "",
      domain: s.domain ? String(s.domain) : "",
      baseUrl: s.baseUrl ? String(s.baseUrl) : "",
      prefix: s.prefix ? String(s.prefix) : "",
    });
    return { ok: true };
  },
  async forwarderGenerate(args) {
    const d = await secrets.load();
    if (!d) throw new Error(t("Tresor gesperrt"));
    const email = await createAlias(args.id, d.forwarders[args.id as keyof typeof d.forwarders] ?? {}, String(args.website ?? ""));
    await secrets.addHistory({ value: email, kind: "email", site: args.website || undefined });
    return { email };
  },
  async attachmentUploadStart(args) {
    await svc.touch();
    return { id: await svc.attachmentUploadStart(args.accountKey, args.itemId, String(args.fileName ?? ""), Number(args.size)) };
  },
  async attachmentUploadChunk(args) {
    svc.attachmentUploadChunk(args.id, args.data);
    return { ok: true };
  },
  attachmentUploadFinish: (args) => result(() => svc.attachmentUploadFinish(args.id)),
  async receiveSend(args) {
    try {
      return await receiveSend(
        { link: String(args.link ?? ""), password: args.password || undefined, email: args.email || undefined, otp: args.otp || undefined },
        svc.accounts,
      );
    } catch (e: any) {
      return { status: "error", error: e?.message ?? String(e) };
    }
  },
  receiveSendFile: (args) =>
    receiveSendFile(String(args.link ?? ""), String(args.sendId), String(args.fileId), args.auth ?? {}, svc.accounts),
  async listSends(args) {
    await svc.touch();
    return svc.listSends(args.accountKey);
  },
  async sendUploadStart(args) {
    await svc.touch();
    return { id: svc.sendUploadStart(args.accountKey, String(args.fileName ?? ""), Number(args.size)) };
  },
  async saveSend(args) {
    try {
      await svc.touch();
      return { ok: true, send: await svc.saveSend(args.accountKey, args.send) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  deleteSend: (args) => result(() => svc.deleteSend(args.accountKey, args.id)),
  async removeSendPassword(args) {
    try {
      await svc.touch();
      return { ok: true, send: await svc.removeSendPassword(args.accountKey, args.id) };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  attachmentDelete: (args) => result(() => svc.attachmentDelete(args.accountKey, args.itemId, args.attachmentId)),
  renameFolder: (args) => result(() => svc.renameFolder(args.accountKey, args.folderId, String(args.name ?? "").trim())),
  deleteFolder: (args) => result(() => svc.deleteFolder(args.accountKey, args.folderId)),
  archiveItem: (args) => result(() => svc.archiveItem(args.accountKey, args.itemId, !!args.archive)),
  async shareItem(args) {
    try {
      const item = await svc.shareItem(args.accountKey, args.item, args.organizationId, args.collectionIds ?? []);
      return { ok: true, item };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  setItemCollections: (args) => result(() => svc.setItemCollections(args.accountKey, args.itemId, args.collectionIds ?? [])),
  async copyItemToAccount(args) {
    try {
      await svc.touch();
      const r = await svc.copyItemToAccount(
        String(args.accountKey),
        String(args.itemId),
        String(args.targetAccountKey),
        args.folderId ? String(args.folderId) : null,
      );
      return { ok: true, ...r };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
  async attachmentDownload(args) {
    await svc.touch();
    return svc.attachmentDownload(args.accountKey, args.itemId, args.attachmentId);
  },
  async updateAccount(args) {
    await svc.updateAccount(args.accountKey, args);
    return { ok: true };
  },
  async moveAccount(args) {
    await svc.moveAccount(args.accountKey, args.direction);
    return { ok: true };
  },
  async setSettings(args) {
    if (args.pinLockAfterRestart !== undefined) {
      await svc.setPinLockAfterRestart(args.pinLockAfterRestart);
      delete args.pinLockAfterRestart;
    }
    delete args.pinEnabled;
    delete args.biometric;
    const s = await svc.setSettings(args);
    if ("vaultTimeout" in args) await svc.applyTimeoutSetting();
    if (args.phishingWarning === true) phishing.update(true).catch((e) => console.warn("phishing list", e));
    if (args.phishingWarning === false) await phishing.clear();
    setupAlarms();
    basicAuth.update();
    menus?.rebuild().catch(() => {});
    return s;
  },
  async verifyPassword(args) {
    await svc.ready;
    return { ok: await svc.verifyPassword(args.accountKey, args.password) };
  },
  async touch() {
    await svc.touch();
    return { ok: true };
  },
  async markUsed(args) {
    await svc.markUsed(args.accountKey, args.itemId);
    return { ok: true };
  },
  async copyText(args) {
    await copyText(args.text);
    return { ok: true };
  },
  async scheduleClipboardClear() {
    scheduleClipboardClear();
    return { ok: true };
  },
  async openPopup() {
    try {
      await (chrome.action as any).openPopup();
      return { ok: true };
    } catch {
      await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?popout=1"), type: "popup", width: 400, height: 640 });
      return { ok: true };
    }
  },
  // --- inline menu ---
  async inlineMenuToken(args, sender) {
    await svc.ready;
    return { token: await inlineMenuTokenFor(svc, sender, args, (tabId, frameId) => fido2.hasConditional(tabId, frameId)) };
  },
  async inlineMenuData(args) {
    await svc.ready;
    const data = await inlineMenuData(svc, args.token);
    const tk = getMenuToken(args.token);
    if (tk && !data.locked) data.passkeys = await fido2.conditionalPasskeys(tk.tabId, tk.frameId);
    return data;
  },
  async inlineMenuPasskey(args) {
    await svc.ready;
    await svc.touch();
    const tk = getMenuToken(args.token);
    if (!tk) return { ok: false };
    const ok = await fido2.conditionalPick(tk.tabId, tk.frameId, args.accountKey, args.itemId);
    if (ok) chrome.tabs.sendMessage(tk.tabId, { cmd: "closeInlineMenu" }, { frameId: tk.frameId }).catch(() => {});
    return { ok };
  },
  // --- passkey dialog ---
  async fido2Session(args) {
    return fido2.session(args.token);
  },
  async fido2Pick(args) {
    await svc.touch();
    return fido2.pick(args.token, args.accountKey, args.itemId, args.secret, args.mode);
  },
  async fido2Save(args) {
    await svc.touch();
    return fido2.save(args.token, args.accountKey, args.itemId, args.secret, args.mode);
  },
  async fido2Fallback(args) {
    fido2.fallback(args.token);
    return { ok: true };
  },
  async fido2Cancel(args) {
    fido2.cancel(args.token);
    return { ok: true };
  },
  async fido2Ping(args) {
    return { ok: fido2.ping(args.token) };
  },
  // --- cleanup assistant ---
  async usageEvidence() {
    const lastUsed = svc.lastUsedByAccount();
    const items = (await svc.getVault()).items;
    const result: Record<string, Record<string, OutcomeRecord>> = {};
    for (const accountKey of Object.keys(lastUsed)) {
      result[accountKey] = await outcomes.forAccount(
        accountKey,
        items.filter((i) => i.accountKey === accountKey),
      );
    }
    return { lastUsed, outcomes: result };
  },
  async clearLoginOutcomes() {
    await outcomes.clear();
    return { ok: true };
  },
  // --- save-login notification ---
  async notifyCapture(args, sender) {
    if (!sender.tab || sender.frameId == null) return { ok: true };
    if (isBlockedUrl(sender.url, svc.settings.blockedDomains)) return { ok: true };
    await notifications.capture(args, sender);
    return { ok: true };
  },
  async notifyData(args) {
    return notifications.dataFor(args.token);
  },
  async notifySave(args) {
    await svc.touch();
    return notifications.save(args.token, args.accountKey, args.folderId);
  },
  async notifyUpdate(args) {
    await svc.touch();
    return notifications.update(args.token, Array.isArray(args.targets) ? args.targets : []);
  },
  async notifyNever(args) {
    await notifications.never(args.token);
    return { ok: true };
  },
  async notifyClose(args) {
    await notifications.close(args.token);
    return { ok: true };
  },
  async notifyOutcome(args) {
    return notifications.answer(args.token, args.answer);
  },
  async neverDomains(args) {
    if (args.remove) await removeNeverDomain(args.remove);
    return { domains: await neverDomains() };
  },
  async inlineMenuFill(args) {
    await svc.ready;
    await svc.touch();
    const r = await inlineMenuFill(svc, args.token, args.accountKey, args.itemId);
    if (r.ok && r.totp && svc.settings.autoCopyTotp) await copyText(r.totp);
    return { ok: r.ok };
  },
  async inlineMenuGenerate(args) {
    return { password: await inlineMenuGenerate(args.token) };
  },
  async inlineMenuFillGenerated(args) {
    const tk = getMenuToken(args.token);
    const r = await inlineMenuFillGenerated(args.token);
    if (r.ok && r.password) generatedPassword(r.password, tk?.url);
    return { ok: r.ok };
  },
  async inlineMenuNew(args) {
    const tk = getMenuToken(args.token);
    if (!tk) return { ok: false };
    const type = tk.kind === "card" ? CipherType.Card : tk.kind === "identity" ? CipherType.Identity : CipherType.Login;
    await openAddItem(type, tk.url);
    chrome.tabs.sendMessage(tk.tabId, { cmd: "closeInlineMenu" }, { frameId: tk.frameId }).catch(() => {});
    return { ok: true };
  },
  // --- autofill on page load (asked by the content script when a login form is there) ---
  async pageLoadFill(_args, sender) {
    await svc.ready;
    const url = sender.url;
    if (!sender.tab?.id || sender.frameId == null || !url) return { ok: false };
    const item = await pageLoadCandidate(svc, url);
    if (!item) return { ok: false };
    const r = await fillItem(svc, sender.tab.id, item, { frameId: sender.frameId, pageLoad: true });
    return { ok: r.ok };
  },
};

chrome.runtime.onMessage.addListener((msg: RpcMessage | any, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || !("rpc" in msg)) return false;
  const name = msg.rpc as string;
  const h = handlers[name];
  if (!h) {
    sendResponse({ ok: false, error: "unknown rpc " + name });
    return false;
  }
  if (!isExtensionSender(sender) && !CONTENT_ALLOWED.has(name as any)) {
    sendResponse({ ok: false, error: "forbidden" });
    return false;
  }
  svc.ready
    .then(() => h(msg.args ?? {}, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true;
});

// ---------------------------------------------------------------------------------------------
// Context menu, keyboard shortcuts, HTTP authentication

async function openAddItem(type: CipherType, url?: string) {
  const q = new URLSearchParams({ popout: "1", add: String(type) });
  if (url && isFillableUrl(url)) q.set("uri", url);
  await chrome.windows.create({ url: POPUP_URL + "?" + q.toString(), type: "popup", width: 420, height: 680 });
}

/** a password was generated and used outside the popup → generator history */
function generatedPassword(password: string, url?: string) {
  let site: string | undefined;
  try {
    site = url ? new URL(url).hostname : undefined;
  } catch {
    /* ignore */
  }
  secrets.addHistory({ value: password, kind: "password", site }).catch(() => {});
}

menus = new Menus(svc, {
  copyText,
  openPopup: async () => {
    await handlers.openPopup({}, {} as any);
  },
  openAddItem,
  generated: generatedPassword,
});
const rebuildContextMenu = () => menus!.rebuild();

const basicAuth = new BasicAuth(svc);
svc.ready.then(() => basicAuth.update());

// ---------------------------------------------------------------------------------------------
// Tabs → badge + context menu

chrome.tabs.onActivated.addListener(() => {
  updateBadge(svc).catch(() => {});
  rebuildContextMenu().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.active) {
    menus?.resetCycle(tabId);
    updateBadge(svc, tab).catch(() => {});
    rebuildContextMenu().catch(() => {});
  }
});

/**
 * Where a website lets you change the password (like the official client): its
 * /.well-known/change-password if the site answers reliably with HTTP status codes, else its start page.
 */
async function changePasswordUrl(uri: string): Promise<string> {
  let origin: string;
  try {
    origin = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : "https://" + uri).origin;
  } catch {
    return uri;
  }
  if (!/^https?:/.test(origin)) return origin;
  const get = (path: string) =>
    fetch(origin + path, { credentials: "omit", cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(5000) });
  try {
    const bogus = await get("/.well-known/resource-that-should-not-exist-whose-status-code-should-not-be-200");
    if (bogus.ok) return origin;
    const r = await get("/.well-known/change-password");
    if (r.ok) return origin + "/.well-known/change-password";
  } catch {
    /* offline, CORS-free extension fetch failed → start page */
  }
  return origin;
}

// ---------------------------------------------------------------------------------------------
// Alarms: vault timeout, periodic sync, clipboard

function setupAlarms() {
  chrome.alarms.create("vault-timeout", { periodInMinutes: 1 });
  chrome.alarms.create("periodic-sync", { periodInMinutes: 30 });
  chrome.alarms.create("event-upload", { periodInMinutes: 1 });
  if (svc.settings.phishingWarning) chrome.alarms.create("phishing-update", { periodInMinutes: 360 });
  else chrome.alarms.clear("phishing-update").catch(() => {});
  if (svc.settings.approveLoginRequests) chrome.alarms.create("auth-requests", { periodInMinutes: 0.5 });
  else chrome.alarms.clear("auth-requests").catch(() => {});
}

// "login with device": show new requests of other devices in a popup window
const seenAuthRequests = new Set<string>();
async function checkAuthRequests() {
  await svc.ready;
  if (!svc.settings.approveLoginRequests || !svc.anyUnlocked()) return;
  const r = await handlers.authRequests({}, {} as any);
  const fresh = (r.requests as { id: string }[]).filter((x) => !seenAuthRequests.has(x.id));
  if (!fresh.length) return;
  fresh.forEach((x) => seenAuthRequests.add(x.id));
  const url = POPUP_URL + "?popout=1&route=authRequests";
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["popup"] });
  const open = wins.find((w) => w.tabs?.some((tx) => (tx.url ?? "").includes("route=authRequests")));
  if (open?.id != null) await chrome.windows.update(open.id, { focused: true });
  else await chrome.windows.create({ url, type: "popup", width: 420, height: 620 });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === "vault-timeout") await svc.checkTimeout();
  if (a.name === "periodic-sync") await svc.syncAll().catch(() => {});
  if (a.name === "clear-clipboard") await clearClipboard();
  if (a.name === "auth-requests") await checkAuthRequests().catch(() => {});
  if (a.name === "event-upload") await svc.events.upload().catch(() => {});
  if (a.name === "phishing-update") await phishing.update().catch((e) => console.warn("phishing list", e));
});

chrome.idle?.onStateChanged.addListener(async (state) => {
  await svc.ready;
  if (state === "locked" && svc.settings.lockOnSystemLock) await svc.timeoutAction();
});

// vault timeout "immediately": act as soon as the popup / popout is closed
let openPopups = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mw-popup") return;
  openPopups++;
  port.onDisconnect.addListener(async () => {
    openPopups = Math.max(0, openPopups - 1);
    await svc.ready;
    if (!openPopups && svc.settings.vaultTimeout === 0 && svc.anyUnlocked()) await svc.timeoutAction();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  setupAlarms();
  rebuildContextMenu().catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  setupAlarms();
  rebuildContextMenu().catch(() => {});
});

svc.ready.then(() => {
  setupAlarms();
});

// test hook, only in test builds (MW_TEST=1 node build.mjs)
declare const __TEST__: boolean;
if (__TEST__)
  (globalThis as any).__mwTest = {
    svc,
    menus,
    basicAuth,
    rebuildContextMenu,
    menuErrors: menus!.errors,
    checkAuthRequests,
    live,
    phishing,
  };
