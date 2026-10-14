// Interactive login flows (password, SSO incl. trusted devices / Key Connector, two-factor methods).
// The state lives in session storage so a flow survives the popup closing (SSO, Duo and security
// keys need a browser tab) and service worker restarts.
import {
  CT_PKCS8,
  CT_SPKI,
  decryptBytes,
  decryptUserKeyWithMasterKey,
  deriveMasterKey,
  encryptBytes,
  encryptKey,
  generateCbcHmacKey,
  generateRsaKeyPair,
  KdfConfig,
  KdfType,
  makePrivateKey,
  masterPasswordHash,
  rsaDecrypt,
  rsaDecryptKey,
  stretchKey,
  rsaEncryptKey,
  stretchMasterKey,
  SymKey,
} from "../crypto/bw";
import { fingerprintPhrase } from "../crypto/fingerprint";
import { MpPolicy, policyViolations, pwStats, PwStats } from "../shared/mp-policy";
import { b64decode, b64encode, b64urlencode, randomBytes, utf8 } from "../crypto/utils";
import type { FlowStep, LoginFlowPublic } from "../shared/messages";
import type { ServerType, ServerUrls } from "../shared/types";
import {
  anonJson,
  bearerJson,
  camelize,
  CLIENT_NAME,
  decodeJwt,
  deviceName,
  deviceType,
  errorMessage,
  HttpError,
  httpJson,
  postToken,
  prelogin,
} from "./api";
import { local, session } from "./store";
import { accountKeyFor, urlsFor, VaultService } from "./vault-service";

import { t } from "../shared/i18n";
interface AuthRequestState {
  id: string;
  type: 0 | 2;
  privateKeyB64: string;
  accessCode: string;
  fingerprint: string;
  createdAt: number;
  /** remember this device once the request is approved */
  rememberDevice?: boolean;
}

interface LoginFlow {
  id: string;
  createdAt: number;
  server: ServerType;
  baseUrl?: string;
  urls: ServerUrls;
  email: string;
  method: "password" | "sso" | "device" | "passkey";
  existingAccountKey?: string;
  /** login with passkey: assertion token of the server, the signed assertion and the PRF output (never sent) */
  passkeyToken?: string;
  deviceResponse?: string;
  prfB64?: string;
  /** login with device: the approval from the other device */
  deviceApproval?: { key: string; masterPasswordHash?: string | null };
  // password
  kdf?: KdfConfig;
  salt?: string;
  mkB64?: string;
  hash?: string;
  /** properties of the entered password, to check the organization's master password policy */
  pwStats?: PwStats;
  // sso
  orgIdentifier?: string;
  codeVerifier?: string;
  state?: string;
  redirectUri?: string;
  code?: string;
  ssoTabId?: number;
  // two-factor
  twoFactor?: { providers: number[]; providerData: Record<string, any>; emailHint?: string; ssoEmail2faSessionToken?: string };
  waitTabId?: number;
  waitKind?: "duo" | "webauthn" | "passkey";
  waitProvider?: number;
  rememberTwoFactor?: boolean;
  // after token
  token?: any;
  tde?: { canDevice: boolean; canAdmin: boolean; canMp: boolean };
  authRequest?: AuthRequestState;
  rememberDevice?: boolean;
  keyConnectorUrl?: string;
  step: FlowStep;
  error?: string;
  info?: string;
  accountKey?: string;
  ssoRequiredIdentifier?: string;
}

export interface LoginUi {
  openLoginWindow(): Promise<void>;
  focusLoginWindow(): Promise<void>;
  changed(): void;
}

const FLOW_KEY = "loginFlow";
const NEW_DEVICE_MSG = "new device verification required";

