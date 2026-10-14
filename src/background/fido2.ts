// Passkey authenticator: answers navigator.credentials.create/get of websites with passkeys
// stored in the vaults of all unlocked accounts (Bitwarden-compatible storage format).
import {
  attestationObject,
  buildAuthData,
  bytesToB64url,
  b64urlToBytes,
  clientDataJSON,
  createKeyPair,
  guidToBytes,
  isValidRpId,
  parseCredentialId,
  sameBytes,
  sha256,
  signWithPkcs8,
} from "../crypto/fido2";
import { concat } from "../crypto/utils";
import { newLoginItem } from "../shared/items";
import type { Fido2AccountView, Fido2CandidateView, Fido2SessionData, Fido2Verify, InlineMenuPasskey } from "../shared/messages";
import { CipherType, ItemView } from "../shared/types";
import { isBlockedUrl } from "../shared/uri";
import { isNeverDomain } from "./never-domains";
import { initialsOf, VaultService } from "./vault-service";

import { t } from "../shared/i18n";
export const FIDO2_PORT = "mw-fido2";

type Reply = { type: "result"; result: any } | { type: "fallback" } | { type: "error"; name: string; message: string };

const NOT_ALLOWED: Reply = { type: "error", name: "NotAllowedError", message: "The operation either timed out or was not allowed." };
const FALLBACK: Reply = { type: "fallback" };
const MAX_LIFETIME = 10 * 60_000;

interface Fido2Request {
  token: string;
  kind: "create" | "get";
  port: chrome.runtime.Port;
  tabId: number;
  frameId: number;
  windowId: number;
  origin: string;
  rpId: string;
  /** normalised base64url challenge */
  challenge: string;
  options: any;
  /** UV "required" */
  uvRequired: boolean;
  /** UV "required", "preferred" or not given (Bitwarden asks for verification in all these cases) */
  uvWanted: boolean;
  conditional: boolean;
  fallbackSupported: boolean;
  excluded: boolean;
  dialogWindowId?: number;
  /** accounts that were locked when the request started; unlocking them in the dialog counts as verification */
  lockedAtStart: Set<string>;
  verified: Set<string>;
  /** conditional request: passkey picked in the inline menu, waiting for verification in the dialog */
  forced?: { accountKey: string; itemId: string };
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

function errorReply(name: string, message: string): Reply {
  return { type: "error", name, message };
}

function normB64url(s: string): string {
  return bytesToB64url(b64urlToBytes(String(s ?? "")));
}

export class Fido2Service {
  private reqs = new Map<string, Fido2Request>();