function randomString(len: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string {
  const out: string[] = [];
  const buf = new Uint8Array(len * 2);
  crypto.getRandomValues(buf);
  for (let i = 0; out.length < len; i = (i + 1) % buf.length) {
    if (i === 0 && out.length) crypto.getRandomValues(buf);
    const v = buf[i];
    if (v < Math.floor(256 / alphabet.length) * alphabet.length) out.push(alphabet[v % alphabet.length]);
  }
  return out.join("");
}

function kdfFromToken(j: any): KdfConfig | undefined {
  const mpu = j?.userDecryptionOptions?.masterPasswordUnlock;
  if (mpu?.kdf?.kdfType != null)
    return {
      kdf: mpu.kdf.kdfType,
      iterations: mpu.kdf.iterations,
      memory: mpu.kdf.memory ?? undefined,
      parallelism: mpu.kdf.parallelism ?? undefined,
    };
  if (j?.kdf != null)
    return { kdf: j.kdf, iterations: j.kdfIterations, memory: j.kdfMemory ?? undefined, parallelism: j.kdfParallelism ?? undefined };
  return undefined;
}

export class LoginFlows {
  constructor(
    private svc: VaultService,
    private ui: LoginUi,
  ) {}

  // -------------------------------------------------------------------------------------------
  // state

  private async load(): Promise<LoginFlow | undefined> {
    const f = await session.get<LoginFlow>(FLOW_KEY);
    if (f && Date.now() - f.createdAt > 60 * 60_000) {
      await session.remove(FLOW_KEY);
      return undefined;
    }
    return f;
  }

  private async save(f: LoginFlow) {
    await session.set(FLOW_KEY, f);
    this.ui.changed();
  }

  private toPublic(f: LoginFlow): LoginFlowPublic {
    let kcHost: string | undefined;
    try {
      if (f.keyConnectorUrl) kcHost = new URL(f.keyConnectorUrl).host;
    } catch {
      kcHost = f.keyConnectorUrl;
    }
    return {
      id: f.id,
      step: f.step,
      server: f.server,
      baseUrl: f.baseUrl,
      email: f.email,
      method: f.method,
      existingAccountKey: f.existingAccountKey,
      orgIdentifier: f.orgIdentifier,
      twoFactor: f.twoFactor ? { providers: f.twoFactor.providers, emailHint: f.twoFactor.emailHint } : undefined,
      waitKind: f.waitKind,
      tde: f.tde,
      authRequest: f.authRequest
        ? { type: f.authRequest.type, fingerprint: f.authRequest.fingerprint, createdAt: f.authRequest.createdAt }
        : undefined,
      keyConnectorHost: kcHost,
      rememberDevice: f.rememberDevice,
      error: f.error,
      info: f.info,
      accountKey: f.accountKey,
      ssoRequiredIdentifier: f.ssoRequiredIdentifier,
    };
  }

  async current(): Promise<LoginFlowPublic | null> {
    const f = await this.load();
    return f ? this.toPublic(f) : null;
  }

  /** Web vault origin of a running login (its security-key ceremony must not be intercepted). */
  async activeWebVaultOrigin(): Promise<string | undefined> {
    const f = await this.load();
    if (!f || f.step === "done" || f.step === "error") return undefined;
    try {
      return new URL(f.urls.webVault).origin;
    } catch {
      return undefined;
    }
  }

  async cancel() {
    const f = await this.load();
    if (f?.ssoTabId != null) chrome.tabs?.remove(f.ssoTabId).catch(() => {});
    if (f?.waitTabId != null) chrome.tabs?.remove(f.waitTabId).catch(() => {});
    await session.remove(FLOW_KEY);
    this.ui.changed();
  }

  private newFlow(p: { server: ServerType; baseUrl?: string; email: string; method: LoginFlow["method"] }): LoginFlow {
    const urls = urlsFor(p.server, p.baseUrl);
    return {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      server: p.server,
      baseUrl: p.server === "selfhosted" ? p.baseUrl : undefined,
      urls,
      email: p.email.trim().toLowerCase(),
      method: p.method,
      step: "error",
      rememberDevice: true,
    };
  }

  private async fail(f: LoginFlow, error: string, step: FlowStep = "error") {
    f.error = error;
    f.step = step;
    await this.save(f);
    return this.toPublic(f);
  }

  // -------------------------------------------------------------------------------------------
  // password login

  async startPassword(p: { server: ServerType; baseUrl?: string; email: string; password: string }): Promise<LoginFlowPublic> {
    await this.svc.ready;
    let f: LoginFlow;
    try {
      f = this.newFlow({ ...p, method: "password" });
    } catch (e: any) {
      return { id: "", step: "error", server: p.server, email: p.email, method: "password", error: e?.message ?? String(e) };
    }
    try {
      const pre = await prelogin(f.urls, f.email);
      const mk = await deriveMasterKey(p.password, pre.salt, pre.kdf);
      f.kdf = pre.kdf;
      f.salt = pre.salt;
      f.mkB64 = b64encode(mk);
      f.hash = await masterPasswordHash(mk, p.password);
      f.pwStats = pwStats(p.password);
    } catch (e: any) {
      return this.fail(f, e?.message ?? String(e));
    }
    return this.requestToken(f, {});
  }

  // -------------------------------------------------------------------------------------------
  // registration (new account)

  async register(p: {
    server: ServerType;
    baseUrl?: string;
    email: string;
    name: string;
    password: string;
    hint?: string;
  }): Promise<{ status: "done" | "verify-email"; flow?: LoginFlowPublic }> {
    const urls = urlsFor(p.server, p.baseUrl);
    const email = p.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(t("Bitte eine gültige E-Mail-Adresse eingeben"));
    if (p.password.length < 12) throw new Error(t("Das Master-Passwort muss mindestens 12 Zeichen lang sein."));
    const r = await httpJson(urls.identity + "/accounts/register/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email, name: p.name.trim() || null, receiveMarketingEmails: false }),
    });
    if (r.status === 204 || (r.status === 200 && !r.json)) return { status: "verify-email" };
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
    const token = typeof r.json === "string" ? r.json : (r.json?.message ?? r.json?.token);
    if (!token) return { status: "verify-email" };
    await this.finishRegistration(urls, email, String(token), p.password, p.hint);
    return { status: "done", flow: await this.startPassword({ server: p.server, baseUrl: p.baseUrl, email, password: p.password }) };
  }

  /** Create the keys and the account (also used after the link in the verification e-mail). */
  async finishRegistration(urls: ServerUrls, email: string, token: string, password: string, hint?: string) {
    const kdf: KdfConfig = { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 };
    const mk = await deriveMasterKey(password, email, kdf);
    const hash = await masterPasswordHash(mk, password);
    const userKey = generateCbcHmacKey();
    const encUserKey = await encryptKey(userKey, await stretchMasterKey(mk));
    const kp = await generateRsaKeyPair();
    const keys = {
      publicKey: b64encode(kp.publicKey),
      encryptedPrivateKey: await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key"),
    };
    const kdfJson = { kdfType: 0, iterations: kdf.iterations };
    await anonJson(urls.identity + "/accounts/register/finish", "POST", {
      email,
      emailVerificationToken: token,
      masterPasswordHash: hash,
      masterPasswordHint: hint?.trim() || null,
      userSymmetricKey: encUserKey,
      userAsymmetricKeys: keys,
      kdf: kdf.kdf,
      kdfIterations: kdf.iterations,
      masterPasswordAuthentication: { salt: email, kdf: kdfJson, masterPasswordAuthenticationHash: hash },
      masterPasswordUnlock: { salt: email, kdf: kdfJson, masterKeyWrappedUserKey: encUserKey },
    });
  }

  // -------------------------------------------------------------------------------------------
  // login with device (another logged-in Bitwarden app approves the request)

  async startDevice(p: { server: ServerType; baseUrl?: string; email: string }): Promise<LoginFlowPublic> {
    await this.svc.ready;
    let f: LoginFlow;
    try {
      f = this.newFlow({ ...p, method: "device" });
      if (!f.email) throw new Error(t("Bitte die E-Mail-Adresse eingeben"));
    } catch (e: any) {
      return { id: "", step: "error", server: p.server, email: p.email, method: "password", error: e?.message ?? String(e) };
    }
    const kp = await generateRsaKeyPair();
    const accessCode = randomString(25);
    try {
      const res = await anonJson(
        f.urls.api + "/auth-requests/",
        "POST",
        { email: f.email, deviceIdentifier: this.svc.deviceId, publicKey: b64encode(kp.publicKey), type: 0, accessCode },
        { "Device-Identifier": this.svc.deviceId },
      );
      f.authRequest = {
        id: res.id,
        type: 0,
        privateKeyB64: b64encode(kp.privateKey),
        accessCode,
        fingerprint: await fingerprintPhrase(f.email, kp.publicKey),
        createdAt: Date.now(),
      };
    } catch (e: any) {
      return this.fail(
        f,
        t(
          "Die Anfrage konnte nicht erstellt werden. Melde dich auf diesem Gerät einmal mit dem Master-Passwort an, damit es dem Server bekannt ist.",
        ) +
          " (" +
          (e?.message ?? e) +
          ")",
      );
    }
    f.step = "auth-request";
    await this.save(f);
    return this.toPublic(f);
  }

  // -------------------------------------------------------------------------------------------
  // login with passkey (no e-mail needed; the vault is decrypted with the passkey's PRF if set up)

  async startPasskey(p: { server: ServerType; baseUrl?: string }): Promise<LoginFlowPublic> {
    await this.svc.ready;
    let f: LoginFlow;
    try {
      f = this.newFlow({ ...p, email: "", method: "passkey" });
    } catch (e: any) {
      return { id: "", step: "error", server: p.server, email: "", method: "passkey", error: e?.message ?? String(e) };
    }
    let opts: any;
    try {
      opts = await anonJson(f.urls.identity + "/accounts/webauthn/assertion-options");
      if (!opts?.options?.challenge || !opts.token) throw new Error(t("Ungültige Antwort des Servers"));
    } catch (e: any) {
      const status = e instanceof HttpError ? e.status : 0;
      return this.fail(
        f,
        status === 404 || status === 405 ? t("Dieser Server unterstützt die Anmeldung mit Passkey nicht.") : (e?.message ?? String(e)),
      );
    }
    f.passkeyToken = opts.token;
    f.waitKind = "passkey";
    f.step = "twoFactor-wait";
    await this.ui.openLoginWindow();
    const tab = await this.openTab(f.urls.webVault + "/#mw-passkey");
    f.waitTabId = tab?.id;
    await this.save(f);
    this.runPasskeyCeremony(f.id, tab!.id!, opts.options).catch(() => {});
    return this.toPublic(f);
  }

  private async runPasskeyCeremony(flowId: string, tabId: number, options: any) {
    let result: { ok: boolean; token?: string; prf?: string; error?: string } = { ok: false, error: t("abgebrochen") };
    try {
      await waitForTabComplete(tabId);
      const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("passwordless-login")));
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN" as any,
        func: webAuthnOverlay,
        args: [
          options,
          {
            title: t("MultiWarden – Passkey"),
            desc: t("Melde dich mit dem Passkey deines Bitwarden-Kontos an."),
            confirm: t("Jetzt bestätigen"),
            cancel: t("Abbrechen"),
            error: t("Fehler"),
          },
          b64urlencode(salt),
        ],
      });
      result = (r?.result as any) ?? result;
    } catch (e: any) {
      result = { ok: false, error: e?.message ?? String(e) };
    }
    chrome.tabs.remove(tabId).catch(() => {});
    const f = await this.load();
    if (!f || f.id !== flowId || f.step !== "twoFactor-wait" || f.waitKind !== "passkey") return;
    f.waitTabId = undefined;
    f.waitKind = undefined;
    if (result.ok && result.token) {
      f.deviceResponse = result.token;
      f.prfB64 = result.prf;
      f.step = "error";
      await this.finishTabStep(f, () => this.requestToken(f, {}));
    } else {
      await this.fail(f, t("Passkey: ") + (result.error ?? t("abgebrochen")));
      await this.ui.focusLoginWindow();
    }
  }

  // -------------------------------------------------------------------------------------------
  // SSO

  async lookupSsoIdentifier(p: { server: ServerType; baseUrl?: string; email: string }): Promise<string | null> {
    try {
      const urls = urlsFor(p.server, p.baseUrl);
      const r = await anonJson(urls.api + "/organizations/domain/sso/verified", "POST", { email: p.email.trim() });
      const first = r?.data?.[0]?.organizationIdentifier;
      if (first) return first;
    } catch {
      /* fall through */
    }
    try {
      const urls = urlsFor(p.server, p.baseUrl);
      const r = await anonJson(urls.api + "/organizations/domain/sso/details", "POST", { email: p.email.trim() });
      if (r?.organizationIdentifier) return r.organizationIdentifier;
    } catch {
      /* none */
    }
    return null;
  }

  async startSso(p: {
    server: ServerType;
    baseUrl?: string;
    email: string;
    orgIdentifier: string;
    existingAccountKey?: string;
  }): Promise<LoginFlowPublic> {
    await this.svc.ready;
    let f: LoginFlow;
    try {
      f = this.newFlow({ ...p, method: "sso" });
    } catch (e: any) {
      return { id: "", step: "error", server: p.server, email: p.email, method: "sso", error: e?.message ?? String(e) };
    }
    f.orgIdentifier = p.orgIdentifier.trim();
    f.existingAccountKey = p.existingAccountKey;
    if (!f.orgIdentifier) return this.fail(f, t("Bitte die SSO-Kennung der Organisation angeben"));
    let ssoToken = "";
    try {
      const r = await anonJson(f.urls.identity + "/sso/prevalidate?domainHint=" + encodeURIComponent(f.orgIdentifier));
      ssoToken = r?.token ?? "";
    } catch (e: any) {
      return this.fail(f, t("SSO ist für diese Organisation nicht verfügbar: ") + (e?.message ?? e));
    }
    f.codeVerifier = randomString(64);
    const challenge = b64urlencode(
      new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(f.codeVerifier).slice().buffer as ArrayBuffer)),
    );
    f.state = randomString(64) + "_identifier=" + f.orgIdentifier;
    f.redirectUri = f.urls.webVault + "/sso-connector.html";
    const url =
      f.urls.identity +
      "/connect/authorize?client_id=" +
      CLIENT_NAME +
      "&redirect_uri=" +
      encodeURIComponent(f.redirectUri) +
      "&response_type=code&scope=" +
      encodeURIComponent("api offline_access") +
      "&state=" +
      encodeURIComponent(f.state) +
      "&code_challenge=" +
      challenge +
      "&code_challenge_method=S256&response_mode=query&domain_hint=" +
      encodeURIComponent(f.orgIdentifier) +
      "&ssoToken=" +
      encodeURIComponent(ssoToken);
    f.step = "sso-wait";
    await this.ui.openLoginWindow();
    const tab = await this.openTab(url);
    f.ssoTabId = tab?.id;
    await this.save(f);
    return this.toPublic(f);
  }

  private async openTab(url: string): Promise<chrome.tabs.Tab | undefined> {
    const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const win = wins.find((w) => w.focused) ?? wins[0];
    let tab: chrome.tabs.Tab;
    if (win?.id != null) {
      tab = await chrome.tabs.create({ url, windowId: win.id, active: true });
      await chrome.windows.update(win.id, { focused: true }).catch(() => {});
    } else {
      const w = await chrome.windows.create({ url, type: "normal" });
      tab = w?.tabs?.[0] as chrome.tabs.Tab;
    }
    return tab;
  }

  /** Watches tabs for the SSO / Duo redirects. */
  async onTabUpdated(tabId: number, url: string) {
    const f = await this.load();
    if (!f) return;
    if (f.step === "sso-wait" && f.redirectUri && url.startsWith(f.redirectUri)) {
      const u = new URL(url);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      chrome.tabs.remove(tabId).catch(() => {});
      f.ssoTabId = undefined;
      if (u.searchParams.get("error")) return this.finishTabStep(f, () => this.fail(f, t("SSO-Fehler: ") + u.searchParams.get("error")));
      if (!code || state !== f.state)
        return this.finishTabStep(f, () => this.fail(f, t("Ungültige Antwort vom Identity-Provider (state)")));
      f.code = code;
      await this.save(f);
      await this.finishTabStep(f, () => this.requestToken(f, {}));
      return;
    }
    if (f.step === "twoFactor-wait" && f.waitKind === "duo" && url.startsWith(f.urls.webVault + "/duo-redirect-connector.html")) {
      const u = new URL(url);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || !state) return;
      chrome.tabs.remove(tabId).catch(() => {});
      f.waitTabId = undefined;
      await this.finishTabStep(f, () => this.submitTwoFactorFlow(f, f.waitProvider ?? 2, `${code}|${state}`, !!f.rememberTwoFactor));
    }
  }

  private async finishTabStep(f: LoginFlow, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e: any) {
      await this.fail(f, e?.message ?? String(e));
    }
    await this.ui.focusLoginWindow();
  }

  async onTabRemoved(tabId: number) {
    const f = await this.load();
    if (!f) return;
    if (f.step === "sso-wait" && f.ssoTabId === tabId) {
      await this.fail(f, t("Die SSO-Anmeldung wurde abgebrochen."));
    } else if (f.step === "twoFactor-wait" && f.waitTabId === tabId && f.waitKind === "duo") {
      f.waitTabId = undefined;
      await this.fail(f, t("Die Duo-Bestätigung wurde abgebrochen."), "twoFactor");
    }
  }

  // -------------------------------------------------------------------------------------------
  // token request

  private baseForm(f: LoginFlow): Record<string, string | number | undefined> {
    const form: Record<string, string | number | undefined> = {
      scope: "api offline_access",
      client_id: CLIENT_NAME,
      deviceType: deviceType(),
      deviceIdentifier: this.svc.deviceId,
      deviceName: deviceName(),
    };
    if (f.method === "password") {
      form.grant_type = "password";
      form.username = f.email;
      form.password = f.hash;
    } else if (f.method === "passkey") {
      form.grant_type = "webauthn";
      form.token = f.passkeyToken;
      form.deviceResponse = f.deviceResponse;
    } else if (f.method === "device") {
      form.grant_type = "password";
      form.username = f.email;
      form.password = f.authRequest?.accessCode;
      form.authRequest = f.authRequest?.id;
    } else {
      form.grant_type = "authorization_code";
      form.code = f.code;
      form.code_verifier = f.codeVerifier;
      form.redirect_uri = f.redirectUri;
    }
    return form;
  }

  private rememberKey(f: LoginFlow) {
    return f.urls.identity + "|" + f.email;
  }

  private async requestToken(
    f: LoginFlow,
    extra: { twoFactor?: { provider: number; token: string; remember: boolean }; newDeviceOtp?: string },
  ): Promise<LoginFlowPublic> {
    const form = this.baseForm(f);
    const rememberMap = (await local.get<Record<string, string>>("twoFactorRemember")) ?? {};
    const rk = this.rememberKey(f);
    if (extra.twoFactor) {
      form.twoFactorToken = extra.twoFactor.token.replace(/\s/g, "");
      form.twoFactorProvider = extra.twoFactor.provider;
      form.twoFactorRemember = extra.twoFactor.remember ? "1" : "0";
    } else if (rememberMap[rk]) {
      form.twoFactorToken = rememberMap[rk];
      form.twoFactorProvider = 5;
      form.twoFactorRemember = "0";
    }
    if (extra.newDeviceOtp) form.newDeviceOtp = extra.newDeviceOtp.trim();

    let r;
    try {
      r = await postToken(f.urls, form);
    } catch (e: any) {
      return this.fail(f, e?.message ?? String(e), f.step === "twoFactor" || f.step === "newDevice" ? f.step : "error");
    }
    const j = camelize(r.json ?? {});
    f.error = undefined;
    if (r.status === 200 && j.access_token) {
      if (j.twoFactorToken) {
        rememberMap[rk] = j.twoFactorToken;
        await local.set("twoFactorRemember", rememberMap);
      }
      f.token = j;
      if (!f.email) f.email = (decodeJwt(j.access_token).email ?? "").toLowerCase();
      try {
        await this.afterToken(f);
      } catch (e: any) {
        return this.fail(f, e?.message ?? String(e));
      }
      return this.toPublic(f);
    }
    if (r.status === 400 && j.twoFactorProviders2 && Object.keys(j.twoFactorProviders2).length) {
      if (form.twoFactorProvider === 5) {
        delete rememberMap[rk];
        await local.set("twoFactorRemember", rememberMap);
      }
      const wasTwoFactor = !!extra.twoFactor;
      f.twoFactor = {
        providers: Object.keys(j.twoFactorProviders2).map(Number),
        providerData: j.twoFactorProviders2,
        emailHint: j.twoFactorProviders2["1"]?.email ?? undefined,
        ssoEmail2faSessionToken: j.ssoEmail2faSessionToken ?? f.twoFactor?.ssoEmail2faSessionToken,
      };
      f.step = "twoFactor";
      if (wasTwoFactor) f.error = t("Der Bestätigungscode ist ungültig oder abgelaufen.");
      await this.save(f);
      return this.toPublic(f);
    }
    const msg: string = (j?.errorModel?.message ?? "").toLowerCase();
    if (r.status === 400 && msg === NEW_DEVICE_MSG) {
      if (extra.newDeviceOtp) f.error = t("Der Code ist ungültig.");
      f.step = "newDevice";
      await this.save(f);
      return this.toPublic(f);
    }
    if (j.ssoOrganizationIdentifier) {
      f.ssoRequiredIdentifier = j.ssoOrganizationIdentifier;
      return this.fail(f, t("Deine Organisation verlangt die Anmeldung per SSO."));
    }
    if (j.hCaptcha_SiteKey || j.hCaptchaSiteKey)
      return this.fail(f, t("Der Server verlangt ein Captcha – das wird von dieser Erweiterung nicht unterstützt."));
    let err = errorMessage(r.status, r.json);
    if (/username or password is incorrect|invalid_grant/i.test(err))
      err = f.method === "password" ? t("E-Mail oder Master-Passwort ist falsch.") : t("Die SSO-Anmeldung wurde vom Server abgelehnt.");
    const keepStep = f.step === "twoFactor" || f.step === "newDevice" ? f.step : "error";
    if (keepStep === "twoFactor" && extra.twoFactor) err = t("Der Bestätigungscode ist ungültig.");
    return this.fail(f, err, keepStep);
  }

  // -------------------------------------------------------------------------------------------
  // after a successful token request: obtain the user key

  private async afterToken(f: LoginFlow) {
    const j = f.token;
    const claims = decodeJwt(j.access_token);
    const userId: string = claims.sub;
    if (claims.email) f.email = String(claims.email).toLowerCase();
    const accountKey = accountKeyFor(f.urls, userId);
    if (f.existingAccountKey && f.existingAccountKey !== accountKey)
      throw new Error(t("Beim Identity-Provider wurde ein anderes Konto angemeldet als das zu entsperrende."));
    const udo = j.userDecryptionOptions ?? {};
    const mpu = udo.masterPasswordUnlock;

    if (f.method === "device") {
      const ap = f.deviceApproval;
      const ar = f.authRequest;
      if (!ap || !ar) throw new Error(t("Keine laufende Anmeldung"));
      const priv = makePrivateKey(b64decode(ar.privateKeyB64));
      let userKey: SymKey;
      const encUserKey: string | undefined = j.key ?? mpu?.masterKeyWrappedUserKey ?? mpu?.masterKeyEncryptedUserKey;
      if (ap.masterPasswordHash) {
        // older apps share the master key instead of the user key
        const mk = await rsaDecrypt(ap.key, priv);
        if (!encUserKey) throw new Error(t("Benutzerschlüssel konnte nicht entschlüsselt werden."));
        userKey = await decryptUserKeyWithMasterKey(encUserKey, mk);
      } else userKey = await rsaDecryptKey(ap.key, priv);
      f.deviceApproval = undefined;
      await this.complete(f, userKey, {
        decryption: udo.trustedDeviceOption ? "tde" : "masterPassword",
        hasMasterPassword: udo.hasMasterPassword !== false && !!encUserKey,
        ...this.mpData(j, f),
      });
      return;
    }

    if (f.method === "password") {
      const mk = b64decode(f.mkB64!);
      const encUserKey: string | undefined = j.key ?? mpu?.masterKeyWrappedUserKey ?? mpu?.masterKeyEncryptedUserKey;
      if (!encUserKey) throw new Error(t("Dieses Konto hat kein Master-Passwort. Bitte „Mit SSO anmelden“ verwenden."));
      let userKey: SymKey;
      try {
        userKey = await decryptUserKeyWithMasterKey(encUserKey, mk);
      } catch {
        throw new Error(t("Benutzerschlüssel konnte nicht entschlüsselt werden."));
      }
      await this.complete(f, userKey, {
        decryption: udo.trustedDeviceOption ? "tde" : "masterPassword",
        hasMasterPassword: true,
        kdf: kdfFromToken(j) ?? f.kdf,
        salt: mpu?.salt ?? f.salt,
        encUserKey,
      });
      return;
    }

    if (f.method === "passkey") {
      // PRF: passkey key → private key → user key (like the official WebAuthn login strategy)
      const prfOpt = udo.webAuthnPrfOption;
      const prfB64 = f.prfB64;
      f.prfB64 = undefined;
      f.deviceResponse = undefined;
      if (prfB64 && prfOpt?.encryptedPrivateKey && prfOpt.encryptedUserKey) {
        let userKey: SymKey | undefined;
        try {
          const prfKey = await stretchKey(b64decode(prfB64));
          const priv = (await decryptBytes(prfOpt.encryptedPrivateKey, prfKey)).bytes;
          userKey = await rsaDecryptKey(prfOpt.encryptedUserKey, makePrivateKey(priv));
        } catch {
          f.info = t("Der Passkey konnte den Tresor nicht entschlüsseln.");
        }
        if (userKey) {
          const kc = udo.keyConnectorOption?.keyConnectorUrl;
          await this.complete(f, userKey, {
            decryption: udo.trustedDeviceOption ? "tde" : kc && udo.hasMasterPassword === false ? "keyConnector" : "masterPassword",
            hasMasterPassword: udo.hasMasterPassword !== false && !!(j.key || mpu),
            keyConnectorUrl: kc,
            ...this.mpData(j, f),
          });
          return;
        }
      }
      // otherwise like SSO: Key Connector, trusted device or master password
    }

    // --- SSO ---
    const kcUrl: string | undefined = udo.keyConnectorOption?.keyConnectorUrl;
    if (kcUrl && udo.hasMasterPassword === false) {
      f.keyConnectorUrl = kcUrl;
      if (j.key) {
        const r = await bearerJson(kcUrl + "/user-keys", j.access_token);
        const mk = b64decode(r.key);
        const userKey = await decryptUserKeyWithMasterKey(j.key, mk);
        await this.complete(f, userKey, {
          decryption: "keyConnector",
          hasMasterPassword: false,
          encUserKey: j.key,
          keyConnectorUrl: kcUrl,
        });
        return;
      }
      // new user of a Key Connector organisation: confirm the key server first
      f.step = "kc-confirm";
      await this.save(f);
      return;
    }

    if (udo.trustedDeviceOption) {
      const tdo = udo.trustedDeviceOption;
      // 1) a previously requested admin approval that has been granted meanwhile
      const pending = await local.get<AuthRequestState>("adminReq:" + accountKey);
      if (pending) {
        try {
          const ar = await bearerJson(f.urls.api + "/auth-requests/" + pending.id, j.access_token);
          if (ar.requestApproved && ar.key) {
            const userKey = await rsaDecryptKey(ar.key, makePrivateKey(b64decode(pending.privateKeyB64)));
            await local.remove("adminReq:" + accountKey);
            f.rememberDevice = !!pending.rememberDevice;
            await this.complete(f, userKey, { decryption: "tde", hasMasterPassword: !!udo.hasMasterPassword, ...this.mpData(j, f) });
            return;
          }
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) await local.remove("adminReq:" + accountKey);
        }
      }
      // 2) this device is trusted
      const deviceKey = await this.svc.getDeviceKey(accountKey);
      if (deviceKey && tdo.encryptedPrivateKey && tdo.encryptedUserKey) {
        try {
          const devPriv = (await decryptBytes(tdo.encryptedPrivateKey, deviceKey)).bytes;
          const userKey = await rsaDecryptKey(tdo.encryptedUserKey, makePrivateKey(devPriv));
          f.rememberDevice = false; // already trusted
          await this.complete(f, userKey, { decryption: "tde", hasMasterPassword: !!udo.hasMasterPassword, ...this.mpData(j, f) });
          return;
        } catch {
          await this.svc.setDeviceKey(accountKey, undefined);
        }
      }
      // 3) new member without keys, or approval needed
      const isNewUser = !j.privateKey && !j.accountKeys;
      if (isNewUser) {
        f.step = "tde-new";
      } else {
        f.tde = { canDevice: !!tdo.hasLoginApprovingDevice, canAdmin: !!tdo.hasAdminApproval, canMp: !!udo.hasMasterPassword };
        f.step = "tde";
        if (pending) f.info = t("Deine Admin-Freigabe ist noch nicht erteilt.");
      }
      await this.save(f);
      return;
    }

    if (udo.hasMasterPassword !== false && (j.key || mpu)) {
      f.step = "mp";
      await this.save(f);
      return;
    }

    // JIT-provisioned user without master password
    f.step = "set-password";
    await this.save(f);
  }

  private mpData(j: any, f: LoginFlow) {
    const mpu = j.userDecryptionOptions?.masterPasswordUnlock;
    const enc = j.key ?? mpu?.masterKeyWrappedUserKey ?? mpu?.masterKeyEncryptedUserKey;
    if (!enc) return {};
    return { kdf: kdfFromToken(j), salt: mpu?.salt ?? f.email, encUserKey: enc };
  }

  private async complete(
    f: LoginFlow,
    userKey: SymKey,
    o: {
      decryption: "masterPassword" | "tde" | "keyConnector";
      hasMasterPassword: boolean;
      kdf?: KdfConfig;
      salt?: string;
      encUserKey?: string;
      keyConnectorUrl?: string;
    },
  ) {
    const j = f.token;
    const userId = decodeJwt(j.access_token).sub;
    const accountKey = accountKeyFor(f.urls, userId);
    // admin set a temporary password, or the password violates an enforced organization policy
    const policy = j.masterPasswordPolicy as MpPolicy | undefined;
    const force: "temp" | "weak" | undefined = j.forcePasswordReset
      ? "temp"
      : policy?.enforceOnLogin && f.pwStats && policyViolations(f.pwStats, policy).length
        ? "weak"
        : undefined;
    if (o.decryption === "tde" && f.rememberDevice && !(await this.svc.getDeviceKey(accountKey))) {
      try {
        await this.trustDevice(f, accountKey, userKey);
      } catch (e: any) {
        f.info = t("Gerät konnte nicht als vertrauenswürdig gespeichert werden: ") + (e?.message ?? e);
      }
    }
    if (f.existingAccountKey) {
      await this.svc.unlockWithUserKey(f.existingAccountKey, userKey, j);
      f.accountKey = f.existingAccountKey;
    } else {
      f.accountKey = await this.svc.completeLogin({
        server: f.server,
        urls: f.urls,
        email: f.email,
        token: j,
        userKey,
        decryption: o.decryption,
        hasMasterPassword: o.hasMasterPassword,
        kdf: o.kdf,
        salt: o.salt,
        encUserKey: o.encUserKey,
        ssoOrgIdentifier: f.method === "sso" ? f.orgIdentifier : undefined,
        keyConnectorUrl: o.keyConnectorUrl,
      });
    }
    await this.svc.setForcePasswordChange(f.accountKey!, force);
    // drop secrets from the stored flow
    f.pwStats = undefined;
    f.mkB64 = undefined;
    f.hash = undefined;
    f.token = undefined;
    f.codeVerifier = undefined;
    f.authRequest = undefined;
    f.deviceApproval = undefined;
    f.step = "done";
    f.error = undefined;
    await this.save(f);
  }

  /** Register this browser as trusted device (TDE): user key encrypted to a device RSA key. */
  private async trustDevice(f: LoginFlow, accountKey: string, userKey: SymKey) {
    const deviceKey = generateCbcHmacKey();
    const kp = await generateRsaKeyPair();
    const body = {
      encryptedUserKey: await rsaEncryptKey(userKey, kp.publicKey),
      encryptedPublicKey: await encryptBytes(kp.publicKey, userKey, CT_SPKI),
      encryptedPrivateKey: await encryptBytes(kp.privateKey, deviceKey, CT_PKCS8),
    };
    await bearerJson(f.urls.api + "/devices/" + encodeURIComponent(this.svc.deviceId) + "/keys", f.token.access_token, "PUT", body);
    await this.svc.setDeviceKey(accountKey, deviceKey);
  }

  // -------------------------------------------------------------------------------------------
  // two-factor

  async submitTwoFactor(p: { provider: number; token: string; remember: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f) throw new Error(t("Keine laufende Anmeldung"));
    return this.submitTwoFactorFlow(f, p.provider, p.token, p.remember);
  }

  private async submitTwoFactorFlow(f: LoginFlow, provider: number, token: string, remember: boolean) {
    f.step = "twoFactor";
    return this.requestToken(f, { twoFactor: { provider, token, remember } });
  }

  async sendEmailCode(): Promise<{ ok: boolean; error?: string }> {
    const f = await this.load();
    if (!f) return { ok: false, error: t("Keine laufende Anmeldung") };
    const r = await httpJson(f.urls.api + "/two-factor/send-email-login", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        email: f.email,
        masterPasswordHash: f.hash ?? "",
        deviceIdentifier: this.svc.deviceId,
        ssoEmail2FaSessionToken: f.twoFactor?.ssoEmail2faSessionToken ?? "",
        authRequestAccessCode: "",
        authRequestId: "",
      }),
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, error: errorMessage(r.status, r.json) };
  }

  async startDuo(p: { provider: number; remember: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f || !f.twoFactor) throw new Error(t("Keine laufende Anmeldung"));
    const data = f.twoFactor.providerData[String(p.provider)] ?? {};
    const authUrl: string | undefined = data.authUrl ?? data.AuthUrl;
    if (!authUrl) return this.fail(f, t("Duo hat keine Anmelde-URL geliefert (Duo-Konfiguration prüfen)."), "twoFactor");
    f.waitKind = "duo";
    f.waitProvider = p.provider;
    f.rememberTwoFactor = p.remember;
    f.step = "twoFactor-wait";
    f.error = undefined;
    await this.ui.openLoginWindow();
    const tab = await this.openTab(authUrl);
    f.waitTabId = tab?.id;
    await this.save(f);
    return this.toPublic(f);
  }

  async startWebAuthn(p: { remember: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f || !f.twoFactor) throw new Error(t("Keine laufende Anmeldung"));
    const options = f.twoFactor.providerData["7"];
    if (!options) return this.fail(f, t("Keine Sicherheitsschlüssel-Daten vom Server erhalten."), "twoFactor");
    f.waitKind = "webauthn";
    f.waitProvider = 7;
    f.rememberTwoFactor = p.remember;
    f.step = "twoFactor-wait";
    f.error = undefined;
    await this.ui.openLoginWindow();
    const tab = await this.openTab(f.urls.webVault + "/#mw-security-key");
    f.waitTabId = tab?.id;
    await this.save(f);
    // run the ceremony on the vault's origin (required by WebAuthn), outside of the popup
    this.runWebAuthnCeremony(f.id, tab!.id!, options).catch(() => {});
    return this.toPublic(f);
  }

  private async runWebAuthnCeremony(flowId: string, tabId: number, options: any) {
    let result: { ok: boolean; token?: string; error?: string } = { ok: false, error: "Abgebrochen" };
    try {
      await waitForTabComplete(tabId);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN" as any,
        func: webAuthnOverlay,
        args: [
          options,
          {
            title: t("MultiWarden – Sicherheitsschlüssel"),
            desc: t("Bestätige die Anmeldung mit deinem Sicherheitsschlüssel oder Passkey."),
            confirm: t("Jetzt bestätigen"),
            cancel: t("Abbrechen"),
            error: t("Fehler"),
          },
        ],
      });
      result = (r?.result as any) ?? result;
    } catch (e: any) {
      result = { ok: false, error: e?.message ?? String(e) };
    }
    chrome.tabs.remove(tabId).catch(() => {});
    const f = await this.load();
    if (!f || f.id !== flowId || f.step !== "twoFactor-wait") return;
    f.waitTabId = undefined;
    if (result.ok && result.token) {
      await this.finishTabStep(f, () => this.submitTwoFactorFlow(f, 7, result.token!, !!f.rememberTwoFactor));
    } else {
      await this.fail(f, t("Sicherheitsschlüssel: ") + (result.error ?? "abgebrochen"), "twoFactor");
      await this.ui.focusLoginWindow();
    }
  }

  async submitNewDevice(otp: string): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f) throw new Error(t("Keine laufende Anmeldung"));
    f.step = "newDevice";
    return this.requestToken(f, { newDeviceOtp: otp });
  }

  async resendNewDevice(): Promise<{ ok: boolean; error?: string }> {
    const f = await this.load();
    if (!f) return { ok: false, error: t("Keine laufende Anmeldung") };
    const r = await httpJson(f.urls.api + "/accounts/resend-new-device-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ email: f.email, masterPasswordHash: f.hash }),
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, error: errorMessage(r.status, r.json) };
  }

  // -------------------------------------------------------------------------------------------
  // SSO decryption steps

  /** SSO user with master password (also TDE "approve with master password"). */
  async submitMasterPassword(p: { password: string; rememberDevice?: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f?.token) throw new Error(t("Keine laufende Anmeldung"));
    const j = f.token;
    const mpu = j.userDecryptionOptions?.masterPasswordUnlock;
    const kdf = kdfFromToken(j);
    const salt = mpu?.salt ?? f.email;
    const encUserKey = j.key ?? mpu?.masterKeyWrappedUserKey ?? mpu?.masterKeyEncryptedUserKey;
    if (!kdf || !encUserKey) return this.fail(f, t("Für dieses Konto liegen keine Master-Passwort-Daten vor."), "mp");
    let userKey: SymKey;
    try {
      const mk = await deriveMasterKey(p.password, salt, kdf);
      userKey = await decryptUserKeyWithMasterKey(encUserKey, mk);
    } catch {
      f.error = t("Falsches Master-Passwort");
      f.step = "mp";
      await this.save(f);
      return this.toPublic(f);
    }
    if (p.rememberDevice != null) f.rememberDevice = p.rememberDevice;
    const isTde = !!j.userDecryptionOptions?.trustedDeviceOption;
    await this.complete(f, userKey, { decryption: isTde ? "tde" : "masterPassword", hasMasterPassword: true, kdf, salt, encUserKey });
    return this.toPublic(f);
  }

  async tdeChoose(p: { option: "device" | "admin" | "mp"; rememberDevice: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f?.token) throw new Error(t("Keine laufende Anmeldung"));
    f.rememberDevice = p.rememberDevice;
    f.error = undefined;
    if (p.option === "mp") {
      f.step = "mp";
      await this.save(f);
      return this.toPublic(f);
    }
    const kp = await generateRsaKeyPair();
    const accessCode = randomString(25);
    const fingerprint = await fingerprintPhrase(f.email.toLowerCase(), kp.publicKey);
    const body = {
      email: f.email,
      deviceIdentifier: this.svc.deviceId,
      publicKey: b64encode(kp.publicKey),
      type: p.option === "admin" ? 2 : 0,
      accessCode,
    };
    let res: any;
    try {
      if (p.option === "admin") res = await bearerJson(f.urls.api + "/auth-requests/admin-request", f.token.access_token, "POST", body);
      else res = await anonJson(f.urls.api + "/auth-requests/", "POST", body, { "Device-Identifier": this.svc.deviceId });
    } catch (e: any) {
      return this.fail(f, t("Anfrage konnte nicht erstellt werden: ") + (e?.message ?? e), "tde");
    }
    f.authRequest = {
      id: res.id,
      type: p.option === "admin" ? 2 : 0,
      privateKeyB64: b64encode(kp.privateKey),
      accessCode,
      fingerprint,
      createdAt: Date.now(),
      rememberDevice: p.rememberDevice,
    };
    if (p.option === "admin") {
      const userId = decodeJwt(f.token.access_token).sub;
      await local.set("adminReq:" + accountKeyFor(f.urls, userId), f.authRequest);
    }
    f.step = "auth-request";
    await this.save(f);
    return this.toPublic(f);
  }

  /** Check whether a device / admin approval request has been answered. */
  async poll(): Promise<LoginFlowPublic | null> {
    const f = await this.load();
    if (!f) return null;
    if (f.step === "auth-request" && f.method === "device" && f.authRequest && !f.token) return this.pollDevice(f);
    if (f.step !== "auth-request" || !f.authRequest || !f.token) return this.toPublic(f);
    const ar = f.authRequest;
    let resp: any;
    try {
      resp = await bearerJson(f.urls.api + "/auth-requests/" + ar.id, f.token.access_token);
    } catch (e) {
      try {
        resp = await anonJson(f.urls.api + "/auth-requests/" + ar.id + "/response?code=" + encodeURIComponent(ar.accessCode));
      } catch {
        return this.toPublic(f);
      }
    }
    if (resp?.requestApproved && resp.key) {
      const userKey = await rsaDecryptKey(resp.key, makePrivateKey(b64decode(ar.privateKeyB64)));
      const userId = decodeJwt(f.token.access_token).sub;
      await local.remove("adminReq:" + accountKeyFor(f.urls, userId));
      await this.complete(f, userKey, {
        decryption: "tde",
        hasMasterPassword: !!f.token.userDecryptionOptions?.hasMasterPassword,
        ...this.mpData(f.token, f),
      });
      return this.toPublic(f);
    }
    if (resp?.requestApproved === false && resp?.responseDate) {
      f.authRequest = undefined;
      return this.fail(f, t("Die Anfrage wurde abgelehnt."), "tde");
    }
    return this.toPublic(f);
  }

  private async pollDevice(f: LoginFlow): Promise<LoginFlowPublic> {
    const ar = f.authRequest!;
    if (Date.now() - ar.createdAt > 15 * 60_000) return this.fail(f, t("Die Anfrage ist abgelaufen. Bitte erneut versuchen."));
    let resp: any;
    try {
      resp = await anonJson(f.urls.api + "/auth-requests/" + ar.id + "/response?code=" + encodeURIComponent(ar.accessCode));
    } catch {
      return this.toPublic(f);
    }
    if (resp?.requestApproved && resp.key) {
      f.deviceApproval = { key: resp.key, masterPasswordHash: resp.masterPasswordHash ?? null };
      return this.requestToken(f, {});
    }
    if (resp?.requestApproved === false && resp?.responseDate) return this.fail(f, t("Die Anfrage wurde abgelehnt."));
    return this.toPublic(f);
  }

  /** First login of a member of a TDE organisation: create keys, enroll in account recovery, trust device. */
  async tdeCreateUser(p: { rememberDevice: boolean }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f?.token) throw new Error(t("Keine laufende Anmeldung"));
    f.rememberDevice = p.rememberDevice;
    const token = f.token.access_token;
    try {
      const userKey = generateCbcHmacKey();
      const kp = await generateRsaKeyPair();
      await bearerJson(f.urls.api + "/accounts/keys", token, "POST", {
        publicKey: b64encode(kp.publicKey),
        encryptedPrivateKey: await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key"),
      });
      await this.enrollAccountRecovery(f, userKey, null, true);
      await this.complete(f, userKey, { decryption: "tde", hasMasterPassword: false });
    } catch (e: any) {
      return this.fail(f, e?.message ?? String(e), "tde-new");
    }
    return this.toPublic(f);
  }

  /** JIT-provisioned SSO user: choose a master password. */
  async setInitialPassword(p: { password: string; hint?: string }): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f?.token) throw new Error(t("Keine laufende Anmeldung"));
    if (p.password.length < 12) {
      f.error = t("Das Master-Passwort muss mindestens 12 Zeichen lang sein.");
      await this.save(f);
      return this.toPublic(f);
    }
    const kdf: KdfConfig = { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 };
    const salt = f.email;
    try {
      const mk = await deriveMasterKey(p.password, salt, kdf);
      const hash = await masterPasswordHash(mk, p.password);
      const userKey = generateCbcHmacKey();
      const encUserKey = await encryptKey(userKey, await stretchMasterKey(mk));
      const kp = await generateRsaKeyPair();
      await bearerJson(f.urls.api + "/accounts/set-password", f.token.access_token, "POST", {
        masterPasswordHash: hash,
        key: encUserKey,
        masterPasswordHint: p.hint || null,
        keys: {
          publicKey: b64encode(kp.publicKey),
          encryptedPrivateKey: await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key"),
        },
        kdf: kdf.kdf,
        kdfIterations: kdf.iterations,
        orgIdentifier: f.orgIdentifier,
      });
      await this.enrollAccountRecovery(f, userKey, hash, false);
      await this.complete(f, userKey, { decryption: "masterPassword", hasMasterPassword: true, kdf, salt, encUserKey });
    } catch (e: any) {
      return this.fail(f, e?.message ?? String(e), "set-password");
    }
    return this.toPublic(f);
  }

  /** New member of a Key Connector organisation (after the user confirmed the key server). */
  async confirmKeyConnector(): Promise<LoginFlowPublic> {
    const f = await this.load();
    if (!f?.token || !f.keyConnectorUrl) throw new Error(t("Keine laufende Anmeldung"));
    const kc = f.keyConnectorUrl;
    const j = f.token;
    try {
      const kdf: KdfConfig = kdfFromToken(j) ?? { kdf: KdfType.PBKDF2_SHA256, iterations: 600000 };
      const password = b64encode(randomBytes(64));
      const mk = await deriveMasterKey(password, f.email, kdf);
      await bearerJson(kc + "/user-keys", j.access_token, "POST", { key: b64encode(mk) });
      const userKey = generateCbcHmacKey();
      const encUserKey = await encryptKey(userKey, await stretchMasterKey(mk));
      const kp = await generateRsaKeyPair();
      await bearerJson(f.urls.api + "/accounts/set-key-connector-key", j.access_token, "POST", {
        key: encUserKey,
        keys: {
          publicKey: b64encode(kp.publicKey),
          encryptedPrivateKey: await encryptBytes(kp.privateKey, userKey, "application/x.bitwarden.legacy-key"),
        },
        kdf: kdf.kdf,
        kdfIterations: kdf.iterations,
        kdfMemory: kdf.memory,
        kdfParallelism: kdf.parallelism,
        orgIdentifier: f.orgIdentifier,
      });
      await this.complete(f, userKey, { decryption: "keyConnector", hasMasterPassword: false, encUserKey, keyConnectorUrl: kc });
    } catch (e: any) {
      return this.fail(f, "Key Connector: " + (e?.message ?? e), "kc-confirm");
    }
    return this.toPublic(f);
  }

  private async enrollAccountRecovery(f: LoginFlow, userKey: SymKey, mpHash: string | null, required: boolean) {
    if (!f.orgIdentifier) return;
    const token = f.token.access_token;
    let status: any;
    try {
      status = await bearerJson(f.urls.api + "/organizations/" + encodeURIComponent(f.orgIdentifier) + "/auto-enroll-status", token);
    } catch (e) {
      if (required) throw e;
      return;
    }
    if (!required && !status?.resetPasswordEnabled) return;
    const orgId = status.id;
    const keys = await bearerJson(f.urls.api + "/organizations/" + orgId + "/keys", token);
    const userId = decodeJwt(token).sub;
    await bearerJson(f.urls.api + "/organizations/" + orgId + "/users/" + userId + "/reset-password-enrollment", token, "PUT", {
      resetPasswordKey: await rsaEncryptKey(userKey, b64decode(keys.publicKey)),
      masterPasswordHash: mpHash,
    });
  }

  /** Test helper / non-interactive callers: run a password login to completion if possible. */
  async ack() {
    const f = await this.load();
    if (f && (f.step === "done" || f.step === "error")) await session.remove(FLOW_KEY);
  }
}

async function waitForTabComplete(tabId: number, timeout = 30_000) {
  const start = Date.now();
  for (;;) {
    const tx = await chrome.tabs.get(tabId);
    if (tx.status === "complete") return;
    if (Date.now() - start > timeout) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Injected into the web vault's origin (MAIN world): shows a full-page panel and performs the
 * WebAuthn assertion requested by the server. Must be self-contained (serialised by executeScript).
 */
function webAuthnOverlay(
  options: any,
  text: { title: string; desc: string; confirm: string; cancel: string; error: string },
  /** login with passkey: PRF salt (base64url); the PRF output is returned separately and never sent */
  prfSalt?: string,
): Promise<{ ok: boolean; token?: string; prf?: string; error?: string }> {
  return new Promise((resolve) => {
    const dec = (s: string) => {
      const tx = s.replace(/-/g, "+").replace(/_/g, "/");
      return Uint8Array.from(atob(tx + "===".slice((tx.length + 3) % 4)), (c) => c.charCodeAt(0));
    };
    const enc = (b: ArrayBuffer) => {
      const u = new Uint8Array(b);
      let s = "";
      for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    root.innerHTML = `
      <style>
        .bg{position:fixed;inset:0;background:${dark ? "#0e1622" : "#f1f4f8"};display:flex;align-items:center;justify-content:center;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:${dark ? "#e4ebf5" : "#1b2433"}}
        .card{background:${dark ? "#152031" : "#fff"};border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.18);padding:28px;max-width:380px;text-align:center}
        h1{font-size:19px;margin:12px 0 6px}
        p{margin:0 0 18px;color:${dark ? "#a2b0c6" : "#58667e"}}
        button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 20px;cursor:pointer}
        .primary{background:${dark ? "#84aef5" : "#175ddc"};color:${dark ? "#0e1622" : "#fff"}}
        .ghost{background:transparent;color:${dark ? "#84aef5" : "#175ddc"};margin-top:8px}
        .err{color:#c83522;margin-top:12px;min-height:1em}
      </style>
      <div class="bg"><div class="card">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>
        <h1></h1>
        <p></p>
        <button class="primary" id="go"></button><br/>
        <button class="ghost" id="cancel"></button>
        <div class="err" id="err"></div>
      </div></div>`;
    root.querySelector("h1")!.textContent = text.title;
    root.querySelector("p")!.textContent = text.desc;
    root.getElementById("go")!.textContent = text.confirm;
    root.getElementById("cancel")!.textContent = text.cancel;
    document.documentElement.appendChild(host);
    const errEl = root.getElementById("err")!;
    const run = async () => {
      errEl.textContent = "";
      try {
        const pk: any = JSON.parse(JSON.stringify(options));
        pk.challenge = dec(pk.challenge);
        pk.allowCredentials = (pk.allowCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) }));
        for (const k of Object.keys(pk)) if (pk[k] == null) delete pk[k];
        if (pk.extensions) for (const k of Object.keys(pk.extensions)) if (pk.extensions[k] == null) delete pk.extensions[k];
        if (prfSalt) pk.extensions = { ...(pk.extensions ?? {}), prf: { eval: { first: dec(prfSalt) } } };
        const native = navigator.credentials.get.bind(navigator.credentials);
        let cred: any;
        try {
          cred = await native({ publicKey: pk });
        } catch (e: any) {
          // the legacy U2F "appid" extension is rejected for plain-http servers → retry without it
          if (e?.name !== "SecurityError" || !pk.extensions?.appid) throw e;
          delete pk.extensions.appid;
          cred = await native({ publicKey: pk });
        }
        let token: string;
        let prf: string | undefined;
        if (prfSalt) {
          const first = cred.getClientExtensionResults()?.prf?.results?.first;
          if (first) prf = btoa(String.fromCharCode(...new Uint8Array(first)));
          token = JSON.stringify({
            id: cred.id,
            rawId: enc(cred.rawId),
            type: cred.type,
            extensions: {},
            response: {
              authenticatorData: enc(cred.response.authenticatorData),
              signature: enc(cred.response.signature),
              clientDataJSON: enc(cred.response.clientDataJSON),
              userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : null,
            },
          });
        } else
          token = JSON.stringify({
            id: cred.id,
            rawId: enc(cred.rawId),
            type: cred.type,
            extensions: cred.getClientExtensionResults(),
            response: {
              authenticatorData: enc(cred.response.authenticatorData),
              clientDataJson: enc(cred.response.clientDataJSON),
              signature: enc(cred.response.signature),
            },
          });
        host.remove();
        resolve({ ok: true, token, prf });
      } catch (e: any) {
        errEl.textContent = (e && (e.message || e.name)) || text.error;
      }
    };
    root.getElementById("go")!.addEventListener("click", run);
    root.getElementById("cancel")!.addEventListener("click", () => {
      host.remove();
      resolve({ ok: false, error: "abgebrochen" });
    });
    // try right away (works when the tab has focus), the button remains as fallback
    setTimeout(run, 300);
  });
}