  constructor(
    private svc: VaultService,
    private hooks: { openPopup(): Promise<void>; extraVaultOrigin?(): Promise<string | undefined> },
  ) {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === FIDO2_PORT) this.onPort(port);
    });
    chrome.windows.onRemoved.addListener((id) => {
      for (const r of this.reqs.values()) {
        if (r.dialogWindowId !== id || r.finished) continue;
        r.dialogWindowId = undefined;
        // a conditional request survives a closed verification dialog
        if (r.conditional) r.forced = undefined;
        else this.finish(r, NOT_ALLOWED);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // transport

  private onPort(port: chrome.runtime.Port) {
    let req: Fido2Request | undefined;
    let aborted = false;
    port.onMessage.addListener(async (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "request" && !req) {
        try {
          const r = await this.start(port, msg);
          if (typeof r === "object" && "type" in r) {
            safePost(port, r);
            port.disconnect();
            return;
          }
          req = r;
          if (aborted) this.finish(req, errorReply("AbortError", "The operation was aborted."));
        } catch (e: any) {
          console.warn("fido2", e);
          safePost(port, errorReply("NotAllowedError", "The operation either timed out or was not allowed."));
          port.disconnect();
        }
      } else if (msg.type === "abort") {
        aborted = true;
        if (req) this.finish(req, errorReply("AbortError", "The operation was aborted."));
      }
    });
    port.onDisconnect.addListener(() => {
      aborted = true;
      if (req && !req.finished) {
        req.finished = true;
        this.cleanup(req);
      }
    });
  }

  private finish(r: Fido2Request, reply: Reply) {
    if (r.finished) return;
    r.finished = true;
    safePost(r.port, reply);
    try {
      r.port.disconnect();
    } catch {
      /* already gone */
    }
    this.cleanup(r);
  }

  private cleanup(r: Fido2Request) {
    clearTimeout(r.timer);
    this.reqs.delete(r.token);
    if (r.dialogWindowId != null) {
      const id = r.dialogWindowId;
      r.dialogWindowId = undefined;
      chrome.windows.remove(id).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------------------------
  // request handling

  private async start(port: chrome.runtime.Port, msg: any): Promise<Fido2Request | Reply> {
    await this.svc.ready;
    const tab = port.sender?.tab;
    const frameId = port.sender?.frameId ?? 0;
    const url = port.sender?.url;
    // only top-level documents; frames are left to the browser
    if (!tab?.id || frameId !== 0 || !url) return FALLBACK;
    const u = new URL(url);
    const origin = u.origin;
    const host = u.hostname.toLowerCase();
    if (!this.svc.settings.passkeys || !this.svc.accounts.length) return FALLBACK;
    if (u.protocol !== "https:" && !(u.protocol === "http:" && host === "localhost")) return FALLBACK;
    if (this.svc.vaultOrigins().has(origin) || (await this.hooks.extraVaultOrigin?.()) === origin) return FALLBACK;
    if (await isNeverDomain(host)) return FALLBACK;
    if (isBlockedUrl(url, this.svc.settings.blockedDomains)) return FALLBACK;
    const o = msg.options ?? {};
    const kind: "create" | "get" = msg.kind === "create" ? "create" : "get";
    const fallbackSupported = msg.fallbackSupported !== false;

    let rpId: string;
    let uvPref: string | undefined;
    if (kind === "create") {
      rpId = String(o.rp?.id ?? host).toLowerCase();
      uvPref = o.authenticatorSelection?.userVerification;
      if (!isValidRpId(rpId, origin)) return errorReply("SecurityError", "'rp.id' cannot be used with the current origin");
      const uid = b64urlToBytes(String(o.user?.id ?? ""));
      if (uid.length < 1 || uid.length > 64) return errorReply("TypeError", "Invalid 'user.id' length");
      const params: any[] = Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams : [];
      if (params.length && !params.some((p) => p?.type === "public-key" && Number(p.alg) === -7)) return FALLBACK;
      if (o.authenticatorSelection?.authenticatorAttachment === "cross-platform") return FALLBACK;
    } else {
      rpId = String(o.rpId ?? host).toLowerCase();
      uvPref = o.userVerification;
      if (!isValidRpId(rpId, origin)) return errorReply("SecurityError", "'rpId' cannot be used with the current origin");
      const allow: any[] = Array.isArray(o.allowCredentials) ? o.allowCredentials : [];
      // only hardware keys / other devices allowed → browser
      if (allow.length && allow.every((c) => Array.isArray(c?.transports) && c.transports.length && !c.transports.includes("internal")))
        return FALLBACK;
    }

    const r: Fido2Request = {
      token: crypto.randomUUID(),
      kind,
      port,
      tabId: tab.id,
      frameId,
      windowId: tab.windowId,
      origin,
      rpId,
      challenge: normB64url(o.challenge),
      options: o,
      uvRequired: uvPref === "required",
      uvWanted: uvPref !== "discouraged",
      conditional: kind === "get" && o.mediation === "conditional",
      fallbackSupported,
      excluded: false,
      lockedAtStart: new Set(this.svc.accounts.filter((a) => !this.svc.isUnlocked(a.key) && !a.needsLogin).map((a) => a.key)),
      verified: new Set(),
      finished: false,
    };

    if (kind === "get") {
      const candidates = await this.candidates(r);
      if (r.conditional) {
        if (!candidates.length) return FALLBACK;
        this.reqs.set(r.token, r);
        return r;
      }
      if (!candidates.length) {
        // nothing in the unlocked vaults; only ask when everything is locked
        if (this.svc.anyUnlocked() || !r.lockedAtStart.size) return FALLBACK;
      }
    } else {
      r.excluded = await this.isExcluded(r);
      const unlocked = this.svc.accounts.filter((a) => this.svc.isUnlocked(a.key));
      if (!unlocked.length && !r.lockedAtStart.size) return FALLBACK;
    }
    this.reqs.set(r.token, r);
    r.timer = setTimeout(() => this.finish(r, NOT_ALLOWED), MAX_LIFETIME);
    await this.openDialog(r);
    return r;
  }

  private async openDialog(r: Fido2Request) {
    const width = 440;
    const height = 600;
    let left: number | undefined;
    let top: number | undefined;
    try {
      const w = await chrome.windows.get(r.windowId);
      if (w.left != null && w.width != null) left = Math.round(w.left + (w.width - width) / 2);
      if (w.top != null) top = w.top + 70;
    } catch {
      /* default position */
    }
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("fido2.html") + "#" + r.token,
      type: "popup",
      width,
      height,
      left,
      top,
      focused: true,
    });
    r.dialogWindowId = win?.id;
  }

  // -------------------------------------------------------------------------------------------
  // vault lookups

  private async loginItems(): Promise<ItemView[]> {
    const v = await this.svc.getVault();
    return v.items.filter((i) => i.type === CipherType.Login && !i.deletedDate && i.login);
  }

  private async candidates(r: Fido2Request): Promise<ItemView[]> {
    const allow: Uint8Array[] = (Array.isArray(r.options.allowCredentials) ? r.options.allowCredentials : [])
      .map((c: any) => {
        try {
          return b64urlToBytes(String(c.id));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return (await this.loginItems()).filter((i) => {
      const m = i.login?.fido2?.[0];
      if (!m || m.rpId !== r.rpId) return false;
      if (!allow.length) return m.discoverable;
      const id = parseCredentialId(m.credentialId);
      return !!id && allow.some((a) => sameBytes(a, id));
    });
  }

  private async isExcluded(r: Fido2Request): Promise<boolean> {
    const ex: any[] = Array.isArray(r.options.excludeCredentials) ? r.options.excludeCredentials : [];
    if (!ex.length) return false;
    const ids = ex.map((c) => {
      try {
        return b64urlToBytes(String(c.id));
      } catch {
        return new Uint8Array();
      }
    });
    return (await this.loginItems()).some((i) =>
      (i.login?.fido2 ?? []).some((m) => {
        if (m.rpId !== r.rpId) return false;
        const id = parseCredentialId(m.credentialId);
        return !!id && ids.some((x) => sameBytes(x, id));
      }),
    );
  }

  /** Verification the user has to provide for an account / item. */
  private verifyFor(r: Fido2Request, accountKey: string, reprompt: boolean): Fido2Verify {
    const m = this.svc.verificationMethods(accountKey);
    if (reprompt) {
      // master password re-prompt (PIN for accounts without master password)
      if (m.mp) return { modes: ["mp"] };
      if (m.pin) return { modes: ["pin"] };
      return { modes: [] };
    }
    if (r.verified.has(accountKey) || !r.uvWanted) return { modes: [] };
    const modes: ("mp" | "pin")[] = [];
    if (m.mp) modes.push("mp");
    if (m.pin) modes.push("pin");
    if (!modes.length && r.uvRequired) return { modes: [], missing: true };
    return { modes };
  }

  private refreshVerified(r: Fido2Request) {
    for (const k of r.lockedAtStart) if (this.svc.isUnlocked(k)) r.verified.add(k);
  }

  private accountViews(): Fido2AccountView[] {
    return this.svc
      .publicAccounts()
      .filter((a) => a.status !== "loggedOut")
      .map((a) => ({
        key: a.key,
        label: a.label,
        color: a.color,
        initials: a.initials,
        serverLabel: a.serverLabel,
        unlocked: a.status === "unlocked",
        hasMasterPassword: a.hasMasterPassword,
        pinUnlock: a.pinUnlock,
        bioUnlock: a.bioUnlock,
      }));
  }

  private candidateView(r: Fido2Request, i: ItemView): Fido2CandidateView {
    const acc = this.svc.getAccount(i.accountKey)!;
    const m = i.login!.fido2![0];
    return {
      accountKey: i.accountKey,
      itemId: i.id,
      name: i.name,
      userName: m.userName || m.userDisplayName || i.login?.username || "",
      rpId: m.rpId,
      accountLabel: acc.label || acc.email,
      accountColor: acc.color,
      accountInitials: initialsOf(acc),
      verify: this.verifyFor(r, i.accountKey, i.reprompt === 1),
    };
  }

  // -------------------------------------------------------------------------------------------
  // dialog RPCs

  async session(token: string): Promise<Fido2SessionData> {
    const r = this.reqs.get(token);
    const theme = this.svc.settings.theme;
    const base: Fido2SessionData = {
      kind: "gone",
      rpId: "",
      origin: "",
      candidates: [],
      fallbackSupported: false,
      accounts: this.accountViews(),
      existingLogins: [],
      newItemVerify: {},
      theme,
      pinEnabled: this.svc.settings.pinEnabled,
    };
    if (!r || r.finished) return base;
    this.refreshVerified(r);
    base.kind = r.kind === "create" && r.excluded ? "excluded" : r.kind;
    base.rpId = r.rpId;
    base.origin = r.origin;
    base.fallbackSupported = r.fallbackSupported;
    if (r.kind === "get") {
      let items = await this.candidates(r);
      if (r.forced) items = items.filter((i) => i.accountKey === r.forced!.accountKey && i.id === r.forced!.itemId);
      base.candidates = items.map((i) => this.candidateView(r, i));
    } else {
      base.rpName = r.options.rp?.name;
      base.userName = r.options.user?.name || r.options.user?.displayName;
      if (!r.excluded) {
        r.excluded = await this.isExcluded(r); // vault may have been unlocked meanwhile
        if (r.excluded) base.kind = "excluded";
      }
      const matches = (await this.svc.matchesForUrl(r.origin + "/")).filter((i) => i.edit);
      base.existingLogins = matches.map((i) => ({
        accountKey: i.accountKey,
        itemId: i.id,
        name: i.name,
        userName: i.login?.username ?? "",
        hasPasskey: (i.login?.passkeys ?? 0) > 0,
        verify: this.verifyFor(r, i.accountKey, i.reprompt === 1),
      }));
      for (const a of base.accounts) if (a.unlocked) base.newItemVerify[a.key] = this.verifyFor(r, a.key, false);
    }
    return base;
  }

  ping(token: string): boolean {
    const r = this.reqs.get(token);
    return !!r && !r.finished;
  }

  fallback(token: string) {
    const r = this.reqs.get(token);
    if (r) this.finish(r, r.fallbackSupported ? FALLBACK : NOT_ALLOWED);
  }

  cancel(token: string) {
    const r = this.reqs.get(token);
    if (!r) return;
    if (r.conditional) {
      // closing the verification dialog keeps the page's conditional request alive
      r.forced = undefined;
      if (r.dialogWindowId != null) chrome.windows.remove(r.dialogWindowId).catch(() => {});
      r.dialogWindowId = undefined;
      return;
    }
    this.finish(
      r,
      r.excluded
        ? errorReply(
            "InvalidStateError",
            "The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.",
          )
        : NOT_ALLOWED,
    );
  }

  /** Checks the secret if one is needed; returns whether the user is verified (UV flag). */
  private async verify(r: Fido2Request, accountKey: string, v: Fido2Verify, secret?: string, mode?: "mp" | "pin"): Promise<boolean> {
    if (v.missing) throw new Error(t("Für dieses Konto ist eine Bestätigung nötig. Bitte richte in den Einstellungen eine PIN ein."));
    if (!v.modes.length) return r.verified.has(accountKey);
    const m = mode && v.modes.includes(mode) ? mode : v.modes[0];
    if (!secret) throw new Error(m === "pin" ? t("Bitte PIN eingeben") : t("Bitte Master-Passwort eingeben"));
    if (!(await this.svc.verifyUser(accountKey, secret, m))) throw new Error(m === "pin" ? "Falsche PIN" : t("Falsches Master-Passwort"));
    r.verified.add(accountKey);
    return true;
  }

  async pick(
    token: string,
    accountKey: string,
    itemId: string,
    secret?: string,
    mode?: "mp" | "pin",
  ): Promise<{ ok: boolean; error?: string }> {
    const r = this.reqs.get(token);
    if (!r || r.finished || r.kind !== "get") return { ok: false, error: t("Die Anfrage ist nicht mehr aktiv") };
    this.refreshVerified(r);
    const item = (await this.candidates(r)).find((i) => i.accountKey === accountKey && i.id === itemId);
    if (!item) return { ok: false, error: t("Passkey nicht gefunden") };
    let uv: boolean;
    try {
      uv = await this.verify(r, accountKey, this.verifyFor(r, accountKey, item.reprompt === 1), secret, mode);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
    if (r.uvRequired && !uv) return { ok: false, error: t("Bitte bestätige deine Identität") };
    try {
      const result = await this.assert(r, item, uv);
      this.finish(r, { type: "result", result });
      return { ok: true };
    } catch (e: any) {
      console.warn("fido2 assert", e);
      return { ok: false, error: t("Anmeldung mit dem Passkey fehlgeschlagen: ") + (e?.message ?? e) };
    }
  }

  async save(
    token: string,
    accountKey: string,
    itemId?: string,
    secret?: string,
    mode?: "mp" | "pin",
  ): Promise<{ ok: boolean; error?: string }> {
    const r = this.reqs.get(token);
    if (!r || r.finished || r.kind !== "create") return { ok: false, error: t("Die Anfrage ist nicht mehr aktiv") };
    if (r.excluded) return { ok: false, error: t("Für diese Website ist bereits ein Passkey gespeichert") };
    if (!this.svc.isUnlocked(accountKey)) return { ok: false, error: t("Konto ist gesperrt") };
    this.refreshVerified(r);
    let target: ItemView | undefined;
    if (itemId) {
      target = await this.svc.findItem(accountKey, itemId);
      if (!target || target.type !== CipherType.Login || !target.edit) return { ok: false, error: t("Eintrag nicht gefunden") };
    }
    let uv: boolean;
    try {
      uv = await this.verify(r, accountKey, this.verifyFor(r, accountKey, target?.reprompt === 1), secret, mode);
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
    if (r.uvRequired && !uv) return { ok: false, error: t("Bitte bestätige deine Identität") };
    try {
      const result = await this.create(r, accountKey, target, uv);
      this.finish(r, { type: "result", result });
      return { ok: true };
    } catch (e: any) {
      console.warn("fido2 create", e);
      return { ok: false, error: t("Passkey konnte nicht gespeichert werden: ") + (e?.message ?? e) };
    }
  }

  // -------------------------------------------------------------------------------------------
  // conditional mediation (passkeys in the inline menu)

  private conditionalFor(tabId: number, frameId: number): Fido2Request | undefined {
    for (const r of this.reqs.values()) if (r.conditional && !r.finished && r.tabId === tabId && r.frameId === frameId) return r;
    return undefined;
  }

  hasConditional(tabId: number, frameId: number): boolean {
    return !!this.conditionalFor(tabId, frameId);
  }

  async conditionalPasskeys(tabId: number, frameId: number): Promise<InlineMenuPasskey[]> {
    const r = this.conditionalFor(tabId, frameId);
    if (!r) return [];
    return (await this.candidates(r)).map((i) => {
      const v = this.candidateView(r, i);
      return {
        accountKey: v.accountKey,
        itemId: v.itemId,
        name: v.name,
        userName: v.userName,
        accountLabel: v.accountLabel,
        accountColor: v.accountColor,
        accountInitials: v.accountInitials,
      };
    });
  }

  async conditionalPick(tabId: number, frameId: number, accountKey: string, itemId: string): Promise<boolean> {
    const r = this.conditionalFor(tabId, frameId);
    if (!r) return false;
    const item = (await this.candidates(r)).find((i) => i.accountKey === accountKey && i.id === itemId);
    if (!item) return false;
    const v = this.verifyFor(r, accountKey, item.reprompt === 1);
    if (v.modes.length || v.missing) {
      // needs master password / PIN → small dialog for just this passkey
      r.forced = { accountKey, itemId };
      if (r.dialogWindowId == null) await this.openDialog(r);
      else chrome.windows.update(r.dialogWindowId, { focused: true }).catch(() => {});
      return true;
    }
    if (r.uvRequired) return false;
    const result = await this.assert(r, item, false);
    this.finish(r, { type: "result", result });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // authenticator operations

  private async assert(r: Fido2Request, item: ItemView, uv: boolean) {
    const meta = item.login!.fido2![0];
    const credId = parseCredentialId(meta.credentialId);
    if (!credId) throw new Error(t("ungültige Credential-ID"));
    const secret = await this.svc.passkeySecret(item.accountKey, item.id);
    let counter = secret.counter;
    if (counter > 0) counter++;
    const authData = await buildAuthData({ rpId: meta.rpId, counter, userPresence: true, userVerification: uv });
    const cdj = clientDataJSON("webauthn.get", r.challenge, r.origin, false);
    const signature = await signWithPkcs8(secret.pkcs8, concat(authData, await sha256(cdj)));
    secret.pkcs8.fill(0);
    if (counter > 0)
      await this.svc.updatePasskeyCounter(item.accountKey, item.id, counter).catch((e) => console.warn("passkey counter", e));
    this.svc.markUsed(item.accountKey, item.id).catch(() => {});
    return {
      id: bytesToB64url(credId),
      clientDataJSON: bytesToB64url(cdj),
      authenticatorData: bytesToB64url(authData),
      signature: bytesToB64url(signature),
      userHandle: meta.userHandle ? normB64url(meta.userHandle) : null,
    };
  }

  private async create(r: Fido2Request, accountKey: string, target: ItemView | undefined, uv: boolean) {
    const o = r.options;
    const sel = o.authenticatorSelection ?? {};
    const discoverable =
      sel.residentKey === "required" ||
      sel.residentKey === "preferred" ||
      (sel.residentKey === undefined && (sel.requireResidentKey === true || sel.requireResidentKey === "true"));
    const kp = await createKeyPair();
    const guid = crypto.randomUUID();
    const credId = guidToBytes(guid);
    const plain = {
      credentialId: guid,
      keyValue: bytesToB64url(kp.pkcs8),
      rpId: r.rpId,
      rpName: o.rp?.name ? String(o.rp.name) : undefined,
      userHandle: normB64url(o.user?.id),
      userName: o.user?.name ? String(o.user.name) : undefined,
      userDisplayName: o.user?.displayName ? String(o.user.displayName) : undefined,
      counter: 0,
      discoverable,
      creationDate: new Date().toISOString(),
    };
    if (target) {
      await this.svc.saveItem(accountKey, target, false, { newPasskey: plain });
    } else {
      const item = newLoginItem(accountKey, {
        name: plain.rpName || r.rpId,
        username: plain.userName ?? "",
        uri: r.origin,
      });
      await this.svc.saveItem(accountKey, item, true, { newPasskey: plain });
    }
    kp.pkcs8.fill(0);
    const authData = await buildAuthData({
      rpId: r.rpId,
      counter: 0,
      userPresence: true,
      userVerification: uv,
      attested: { credentialId: credId, x: kp.x, y: kp.y },
    });
    const cdj = clientDataJSON("webauthn.create", r.challenge, r.origin, false);
    return {
      id: bytesToB64url(credId),
      clientDataJSON: bytesToB64url(cdj),
      attestationObject: bytesToB64url(attestationObject(authData)),
      authenticatorData: bytesToB64url(authData),
      publicKey: bytesToB64url(kp.spki),
      publicKeyAlgorithm: -7,
      transports: ["internal", "hybrid"],
      credProps: o.extensions?.credProps ? { rk: discoverable } : undefined,
    };
  }

  /** Opens the popup to unlock accounts (from the passkey dialog). */
  async requestUnlock() {
    await this.hooks.openPopup();
  }
}

function safePost(port: chrome.runtime.Port, msg: Reply) {
  try {
    port.postMessage(msg);
  } catch {
    /* page gone */
  }
}
