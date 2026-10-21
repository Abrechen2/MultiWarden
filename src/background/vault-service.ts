// Core multi-account state: login, unlock/lock, sync, decrypted vault, item changes.
import {
  argon2Key,
  decryptKey,
  decryptString,
  decryptUserKeyWithMasterKey,
  deriveMasterKey,
  masterPasswordHash,
  stretchMasterKey,
  deserializeKey,
  encryptKey,
  encryptFileData,
  rsaEncryptKey,
  publicKeyFromPrivate,
  encryptString,
  decryptFileData,
  generateCbcHmacKey,
  KdfConfig,
  serializeKey,
  stretchKey,
  SymKey,
} from "../crypto/bw";
import { b64decode, b64encode, equalBytes, randomBytes } from "../crypto/utils";
import type { SerializedKey } from "../crypto/bw";
import { newGuid } from "../crypto/utils";
import type { PageMatch, UnlockResult } from "../shared/messages";
import {
  ACCOUNT_COLORS,
  AccountPublic,
  AccountRecord,
  CipherType,
  DEFAULT_SETTINGS,
  ItemView,
  SERVER_PRESETS,
  ServerType,
  ServerUrls,
  Settings,
  UriMatch,
  VaultData,
  selfHostedUrls,
} from "../shared/types";
import { makeMatchContext, uriMatches } from "../shared/uri";
import { AccountApi, bearerJson, camelize, CLIENT_NAME, decodeJwt, HttpError, sendBody } from "./api";
import { local, session } from "./store";
import { buildExport, decryptExport, ExportContext, ExportFormat, plainPasskeys } from "./transfer";
import { mergePolicies, MpPolicy } from "../shared/mp-policy";
import { EventCollector } from "./events";
import {
  accountPolicies,
  applicablePolicies,
  clampTimeout,
  isRestricted,
  mergeGeneratorPolicies,
  personalItemAllowed,
  mergeTimeoutPolicies,
  PolicyType,
} from "../shared/policies";
import { fingerprintPhrase } from "../crypto/fingerprint";
import { buildSendRequest, decryptSend, sendUrlBase } from "./sends";
import { SendEdit, SendListResponse, SendType, SendView } from "../shared/sends";

export interface AuthRequestView {
  accountKey: string;
  id: string;
  device: string;
  ip: string;
  created: number;
  fingerprint: string;
  /** requesting device's public key (base64 SPKI) the fingerprint was made from */
  publicKey: string;
}
import {
  AccountKeys,
  buildCipherRequest,
  cipherKeyFor,
  decryptCipher,
  decryptVault,
  DecryptedVault,
  PasskeyPlain,
  deriveAccountKeys,
  encryptFolderName,
} from "./vault-crypto";

import { t } from "../shared/i18n";
interface UnlockedState {
  userKey: SymKey;
  keys?: AccountKeys;
  vault?: DecryptedVault;
  decrypting?: Promise<DecryptedVault>;
}

export type BroadcastFn = (event: "stateChanged" | "vaultChanged" | "sendsChanged" | "locked") => void;

/** Self-hosted servers whose services run under other URLs (custom environment), by server URL. */
let customEnvs: Record<string, Partial<ServerUrls>> = {};

export function envKey(baseUrl: string): string {
  return selfHostedUrls(baseUrl).base!.toLowerCase();
}

export function customEnvFor(baseUrl: string): Partial<ServerUrls> | undefined {
  return customEnvs[envKey(baseUrl)];
}

export async function loadCustomEnvs() {
  customEnvs = (await local.get<Record<string, Partial<ServerUrls>>>("customEnvs")) ?? {};
}

/** Save (or with an empty object remove) the custom URLs of a self-hosted server. */
export async function setCustomEnv(baseUrl: string, env: Partial<ServerUrls>) {
  const clean: Partial<ServerUrls> = {};
  for (const k of ["webVault", "api", "identity", "icons", "notifications", "events"] as const) {
    const v = (env[k] ?? "").trim().replace(/\/+$/, "");
    if (!v) continue;
    if (!/^https?:\/\//i.test(v)) throw new Error(t("Ungültige URL: {url}", { url: v }));
    clean[k] = v;
  }
  const k = envKey(baseUrl);
  if (Object.keys(clean).length) customEnvs[k] = clean;
  else delete customEnvs[k];
  await local.set("customEnvs", customEnvs);
}

export function urlsFor(server: ServerType, baseUrl?: string): ServerUrls {
  if (server === "selfhosted") {
    if (!baseUrl) throw new Error(t("Bitte die Server-URL angeben"));
    return { ...selfHostedUrls(baseUrl), ...(customEnvFor(baseUrl) ?? {}) };
  }
  const p = SERVER_PRESETS[server];
  return { api: p.api, identity: p.identity, icons: p.icons, webVault: p.webVault, events: p.events, notifications: p.notifications };
}

export function accountKeyFor(urls: ServerUrls, userId: string) {
  return `${new URL(urls.identity).host}|${userId}`;
}

export interface CompleteLoginParams {
  server: ServerType;
  urls: ServerUrls;
  email: string;
  token: any;
  userKey: SymKey;
  decryption: "masterPassword" | "tde" | "keyConnector";
  hasMasterPassword: boolean;
  kdf?: KdfConfig;
  salt?: string;
  encUserKey?: string;
  ssoOrgIdentifier?: string;
  keyConnectorUrl?: string;
}

/** Two base64 keys hold the same bytes (false if either is not valid base64). */
function sameKey(a: string, b: string): boolean {
  try {
    return equalBytes(b64decode(a), b64decode(b));
  } catch {
    return false;
  }
}

function serverLabel(acc: AccountRecord): string {
  if (acc.server === "us") return "bitwarden.com";
  if (acc.server === "eu") return "bitwarden.eu";
  try {
    return new URL(acc.urls.base ?? acc.urls.webVault).host;
  } catch {
    return acc.urls.webVault;
  }
}

export function initialsOf(acc: Pick<AccountRecord, "email" | "name" | "label">): string {
  const src = (acc.label || acc.name || acc.email || "?").trim();
  const words = src.split(/[\s@._-]+/).filter(Boolean);
  if (acc.label && acc.label.length <= 3) return acc.label.toUpperCase();
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * Like the official clients: an SSO login of a member (not owner/admin) of an organization that uses
 * Key Connector, who still has a master password, has to remove it or leave the organization.
 */
function kcMigrationOf(acc: AccountRecord, sync: any, hasMp: boolean): AccountRecord["kcMigration"] {
  if (!acc.ssoOrgIdentifier || !hasMp || sync.profile?.usesKeyConnector) return undefined;
  const o = (sync.profile?.organizations ?? []).find(
    (x: any) => x.keyConnectorEnabled && x.keyConnectorUrl && x.type !== 0 && x.type !== 1 && !x.isProviderUser,
  );
  return o ? { orgId: o.id, orgName: o.name ?? "", url: String(o.keyConnectorUrl).replace(/\/+$/, "") } : undefined;
}

export class VaultService {
  /** event logs of organizations */
  readonly events: EventCollector = new EventCollector(this);
  accounts: AccountRecord[] = [];
  settings: Settings = { ...DEFAULT_SETTINGS };
  deviceId = "";
  private unlocked = new Map<string, UnlockedState>();
  private apis = new Map<string, AccountApi>();
  private syncing = new Map<string, Promise<void>>();
  private syncErrors = new Map<string, string>();
  private lastUsed = new Map<string, Record<string, number>>();
  /** pending security tasks "update at-risk credential" of the organizations (Access Intelligence) */
  private tasks = new Map<string, { id: string; cipherId: string; organizationId?: string }[]>();
  readonly ready: Promise<void>;

  constructor(private broadcast: BroadcastFn) {
    this.ready = this.init();
  }

  private async init() {
    this.accounts = (await local.get<AccountRecord[]>("accounts")) ?? [];
    await loadCustomEnvs();
    this.settings = { ...DEFAULT_SETTINGS, ...((await local.get<Settings>("settings")) ?? {}) };
    // the "Bitwarden" colour scheme was removed in 1.2.1
    if ((this.settings.colorScheme as string) === "bitwarden") {
      this.settings = { ...this.settings, colorScheme: "multiwarden" };
      await local.set("settings", this.settings);
    }
    let dev = await local.get<string>("deviceId");
    if (!dev) {
      dev = newGuid();
      await local.set("deviceId", dev);
    }
    this.deviceId = dev;
    for (const acc of this.accounts) {
      let sk = await session.get<any>("uk:" + acc.key);
      // vault timeout "never": the key survives browser restarts (like the official extension)
      if (!sk && this.settings.vaultTimeout === "never") {
        sk = await local.get<any>("ukNever:" + acc.key);
        if (sk) await session.set("uk:" + acc.key, sk);
      }
      if (sk) this.unlocked.set(acc.key, { userKey: deserializeKey(sk) });
      this.lastUsed.set(acc.key, (await local.get<Record<string, number>>("lastUsed:" + acc.key)) ?? {});
    }
    await this.loadPinState();
    for (const a of this.accounts) {
      const tl = await local.get<{ id: string; cipherId: string }[]>("tasks:" + a.key);
      if (tl?.length) this.tasks.set(a.key, tl);
    }
  }

  // -------------------------------------------------------------------------------------------
  // state

  isUnlocked(key: string) {
    return this.unlocked.has(key);
  }

  anyUnlocked() {
    return this.unlocked.size > 0;
  }

  get sortedAccounts(): AccountRecord[] {
    return [...this.accounts].sort((a, b) => a.order - b.order || a.addedAt - b.addedAt);
  }

  publicAccounts(): AccountPublic[] {
    return this.sortedAccounts.map((a) => ({
      key: a.key,
      id: a.id,
      email: a.email,
      name: a.name,
      server: a.server,
      serverLabel: serverLabel(a),
      webVault: a.urls.webVault,
      iconsUrl: a.urls.icons,
      color: a.color,
      label: a.label || a.email,
      initials: initialsOf(a),
      status: a.needsLogin ? "loggedOut" : this.unlocked.has(a.key) ? "unlocked" : "locked",
      hasMasterPassword: this.hasMp(a),
      decryption: a.decryption ?? "masterPassword",
      sso: !!a.ssoOrgIdentifier,
      pinUnlock: this.settings.pinEnabled && this.pinEnvKeys.has(a.key),
      bioUnlock: !!this.settings.biometric && this.bioEnvKeys.has(a.key),
      forcePasswordChange: a.forcePasswordChange,
      kcMigration: a.kcMigration,
      policies: a.policies,
      atRisk: this.tasks.get(a.key)?.map((x) => x.cipherId),
      lastSync: a.lastSync,
      syncing: this.syncing.has(a.key),
      syncError: this.syncErrors.get(a.key),
      itemCount: this.unlocked.get(a.key)?.vault?.items.filter((i) => !i.deletedDate).length,
    }));
  }

  private async saveAccounts() {
    await local.set("accounts", this.accounts);
  }

  private account(key: string): AccountRecord {
    const a = this.accounts.find((x) => x.key === key);
    if (!a) throw new Error(t("Unbekanntes Konto"));
    return a;
  }

  private api(acc: AccountRecord): AccountApi {
    let api = this.apis.get(acc.key);
    if (!api) {
      api = new AccountApi(
        acc,
        async () => {
          await this.saveAccounts();
        },
        async (a) => {
          a.needsLogin = true;
          a.accessToken = undefined;
          a.refreshToken = undefined;
          await this.saveAccounts();
          // session is gone on the server: drop the keys too, the user has to log in again
          await this.lock(a.key);
        },
      );
      this.apis.set(acc.key, api);
    }
    return api;
  }

  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    if (patch.vaultTimeout !== undefined) patch.vaultTimeout = clampTimeout(patch.vaultTimeout, this.timeoutPolicy());
    this.settings = { ...this.settings, ...patch };
    await local.set("settings", this.settings);
    this.broadcast("stateChanged");
    return this.settings;
  }

  async updateAccount(key: string, patch: { label?: string; color?: string }) {
    const a = this.account(key);
    if (patch.label !== undefined) a.label = patch.label.trim() || undefined;
    if (patch.color) a.color = patch.color;
    await this.saveAccounts();
    this.broadcast("stateChanged");
  }

  async moveAccount(key: string, dir: -1 | 1) {
    const list = this.sortedAccounts;
    const i = list.findIndex((a) => a.key === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((a, idx) => (a.order = idx));
    await this.saveAccounts();
    this.broadcast("stateChanged");
  }

  // -------------------------------------------------------------------------------------------
  // login completion (the interactive login flows live in login-flow.ts)

  /** Persist a successfully authenticated account and unlock it with its user key. */
  async completeLogin(p: CompleteLoginParams): Promise<string> {
    await this.ready;
    const j = p.token;
    const claims = decodeJwt(j.access_token);
    const userId: string = claims.sub;
    if (!userId) throw new Error(t("Ungültige Antwort vom Server (kein Benutzer)"));
    const key = accountKeyFor(p.urls, userId);
    const existing = this.accounts.find((a) => a.key === key);
    const usedColors = new Set(this.accounts.map((a) => a.color));
    const acc: AccountRecord = {
      ...(existing ?? {}),
      id: userId,
      key,
      email: (claims.email as string) ?? p.email,
      name: claims.name ?? existing?.name,
      server: p.server,
      urls: p.urls,
      decryption: p.decryption,
      hasMasterPassword: p.hasMasterPassword,
      ssoOrgIdentifier: p.ssoOrgIdentifier ?? existing?.ssoOrgIdentifier,
      keyConnectorUrl: p.keyConnectorUrl,
      kdf: p.kdf ?? existing?.kdf ?? { kdf: 0, iterations: 600000 },
      salt: p.salt ?? existing?.salt ?? (p.email || "").toLowerCase(),
      encUserKey: p.encUserKey ?? existing?.encUserKey ?? "",
      accessToken: j.access_token,
      accessTokenExp: claims.exp ?? Date.now() / 1000 + (j.expires_in ?? 3600),
      refreshToken: j.refresh_token ?? existing?.refreshToken,
      clientId: CLIENT_NAME,
      color:
        existing?.color ?? ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[this.accounts.length % ACCOUNT_COLORS.length],
      order: existing?.order ?? this.accounts.reduce((m, a) => Math.max(m, a.order), -1) + 1,
      addedAt: existing?.addedAt ?? Date.now(),
      needsLogin: false,
    };
    if (existing) Object.assign(existing, acc);
    else this.accounts.push(acc);
    this.apis.delete(key);
    await this.saveAccounts();
    await this.setUnlocked(key, p.userKey);
    this.broadcast("stateChanged");
    try {
      await this.sync(key);
    } catch {
      /* error recorded in syncErrors */
    }
    return key;
  }

  async setForcePasswordChange(key: string, v: "temp" | "weak" | undefined) {
    const a = this.account(key);
    if (a.forcePasswordChange === v) return;
    a.forcePasswordChange = v;
    await this.saveAccounts();
    this.broadcast("stateChanged");
  }

  /** Strictest master password policy of the account's organizations (policy type 1). */
  async masterPasswordPolicy(accountKey: string): Promise<MpPolicy | null> {
    const data = await this.rawSync(accountKey);
    return mergePolicies(applicablePolicies(camelize(data), PolicyType.MasterPassword).map((p) => camelize(p.data) as MpPolicy));
  }

  private kdfJson(kdf: KdfConfig) {
    return kdf.kdf === 1
      ? { kdfType: 1, iterations: kdf.iterations, memory: kdf.memory, parallelism: kdf.parallelism }
      : { kdfType: 0, iterations: kdf.iterations };
  }

  /** New master key data for a password (same KDF and salt; the user key stays the same). */
  private async newMasterKeyData(acc: AccountRecord, userKey: SymKey, password: string) {
    const mk = await deriveMasterKey(password, acc.salt, acc.kdf);
    const hash = await masterPasswordHash(mk, password);
    const key = await encryptKey(userKey, await stretchMasterKey(mk));
    const kdf = this.kdfJson(acc.kdf);
    return {
      hash,
      key,
      authenticationData: { salt: acc.salt, kdf, masterPasswordAuthenticationHash: hash },
      unlockData: { salt: acc.salt, kdf, masterKeyWrappedUserKey: key },
    };
  }

  /** Change the master password (POST /accounts/password). */
  async changeMasterPassword(accountKey: string, current: string, next: string, hint: string): Promise<{ relogin: boolean }> {
    const acc = this.account(accountKey);
    if (!this.hasMp(acc)) throw new Error(t("Dieses Konto hat kein Master-Passwort"));
    let userKey: SymKey;
    let currentHash: string;
    try {
      const mk = await deriveMasterKey(current, acc.salt, acc.kdf);
      userKey = await decryptUserKeyWithMasterKey(acc.encUserKey, mk);
      currentHash = await masterPasswordHash(mk, current);
    } catch {
      throw new Error(t("Das aktuelle Master-Passwort ist falsch"));
    }
    if (current === next) throw new Error(t("Das neue Master-Passwort muss sich vom aktuellen unterscheiden"));
    const n = await this.newMasterKeyData(acc, userKey, next);
    await this.api(acc).send("POST", "/accounts/password", {
      masterPasswordHash: currentHash,
      masterPasswordHint: hint.trim() || null,
      newMasterPasswordHash: n.hash,
      key: n.key,
      authenticationData: n.authenticationData,
      unlockData: n.unlockData,
    });
    return this.afterPasswordChange(acc, n.key, userKey);
  }

  /** A temporary password set by an administrator (account recovery) is replaced by the user. */
  async updateTempPassword(accountKey: string, next: string, hint: string): Promise<{ relogin: boolean }> {
    const acc = this.account(accountKey);
    const st = this.unlocked.get(accountKey);
    if (!st) throw new Error(t("Konto ist gesperrt"));
    const n = await this.newMasterKeyData(acc, st.userKey, next);
    await this.api(acc).send("PUT", "/accounts/update-temp-password", {
      masterPasswordHint: hint.trim() || null,
      newMasterPasswordHash: n.hash,
      key: n.key,
      authenticationData: n.authenticationData,
      unlockData: n.unlockData,
    });
    return this.afterPasswordChange(acc, n.key, st.userKey);
  }

  private async afterPasswordChange(acc: AccountRecord, encUserKey: string, _userKey: SymKey): Promise<{ relogin: boolean }> {
    acc.encUserKey = encUserKey;
    acc.hasMasterPassword = true;
    acc.forcePasswordChange = undefined;
    await this.saveAccounts();
    // the server ends all sessions (security stamp, refresh tokens): the caller logs in again with the new password
    this.apis.delete(acc.key);
    return { relogin: true };
  }

  /**
   * Key Connector migration: the master key moves to the organization's key server and the account
   * no longer has a master password (official: "Remove master password").
   */
  async removeMasterPassword(accountKey: string, password: string) {
    const acc = this.account(accountKey);
    const m = acc.kcMigration;
    if (!m) throw new Error(t("Für dieses Konto ist das nicht nötig"));
    let mk: Uint8Array;
    try {
      mk = await deriveMasterKey(password, acc.salt, acc.kdf);
      await decryptUserKeyWithMasterKey(acc.encUserKey, mk);
    } catch {
      throw new Error(t("Falsches Master-Passwort"));
    }
    const api = this.api(acc);
    try {
      await bearerJson(m.url + "/user-keys", await api.accessToken(), "POST", { key: b64encode(mk) });
    } catch (e: any) {
      throw new Error(t("Key Connector nicht erreichbar: {error}", { error: e?.message ?? String(e) }));
    }
    await api.send("POST", "/accounts/convert-to-key-connector");
    acc.hasMasterPassword = false;
    acc.decryption = "keyConnector";
    acc.keyConnectorUrl = m.url;
    acc.kcMigration = undefined;
    acc.forcePasswordChange = undefined;
    await this.saveAccounts();
    this.broadcast("stateChanged");
  }

  /** Leave an organization (POST /organizations/{id}/leave). */
  async leaveOrganization(accountKey: string, orgId: string) {
    const acc = this.account(accountKey);
    await this.api(acc).send("POST", `/organizations/${encodeURIComponent(orgId)}/leave`);
    if (acc.kcMigration?.orgId === orgId) acc.kcMigration = undefined;
    await this.saveAccounts();
    await this.sync(accountKey).catch(() => {});
    this.broadcast("stateChanged");
  }

  /** The silent re-login after a password change failed (e.g. two-step login needed). */
  async passwordChangeLoggedOut(key: string) {
    await this.softLogout(key);
  }

  /** Unlock an existing account with an already decrypted user key (SSO/TDE/Key Connector re-auth). */
  async unlockWithUserKey(key: string, userKey: SymKey, token?: any) {
    const acc = this.account(key);
    if (token?.access_token) {
      const claims = decodeJwt(token.access_token);
      acc.accessToken = token.access_token;
      acc.accessTokenExp = claims.exp ?? Date.now() / 1000 + (token.expires_in ?? 3600);
      if (token.refresh_token) acc.refreshToken = token.refresh_token;
      acc.needsLogin = false;
      this.apis.delete(key);
      await this.saveAccounts();
    }
    await this.setUnlocked(key, userKey);
    this.broadcast("stateChanged");
    this.ensureVault(key)
      .then(() => this.broadcast("vaultChanged"))
      .catch(() => {});
    this.sync(key).catch(() => {});
  }

  /** Authenticated request with the stored session of an account. */
  accountApi(key: string): AccountApi {
    return this.api(this.account(key));
  }

  getAccount(key: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.key === key);
  }

  async getUserKey(key: string): Promise<SymKey | undefined> {
    return this.unlocked.get(key)?.userKey;
  }

  // device keys (trusted device encryption)
  async getDeviceKey(key: string): Promise<SymKey | undefined> {
    const s = await local.get<any>("deviceKey:" + key);
    return s ? deserializeKey(s) : undefined;
  }

  async setDeviceKey(key: string, deviceKey: SymKey | undefined) {
    if (deviceKey) await local.set("deviceKey:" + key, serializeKey(deviceKey));
    else await local.remove("deviceKey:" + key);
  }

  // -------------------------------------------------------------------------------------------
  // lock / unlock

  private async setUnlocked(key: string, userKey: SymKey) {
    this.unlocked.set(key, { userKey });
    await session.set("uk:" + key, serializeKey(userKey));
    if (this.settings.vaultTimeout === "never") await local.set("ukNever:" + key, serializeKey(userKey));
    await this.touch();
    // keep PIN / biometric unlock available for every unlocked account (runs in the background)
    this.ensurePinEnvelope(key).catch((e) => console.warn("pin envelope", e));
    this.ensureBioEnvelope(key).catch((e) => console.warn("bio envelope", e));
  }

  /** Accounts that can be unlocked with the master password. */
  private hasMp(a: AccountRecord) {
    return a.hasMasterPassword !== false && !!a.encUserKey;
  }

  async unlock(password: string, keys?: string[]): Promise<UnlockResult[]> {
    await this.ready;
    const targets = this.sortedAccounts.filter(
      (a) => !a.needsLogin && this.hasMp(a) && !this.unlocked.has(a.key) && (!keys || keys.includes(a.key)),
    );
    const results = await Promise.all(
      targets.map(async (a): Promise<UnlockResult> => {
        try {
          const mk = await deriveMasterKey(password, a.salt, a.kdf);
          const uk = await decryptUserKeyWithMasterKey(a.encUserKey, mk);
          await this.setUnlocked(a.key, uk);
          return { accountKey: a.key, ok: true };
        } catch (e: any) {
          return { accountKey: a.key, ok: false, error: t("Falsches Master-Passwort") };
        }
      }),
    );
    this.afterUnlock(results);
    return results;
  }

  private afterUnlock(results: UnlockResult[]) {
    if (!results.some((r) => r.ok)) return;
    this.broadcast("stateChanged");
    // decrypt in background, then refresh from server
    for (const r of results.filter((x) => x.ok)) {
      this.ensureVault(r.accountKey)
        .then(() => this.broadcast("vaultChanged"))
        .catch(() => {});
      this.sync(r.accountKey).catch(() => {});
    }
  }

  async verifyPassword(key: string, password: string): Promise<boolean> {
    const a = this.account(key);
    if (!this.hasMp(a)) {
      // accounts without master password: verify with the PIN if there is one
      if (!this.settings.pinEnabled) return true;
      return this.verifyPin(key, password);
    }
    try {
      const mk = await deriveMasterKey(password, a.salt, a.kdf);
      await decryptUserKeyWithMasterKey(a.encUserKey, mk);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // organization policies

  // -------------------------------------------------------------------------------------------
  // security tasks: an organization asks the member to change at-risk passwords

  private async refreshTasks(key: string, sync?: any) {
    const data = camelize(sync ?? (await this.rawSync(key)));
    const enabled = (data.profile?.organizations ?? []).some((o: any) => o.useRiskInsights || o.useAccessIntelligence);
    let list: { id: string; cipherId: string; organizationId?: string }[] = [];
    if (enabled) {
      const r = await this.api(this.account(key)).send("GET", "/tasks");
      list = (r?.data ?? [])
        .filter((x: any) => x.status === 0 && x.type === 0 && x.cipherId)
        .map((x: any) => ({ id: x.id, cipherId: x.cipherId, organizationId: x.organizationId ?? undefined }));
    }
    const before = JSON.stringify(this.tasks.get(key) ?? []);
    if (list.length) this.tasks.set(key, list);
    else this.tasks.delete(key);
    if (list.length) await local.set("tasks:" + key, list);
    else await local.remove("tasks:" + key);
    if (before !== JSON.stringify(list)) this.broadcast("stateChanged");
  }

  /** The password of an item with a pending task was changed → the task is done (like the official client). */
  private async completeTasksFor(key: string, cipherId: string) {
    const open = (this.tasks.get(key) ?? []).filter((x) => x.cipherId === cipherId);
    if (!open.length) return;
    for (const tk of open) await this.api(this.account(key)).send("PATCH", `/tasks/${tk.id}/complete`);
    await this.refreshTasks(key);
  }

  // -------------------------------------------------------------------------------------------
  // live sync (server notifications)

  private pendingSync = new Map<string, ReturnType<typeof setTimeout>>();

  private syncSoon(key: string) {
    const prev = this.pendingSync.get(key);
    if (prev) clearTimeout(prev);
    this.pendingSync.set(
      key,
      setTimeout(() => {
        this.pendingSync.delete(key);
        this.sync(key).catch(() => {});
      }, 400),
    );
  }

  /** A change pushed by the server (made on another device). */
  async handleNotification(key: string, n: { contextId?: string | null; type: number; payload: any }): Promise<"authRequest" | void> {
    const acc = this.getAccount(key);
    if (!acc || acc.needsLogin) return;
    // our own change, already applied here
    if (n.contextId && n.contextId === this.deviceId) return;
    const p = n.payload ?? {};
    const userId = p.UserId ?? p.userId;
    if (userId && userId !== acc.id && n.type !== 6 && !(p.OrganizationId ?? p.organizationId)) return;
    switch (n.type) {
      case 0: // cipher updated
      case 1: {
        // cipher created
        const id = p.Id ?? p.id;
        if (id && this.unlocked.has(key)) await this.refreshCipher(key, id).catch(() => this.syncSoon(key));
        else this.syncSoon(key);
        return;
      }
      case 11: // log out (e.g. password changed / sessions ended elsewhere)
        await this.softLogout(key);
        return;
      case 15: // login request of another device
        return "authRequest";
      case 22:
        await this.refreshTasks(key).catch(() => {});
        return;
      case 16:
        return;
      default:
        // deletes, folders, organizations, settings, keys: full sync
        // 12–14: Sends created / changed (also when someone opens one) / deleted
        if ([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 17, 18, 19].includes(n.type)) this.syncSoon(key);
    }
  }

  /** Upload pending events before the session of an account ends (at most 3 s). */
  private async flushEvents(key: string) {
    await Promise.race([this.events.upload(key).catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }

  /** "Remove unlock with PIN" policy of the account's organizations. */
  pinBlocked(key: string): boolean {
    return !!this.getAccount(key)?.policies?.removePin;
  }

  /** The strictest maximum session timeout of all accounts (the timeout setting is global). */
  timeoutPolicy() {
    return mergeTimeoutPolicies(this.accounts.map((a) => a.policies?.maxTimeout));
  }

  private defaultMatchFor(key: string): UriMatch {
    const m = this.getAccount(key)?.policies?.uriMatch;
    return (m != null ? m : this.settings.defaultUriMatch) as UriMatch;
  }

  /** Items of a type that the account's organizations removed ("restricted item types") are hidden. */
  private restrictVault<T extends { items: ItemView[] }>(key: string, v: T): T {
    const p = this.getAccount(key)?.policies;
    if (!p?.restrictedTypes?.length) return v;
    return { ...v, items: v.items.filter((i) => !isRestricted(p, i.type, i.organizationId)) };
  }

  /** Effects of the policies after a sync: generator rules, timeout, PIN, "activate autofill". */
  async applyPolicies() {
    const gen = mergeGeneratorPolicies(this.accounts.map((a) => a.policies?.generator));
    if (gen) await local.set("generatorPolicy", gen);
    else await local.remove("generatorPolicy");
    let changed = false;
    const tx = clampTimeout(this.settings.vaultTimeout, this.timeoutPolicy());
    if (tx !== this.settings.vaultTimeout) {
      this.settings = { ...this.settings, vaultTimeout: tx };
      changed = true;
      await this.applyTimeoutSetting();
    }
    for (const a of this.accounts) {
      if (a.policies?.activateAutofill && !(await local.get("autofillActivated:" + a.key))) {
        // like the official client: turned on once, the user may switch it off again
        await local.set("autofillActivated:" + a.key, true);
        if (!this.settings.autofillOnPageLoad) {
          this.settings = { ...this.settings, autofillOnPageLoad: true };
          changed = true;
        }
      }
      if (a.policies?.removePin && this.pinEnvKeys.has(a.key)) {
        await local.remove(["pinEnv:" + a.key, "encPin:" + a.key]);
        await session.remove("pinEnv:" + a.key);
        this.pinEnvKeys.delete(a.key);
        changed = true;
      }
    }
    if (changed) {
      await local.set("settings", this.settings);
      this.broadcast("stateChanged");
    }
  }

  // -------------------------------------------------------------------------------------------
  // PIN unlock

  private pinEnvKeys = new Set<string>();

  private pinStore() {
    return this.settings.pinLockAfterRestart ? session : local;
  }

  private async loadPinState() {
    this.bioEnvKeys.clear();
    if (this.settings.biometric) for (const a of this.accounts) if (await local.get("bioEnv:" + a.key)) this.bioEnvKeys.add(a.key);
    this.pinEnvKeys.clear();
    if (!this.settings.pinEnabled) return;
    for (const a of this.accounts) {
      if (await this.pinStore().get("pinEnv:" + a.key)) this.pinEnvKeys.add(a.key);
    }
  }

  private async derivePinKey(pin: string): Promise<SymKey> {
    const saltB64 = await local.get<string>("pinSalt");
    if (!saltB64) throw new Error(t("Keine PIN eingerichtet"));
    return stretchKey(await argon2Key(pin, b64decode(saltB64)));
  }

  async setPin(pin: string, lockAfterRestart: boolean) {
    await this.ready;
    if (!/^\S{4,}$/.test(pin)) throw new Error(t("Die PIN muss mindestens 4 Zeichen lang sein"));
    if (!this.unlocked.size) throw new Error(t("Bitte zuerst entsperren"));
    await this.disablePin(false);
    await local.set("pinSalt", b64encode(randomBytes(16)));
    this.settings = { ...this.settings, pinEnabled: true, pinLockAfterRestart: lockAfterRestart };
    await local.set("settings", this.settings);
    const pinKey = await this.derivePinKey(pin);
    await session.set("pinKey", serializeKey(pinKey));
    for (const [key, st] of this.unlocked) {
      if (this.pinBlocked(key)) continue;
      await this.pinStore().set("pinEnv:" + key, await encryptKey(st.userKey, pinKey));
      await local.set("encPin:" + key, await encryptString(pin, st.userKey));
      this.pinEnvKeys.add(key);
    }
    await local.set("pinFails", 0);
    this.broadcast("stateChanged");
  }

  async disablePin(broadcast = true) {
    const keys = this.accounts.flatMap((a) => ["pinEnv:" + a.key, "encPin:" + a.key]);
    await local.remove([...keys, "pinSalt", "pinFails"]);
    await session.remove([...keys, "pinKey"]);
    this.pinEnvKeys.clear();
    if (this.settings.pinEnabled) {
      this.settings = { ...this.settings, pinEnabled: false };
      await local.set("settings", this.settings);
    }
    if (broadcast) this.broadcast("stateChanged");
  }

  /** Create the PIN envelope for an account that was unlocked by other means. */
  private async ensurePinEnvelope(key: string) {
    if (!this.settings.pinEnabled || this.pinEnvKeys.has(key) || this.pinBlocked(key)) return;
    const st = this.unlocked.get(key);
    if (!st) return;
    let pinKeyS = await session.get<any>("pinKey");
    let pin: string | undefined;
    if (!pinKeyS) {
      // recover the PIN from any unlocked account (it is stored encrypted with each user key)
      for (const [k, u] of this.unlocked) {
        const enc = await local.get<string>("encPin:" + k);
        if (!enc) continue;
        try {
          pin = await decryptString(enc, u.userKey);
          break;
        } catch {
          /* try next */
        }
      }
      if (!pin) return;
      const pk = await this.derivePinKey(pin);
      pinKeyS = serializeKey(pk);
      await session.set("pinKey", pinKeyS);
    }
    const pinKey = deserializeKey(pinKeyS);
    await this.pinStore().set("pinEnv:" + key, await encryptKey(st.userKey, pinKey));
    if (!(await local.get("encPin:" + key))) {
      if (!pin) {
        // envelope of another account gives us nothing about the PIN text; skip encPin then
      } else await local.set("encPin:" + key, await encryptString(pin, st.userKey));
    }
    this.pinEnvKeys.add(key);
    // other unlocked accounts without envelope (e.g. after restart in session mode)
    for (const k of this.unlocked.keys()) if (!this.pinEnvKeys.has(k) && !this.pinBlocked(k)) await this.ensurePinEnvelope(k);
    this.broadcast("stateChanged");
  }

  /**
   * User verification (e.g. for passkeys) with the master password or – if PIN unlock is set up –
   * the PIN. Wrong PINs count towards the lock-out like on the lock screen.
   */
  async verifyUser(key: string, secret: string, mode: "mp" | "pin"): Promise<boolean> {
    const a = this.account(key);
    if (!secret) return false;
    if (mode === "mp") {
      if (!this.hasMp(a)) return false;
      try {
        const mk = await deriveMasterKey(secret, a.salt, a.kdf);
        await decryptUserKeyWithMasterKey(a.encUserKey, mk);
        return true;
      } catch {
        return false;
      }
    }
    if (!this.settings.pinEnabled || !this.pinEnvKeys.has(key)) return false;
    if (await this.verifyPin(key, secret)) {
      await local.set("pinFails", 0);
      return true;
    }
    const fails = ((await local.get<number>("pinFails")) ?? 0) + 1;
    await local.set("pinFails", fails);
    if (fails >= 5) await this.disablePin();
    return false;
  }

  /** Which secret can verify the user of an account. */
  verificationMethods(key: string): { mp: boolean; pin: boolean } {
    const a = this.account(key);
    return { mp: this.hasMp(a), pin: this.settings.pinEnabled && this.pinEnvKeys.has(key) };
  }

  private async verifyPin(key: string, pin: string): Promise<boolean> {
    const env = await this.pinStore().get<string>("pinEnv:" + key);
    if (!env) return false;
    try {
      await decryptKey(env, await this.derivePinKey(pin));
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // biometrics / security key (WebAuthn PRF): the PRF output of a credential wraps the user keys

  private bioEnvKeys = new Set<string>();

  private async bioKeyFromPrf(prfB64: string): Promise<SymKey> {
    const prf = b64decode(prfB64);
    if (prf.length < 32) throw new Error(t("Ungültige Antwort des Authenticators"));
    return stretchKey(prf.slice(0, 32));
  }

  async enableBiometric(credentialId: string, salt: string, prfB64: string) {
    if (!this.unlocked.size) throw new Error(t("Bitte zuerst entsperren"));
    const bioKey = await this.bioKeyFromPrf(prfB64);
    await local.remove(this.accounts.map((a) => "bioEnv:" + a.key));
    this.bioEnvKeys.clear();
    for (const [k, st] of this.unlocked) {
      await local.set("bioEnv:" + k, await encryptKey(st.userKey, bioKey));
      this.bioEnvKeys.add(k);
    }
    await session.set("bioKey", serializeKey(bioKey));
    this.settings = { ...this.settings, biometric: { credentialId, salt } };
    await local.set("settings", this.settings);
    this.broadcast("stateChanged");
  }

  async disableBiometric() {
    await local.remove(this.accounts.map((a) => "bioEnv:" + a.key));
    this.bioEnvKeys.clear();
    await session.remove("bioKey");
    this.settings = { ...this.settings, biometric: null };
    await local.set("settings", this.settings);
    this.broadcast("stateChanged");
  }

  async unlockWithBiometric(prfB64: string): Promise<{ results: UnlockResult[]; error?: string }> {
    await this.ready;
    if (!this.settings.biometric) return { results: [], error: t("Biometrische Entsperrung ist nicht eingerichtet") };
    const bioKey = await this.bioKeyFromPrf(prfB64);
    const results: UnlockResult[] = [];
    for (const a of this.sortedAccounts.filter((x) => !x.needsLogin && !this.unlocked.has(x.key))) {
      const env = await local.get<string>("bioEnv:" + a.key);
      if (!env) continue;
      try {
        await this.setUnlocked(a.key, await decryptKey(env, bioKey));
        results.push({ accountKey: a.key, ok: true });
      } catch {
        results.push({ accountKey: a.key, ok: false, error: t("Entsperren fehlgeschlagen") });
      }
    }
    if (!results.length) return { results, error: t("Für die gesperrten Konten ist keine biometrische Entsperrung eingerichtet") };
    if (results.some((r) => r.ok)) await session.set("bioKey", serializeKey(bioKey));
    this.afterUnlock(results);
    return { results };
  }

  /** Accounts unlocked another way get their envelope as soon as the key is known in this session. */
  private async ensureBioEnvelope(key: string) {
    if (!this.settings.biometric) return;
    const st = this.unlocked.get(key);
    const bk = await session.get<any>("bioKey");
    if (!st || !bk || this.bioEnvKeys.has(key)) return;
    await local.set("bioEnv:" + key, await encryptKey(st.userKey, deserializeKey(bk)));
    this.bioEnvKeys.add(key);
    this.broadcast("stateChanged");
  }

  biometricAccounts(): string[] {
    return this.accounts.filter((a) => this.bioEnvKeys.has(a.key)).map((a) => a.key);
  }

  async unlockWithPin(pin: string): Promise<{ results: UnlockResult[]; error?: string }> {
    await this.ready;
    if (!this.settings.pinEnabled) return { results: [], error: t("PIN-Entsperrung ist nicht eingerichtet") };
    const targets = this.sortedAccounts.filter((a) => !a.needsLogin && !this.unlocked.has(a.key) && this.pinEnvKeys.has(a.key));
    if (!targets.length) return { results: [], error: t("Für die gesperrten Konten ist keine PIN hinterlegt") };
    const pinKey = await this.derivePinKey(pin);
    const results: UnlockResult[] = [];
    for (const a of targets) {
      const env = await this.pinStore().get<string>("pinEnv:" + a.key);
      try {
        const uk = await decryptKey(env!, pinKey);
        await this.setUnlocked(a.key, uk);
        results.push({ accountKey: a.key, ok: true });
      } catch {
        results.push({ accountKey: a.key, ok: false, error: t("Falsche PIN") });
      }
    }
    if (results.some((r) => r.ok)) {
      await session.set("pinKey", serializeKey(pinKey));
      await local.set("pinFails", 0);
    } else {
      const fails = ((await local.get<number>("pinFails")) ?? 0) + 1;
      await local.set("pinFails", fails);
      if (fails >= 5) {
        await this.disablePin();
        return { results, error: t("Zu viele Fehlversuche – die PIN wurde deaktiviert. Bitte mit Master-Passwort bzw. SSO entsperren.") };
      }
      return { results, error: t("Falsche PIN ({n} Versuche übrig)", { n: 5 - fails }) };
    }
    this.afterUnlock(results);
    return { results };
  }

  async setPinLockAfterRestart(v: boolean) {
    if (v === this.settings.pinLockAfterRestart) return;
    const from = this.pinStore();
    this.settings = { ...this.settings, pinLockAfterRestart: v };
    await local.set("settings", this.settings);
    const to = this.pinStore();
    for (const a of this.accounts) {
      const env = await from.get<string>("pinEnv:" + a.key);
      if (env) {
        await to.set("pinEnv:" + a.key, env);
        await from.remove("pinEnv:" + a.key);
      }
    }
  }

  async lock(key?: string) {
    await this.ready;
    const keys = key ? [key] : [...this.unlocked.keys()];
    for (const k of keys) {
      this.unlocked.delete(k);
      await session.remove(["uk:" + k, "dv:" + k]);
      await local.remove("ukNever:" + k);
    }
    if (!this.unlocked.size) await session.remove(["pinKey", "bioKey"]);
    this.broadcast("locked");
    this.broadcast("stateChanged");
  }

  async logout(key: string) {
    await this.flushEvents(key);
    await this.lock(key);
    this.accounts = this.accounts.filter((a) => a.key !== key);
    this.apis.delete(key);
    this.syncErrors.delete(key);
    this.lastUsed.delete(key);
    this.pinEnvKeys.delete(key);
    await this.saveAccounts();
    await local.remove([
      "sync:" + key,
      "lastUsed:" + key,
      "pinEnv:" + key,
      "encPin:" + key,
      "deviceKey:" + key,
      "secretStore:" + key,
      "ukNever:" + key,
      "bioEnv:" + key,
      "autofillActivated:" + key,
      "tasks:" + key,
    ]);
    this.tasks.delete(key);
    this.bioEnvKeys.delete(key);
    await session.remove(["pinEnv:" + key]);
    this.broadcast("stateChanged");
    this.broadcast("vaultChanged");
  }

  async touch() {
    await session.set("lastActivity", Date.now());
  }

  async checkTimeout() {
    await this.ready;
    const tx = this.settings.vaultTimeout;
    if (typeof tx !== "number" || this.unlocked.size === 0) return;
    const last = (await session.get<number>("lastActivity")) ?? 0;
    if (Date.now() - last > tx * 60_000) await this.timeoutAction();
  }

  /**
   * Vault timeout reached: lock, or log out (keep the account in the list, sign in again).
   * A maximum session timeout policy of an organization can prescribe the action for its account.
   */
  async timeoutAction() {
    for (const a of this.accounts.filter((x) => !x.needsLogin)) {
      const pa = a.policies?.maxTimeout?.action;
      const action = pa === "logOut" ? "logout" : pa === "lock" ? "lock" : this.settings.vaultTimeoutAction;
      if (action === "logout") await this.softLogout(a.key);
      else if (this.unlocked.has(a.key)) await this.lock(a.key);
    }
  }

  /** Logged out but still listed: tokens, keys and the local vault copy are removed. */
  async softLogout(key: string) {
    await this.flushEvents(key);
    const a = this.account(key);
    await this.lock(key);
    a.accessToken = undefined;
    a.accessTokenExp = undefined;
    a.refreshToken = undefined;
    a.needsLogin = true;
    this.apis.delete(key);
    await this.saveAccounts();
    await local.remove(["sync:" + key]);
    this.broadcast("stateChanged");
  }

  /** Called when the vault timeout setting changes ("never" keeps the keys across restarts). */
  async applyTimeoutSetting() {
    if (this.settings.vaultTimeout === "never") {
      for (const [k, st] of this.unlocked) await local.set("ukNever:" + k, serializeKey(st.userKey));
    } else await local.remove(this.accounts.map((a) => "ukNever:" + a.key));
  }

  // -------------------------------------------------------------------------------------------
  // sync / decrypt

  async syncAll(): Promise<Record<string, string>> {
    await this.ready;
    const errors: Record<string, string> = {};
    await Promise.all(
      this.accounts
        .filter((a) => !a.needsLogin)
        .map((a) =>
          this.sync(a.key).catch((e) => {
            errors[a.key] = e?.message ?? String(e);
          }),
        ),
    );
    return errors;
  }

  sync(key: string): Promise<void> {
    const running = this.syncing.get(key);
    if (running) return running;
    const p = this.doSync(key).finally(() => {
      this.syncing.delete(key);
      this.broadcast("stateChanged");
    });
    this.syncing.set(key, p);
    this.broadcast("stateChanged");
    return p;
  }

  private async doSync(key: string) {
    const acc = this.account(key);
    if (acc.needsLogin) throw new Error(t("Bitte neu anmelden"));
    try {
      const data = await this.api(acc).send("GET", "/sync?excludeDomains=false");
      await local.set("sync:" + key, data);
      acc.lastSync = Date.now();
      if (data.profile?.email) acc.email = data.profile.email;
      if (data.profile?.name) acc.name = data.profile.name;
      let keyChanged = false;
      if (data.profile?.key && data.profile.key !== acc.encUserKey) {
        acc.encUserKey = data.profile.key;
        keyChanged = true;
      }
      acc.kcMigration = kcMigrationOf(acc, data, this.hasMp(acc));
      acc.policies = accountPolicies(camelize(data));
      this.refreshTasks(key, data).catch((e) => console.warn("tasks", e));
      acc.eventOrgs = (camelize(data).profile?.organizations ?? [])
        .filter((o: any) => o.useEvents && o.enabled !== false)
        .map((o: any) => o.id);
      await this.saveAccounts();
      await this.applyPolicies();
      this.syncErrors.delete(key);
      const st = this.unlocked.get(key);
      if (st) {
        try {
          const keys = await deriveAccountKeys(data, st.userKey);
          const vault = this.restrictVault(key, await decryptVault(key, data, keys));
          if (keyChanged && vault.items.length && vault.items.every((i) => i.decryptError)) {
            // user key was rotated elsewhere → need the password again
            await this.lock(key);
            return;
          }
          st.keys = keys;
          st.vault = vault;
          await this.cacheVault(key, vault);
          this.broadcast("vaultChanged");
          this.broadcast("sendsChanged");
        } catch (e) {
          console.warn("decrypt after sync failed", e);
        }
      }
    } catch (e: any) {
      const msg = e instanceof HttpError ? e.message : (e?.message ?? String(e));
      this.syncErrors.set(key, msg);
      throw e;
    }
  }

  private async cacheVault(key: string, vault: DecryptedVault) {
    try {
      const json = JSON.stringify(vault);
      if (json.length < 4_000_000) await session.set("dv:" + key, vault);
    } catch {
      /* quota – ignore */
    }
  }

  /** Make sure the decrypted vault for an unlocked account is in memory. */
  async ensureVault(key: string): Promise<DecryptedVault | undefined> {
    const st = this.unlocked.get(key);
    if (!st) return undefined;
    if (st.vault) return st.vault;
    if (!st.decrypting) {
      st.decrypting = (async () => {
        const cached = await session.get<DecryptedVault>("dv:" + key);
        if (cached) return cached;
        const data = camelize(await local.get<any>("sync:" + key));
        if (!data) return { items: [], folders: [], collections: [], organizations: [], equivalentDomains: [] };
        const keys = await this.ensureKeys(key, data);
        const v = this.restrictVault(key, await decryptVault(key, data, keys));
        await this.cacheVault(key, v);
        return v;
      })();
    }
    try {
      st.vault = await st.decrypting;
    } finally {
      st.decrypting = undefined;
    }
    return st.vault;
  }

  private async ensureKeys(key: string, data?: any): Promise<AccountKeys> {
    const st = this.unlocked.get(key);
    if (!st) throw new Error(t("Konto ist gesperrt"));
    if (!st.keys) {
      const d = data ?? camelize(await local.get<any>("sync:" + key));
      st.keys = await deriveAccountKeys(d ?? {}, st.userKey);
    }
    return st.keys;
  }

  async getVault(): Promise<VaultData> {
    await this.ready;
    const out: VaultData = { items: [], folders: [], collections: [], organizations: [] };
    for (const acc of this.sortedAccounts) {
      const v = await this.ensureVault(acc.key).catch(() => undefined);
      if (!v) continue;
      out.items.push(...v.items);
      out.folders.push(...v.folders);
      out.collections.push(...v.collections);
      out.organizations.push(...v.organizations);
    }
    return out;
  }

  /** User keys of all unlocked accounts (for the encrypted secret store of the extension). */
  unlockedUserKeys(): { accountKey: string; userKey: SymKey }[] {
    return this.sortedAccounts
      .filter((a) => this.unlocked.has(a.key))
      .map((a) => ({ accountKey: a.key, userKey: this.unlocked.get(a.key)!.userKey }));
  }

  async findItem(accountKey: string, id: string): Promise<ItemView | undefined> {
    const v = await this.ensureVault(accountKey);
    return v?.items.find((i) => i.id === id);
  }

  // -------------------------------------------------------------------------------------------
  // matching

  /** Logins matching a URL, most recently used first. `defaultMatch` overrides the default URI match setting. */
  async matchesForUrl(url: string, defaultMatch?: UriMatch): Promise<ItemView[]> {
    await this.ready;
    const result: ItemView[] = [];
    for (const acc of this.sortedAccounts) {
      const v = await this.ensureVault(acc.key).catch(() => undefined);
      if (!v) continue;
      const ctx = makeMatchContext(url, v.equivalentDomains);
      for (const it of v.items) {
        if (it.type !== CipherType.Login || it.deletedDate || it.archivedDate || !it.login) continue;
        const dm = defaultMatch ?? this.defaultMatchFor(acc.key);
        if (it.login.uris.some((u) => uriMatches(u.uri, u.match, ctx, dm))) result.push(it);
      }
    }
    result.sort((a, b) => this.lastUsedAt(b) - this.lastUsedAt(a) || a.name.localeCompare(b.name, "de"));
    return result;
  }

  lastUsedAt(i: { accountKey: string; id: string }): number {
    return this.lastUsed.get(i.accountKey)?.[i.id] ?? 0;
  }

  /** Active items of one type from all unlocked accounts, most recently used first. */
  async itemsOfType(type: CipherType): Promise<ItemView[]> {
    await this.ready;
    const result: ItemView[] = [];
    for (const acc of this.sortedAccounts) {
      const v = await this.ensureVault(acc.key).catch(() => undefined);
      if (!v) continue;
      for (const it of v.items) if (it.type === type && !it.deletedDate && !it.archivedDate && !it.decryptError) result.push(it);
    }
    result.sort((a, b) => this.lastUsedAt(b) - this.lastUsedAt(a) || a.name.localeCompare(b.name, "de"));
    return result;
  }

  itemMatchesUrl(item: ItemView, url: string): boolean {
    const v = this.unlocked.get(item.accountKey)?.vault;
    const ctx = makeMatchContext(url, v?.equivalentDomains ?? []);
    return !!item.login?.uris.some((u) => uriMatches(u.uri, u.match, ctx, this.defaultMatchFor(item.accountKey)));
  }

  async pageMatches(url: string): Promise<PageMatch> {
    const items = await this.matchesForUrl(url);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* ignore */
    }
    return { url, host, itemIds: items.map((i) => i.accountKey + "::" + i.id) };
  }

  async markUsed(accountKey: string, itemId: string) {
    const m = this.lastUsed.get(accountKey) ?? {};
    m[itemId] = Date.now();
    this.lastUsed.set(accountKey, m);
    await local.set("lastUsed:" + accountKey, m);
  }

  // -------------------------------------------------------------------------------------------
  // changes

  private async rawSync(key: string): Promise<any> {
    return camelize((await local.get<any>("sync:" + key)) ?? {});
  }

  private async applyCipher(key: string, raw: any) {
    const data = await this.rawSync(key);
    data.ciphers = (data.ciphers ?? []).filter((c: any) => c.id !== raw.id);
    data.ciphers.push(raw);
    await local.set("sync:" + key, data);
    const st = this.unlocked.get(key);
    if (st) {
      const keys = await this.ensureKeys(key, data);
      const view = await decryptCipher(key, raw, keys);
      const v = await this.ensureVault(key);
      if (v) {
        v.items = v.items.filter((i) => i.id !== raw.id);
        v.items.push(view);
        await this.cacheVault(key, v);
      }
      this.broadcast("vaultChanged");
      return view;
    }
    return undefined;
  }

  async saveItem(
    accountKey: string,
    item: ItemView,
    isNew: boolean,
    opts: { newPasskey?: PasskeyPlain; importPasskeys?: Record<string, string>[] } = {},
  ): Promise<ItemView | undefined> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const data = await this.rawSync(accountKey);
    const original = isNew ? null : ((data.ciphers ?? []).find((c: any) => c.id === item.id) ?? null);
    if (!isNew && !original) throw new Error(t("Eintrag nicht gefunden – bitte synchronisieren"));
    const api = this.api(acc);
    let res: any;
    if (!isNew && original && original.edit === false) {
      // read-only org item: only folder & favorite can be changed
      res = await api.send("PUT", `/ciphers/${item.id}/partial`, { folderId: item.folderId || null, favorite: !!item.favorite });
      const merged = { ...original, folderId: item.folderId || null, favorite: !!item.favorite, ...(res && res.id ? res : {}) };
      return this.applyCipher(accountKey, merged);
    }
    const body = await buildCipherRequest(item, original, keys, acc.id, opts);
    const oldPassword = isNew ? undefined : this.unlocked.get(accountKey)?.vault?.items.find((i) => i.id === item.id)?.login?.password;
    if (isNew) {
      if (item.organizationId) {
        if (!item.collectionIds?.length) throw new Error(t("Bitte mindestens eine Sammlung wählen"));
        res = await api.send("POST", "/ciphers/create", { cipher: body, collectionIds: item.collectionIds });
      } else {
        res = await api.send("POST", "/ciphers", body);
      }
    } else {
      res = await api.send("PUT", `/ciphers/${item.id}`, body);
    }
    if (!res?.id) {
      await this.sync(accountKey);
      return this.findItem(accountKey, item.id);
    }
    if (res.collectionIds == null) res.collectionIds = item.collectionIds ?? original?.collectionIds ?? [];
    if (res.edit == null) res.edit = true;
    if (res.viewPassword == null) res.viewPassword = true;
    if (!isNew && item.login && oldPassword !== undefined && item.login.password !== oldPassword)
      this.completeTasksFor(accountKey, item.id).catch((e) => console.warn("complete task", e));
    return this.applyCipher(accountKey, res);
  }

  async deleteItem(accountKey: string, itemId: string, permanent = false) {
    const acc = this.account(accountKey);
    const api = this.api(acc);
    if (permanent) await api.send("DELETE", `/ciphers/${itemId}`);
    else await api.send("PUT", `/ciphers/${itemId}/delete`);
    await this.sync(accountKey);
  }

  async restoreItem(accountKey: string, itemId: string) {
    const acc = this.account(accountKey);
    await this.api(acc).send("PUT", `/ciphers/${itemId}/restore`);
    await this.sync(accountKey);
  }

  async createFolder(accountKey: string, name: string): Promise<string> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const res = await this.api(acc).send("POST", "/folders", { name: await encryptFolderName(name, keys) });
    await this.sync(accountKey);
    return res.id;
  }

  /** Fetch one cipher again after a change made through another endpoint. */
  private async refreshCipher(accountKey: string, id: string): Promise<ItemView | undefined> {
    const acc = this.account(accountKey);
    const data = await this.rawSync(accountKey);
    const original = (data.ciphers ?? []).find((c: any) => c.id === id);
    try {
      const res = camelize(await this.api(acc).send("GET", `/ciphers/${id}/details`));
      if (res?.id) {
        if (res.collectionIds == null) res.collectionIds = original?.collectionIds ?? [];
        if (res.edit == null) res.edit = original?.edit ?? true;
        if (res.viewPassword == null) res.viewPassword = original?.viewPassword ?? true;
        return this.applyCipher(accountKey, res);
      }
    } catch {
      /* fall back to a full sync */
    }
    await this.sync(accountKey);
    return this.findItem(accountKey, id);
  }

  async renameFolder(accountKey: string, folderId: string, name: string) {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    await this.api(acc).send("PUT", `/folders/${folderId}`, { name: await encryptFolderName(name, keys) });
    await this.sync(accountKey);
  }

  async deleteFolder(accountKey: string, folderId: string) {
    const acc = this.account(accountKey);
    await this.api(acc).send("DELETE", `/folders/${folderId}`);
    await this.sync(accountKey);
  }

  /** Archive / unarchive (hidden from the vault list and autofill, kept out of the trash). */
  async archiveItem(accountKey: string, itemId: string, archive: boolean) {
    const acc = this.account(accountKey);
    await this.api(acc).send("PUT", archive ? "/ciphers/archive" : "/ciphers/unarchive", { ids: [itemId] });
    return this.refreshCipher(accountKey, itemId);
  }

  /** Move a personal item into an organization (re-encrypted with the organization key). */
  async shareItem(accountKey: string, item: ItemView, organizationId: string, collectionIds: string[]) {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    if (!collectionIds.length) throw new Error(t("Bitte mindestens eine Sammlung wählen"));
    const data = await this.rawSync(accountKey);
    const original = (data.ciphers ?? []).find((c: any) => c.id === item.id);
    if (!original) throw new Error(t("Eintrag nicht gefunden – bitte synchronisieren"));
    if (original.organizationId) throw new Error(t("Der Eintrag gehört bereits einer Organisation"));
    const body = await buildCipherRequest({ ...item, organizationId, folderId: item.folderId }, original, keys, acc.id, { share: true });
    const res = camelize(await this.api(acc).send("PUT", `/ciphers/${item.id}/share`, { cipher: body, collectionIds }));
    if (res?.id) {
      if (res.collectionIds == null) res.collectionIds = collectionIds;
      if (res.edit == null) res.edit = true;
      if (res.viewPassword == null) res.viewPassword = true;
      return this.applyCipher(accountKey, res);
    }
    return this.refreshCipher(accountKey, item.id);
  }

  /** Collections of an organization item. */
  async setItemCollections(accountKey: string, itemId: string, collectionIds: string[]) {
    const acc = this.account(accountKey);
    if (!collectionIds.length) throw new Error(t("Bitte mindestens eine Sammlung wählen"));
    const api = this.api(acc);
    try {
      await api.send("PUT", `/ciphers/${itemId}/collections_v2`, { collectionIds });
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status !== 404 && e.status !== 405)) throw e;
      await api.send("PUT", `/ciphers/${itemId}/collections`, { collectionIds });
    }
    // the item may no longer be visible to the user (removed from all own collections)
    await this.sync(accountKey);
    return this.findItem(accountKey, itemId);
  }

  // -------------------------------------------------------------------------------------------
  // login requests of other devices ("login with device")

  async pendingAuthRequests(accountKey: string): Promise<AuthRequestView[]> {
    const acc = this.account(accountKey);
    if (!this.unlocked.has(accountKey) || acc.needsLogin) return [];
    const r = camelize(await this.api(acc).send("GET", "/auth-requests/pending"));
    const out: AuthRequestView[] = [];
    for (const a of r?.data ?? []) {
      const created = Date.parse(a.creationDate);
      if (a.requestApproved != null || !a.publicKey || (created && Date.now() - created > 15 * 60_000)) continue;
      out.push({
        accountKey,
        id: a.id,
        device: String(a.requestDeviceType ?? ""),
        ip: String(a.requestIpAddress ?? ""),
        created: created || Date.now(),
        fingerprint: await fingerprintPhrase(acc.email.toLowerCase(), b64decode(a.publicKey)),
        publicKey: a.publicKey,
      });
    }
    return out;
  }

  /**
   * Approve (send the user key encrypted to the requesting device) or deny a login request.
   * `shownPublicKey` is the key whose fingerprint the user compared; approval is refused if the
   * server now hands out a different one.
   */
  async respondAuthRequest(accountKey: string, id: string, approve: boolean, shownPublicKey?: string) {
    const acc = this.account(accountKey);
    const st = this.unlocked.get(accountKey);
    if (!st) throw new Error(t("Konto ist gesperrt"));
    const r = camelize(await this.api(acc).send("GET", "/auth-requests/" + id));
    let key = "";
    if (approve) {
      if (!r?.publicKey) throw new Error(t("Die Anfrage ist nicht mehr gültig"));
      if (!shownPublicKey || !sameKey(r.publicKey, shownPublicKey))
        throw new Error(t("Der Schlüssel der Anfrage hat sich geändert. Bitte den Fingerabdruck erneut prüfen."));
      key = await rsaEncryptKey(st.userKey, b64decode(r.publicKey));
    }
    await this.api(acc).send("PUT", "/auth-requests/" + id, {
      key,
      masterPasswordHash: null,
      deviceIdentifier: this.deviceId,
      requestApproved: approve,
    });
  }

  /** Fingerprint phrase of the account (user id + public key), as shown by the official clients. */
  async fingerprint(accountKey: string): Promise<string> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    if (!keys.privateKey) throw new Error(t("Das Konto hat noch kein Schlüsselpaar"));
    return fingerprintPhrase(acc.id, await publicKeyFromPrivate(keys.privateKey));
  }

  async devices(
    accountKey: string,
  ): Promise<{ id: string; name: string; type: number; identifier: string; created: string; current: boolean; trusted: boolean }[]> {
    const acc = this.account(accountKey);
    const r = camelize(await this.api(acc).send("GET", "/devices"));
    return (r?.data ?? []).map((d: any) => ({
      id: d.id,
      name: d.name ?? "",
      type: d.type ?? 0,
      identifier: d.identifier ?? "",
      created: d.creationDate ?? "",
      current: d.identifier === this.deviceId,
      trusted: !!d.isTrusted,
    }));
  }

  async removeDevice(accountKey: string, id: string) {
    const acc = this.account(accountKey);
    await this.api(acc).send("POST", `/devices/${id}/deactivate`);
  }

  // -------------------------------------------------------------------------------------------
  // export / import

  private async exportContext(accountKey: string): Promise<ExportContext> {
    const acc = this.account(accountKey);
    const v = await this.ensureVault(accountKey);
    if (!v) throw new Error(t("Konto ist gesperrt"));
    const raw = await this.rawSync(accountKey);
    const keys = await this.ensureKeys(accountKey, raw);
    return { accountKey, kdf: acc.kdf, keys, raw, items: v.items, folders: v.folders };
  }

  /** E-mail code for accounts without master password and PIN (protected action, like the official export). */
  async requestOtp(accountKey: string) {
    await this.api(this.account(accountKey)).send("POST", "/accounts/request-otp");
  }

  async exportVault(
    accountKey: string,
    format: ExportFormat,
    verify: { mode: "mp" | "pin" | "otp"; secret: string },
    filePassword?: string,
  ): Promise<{ data: string; fileName: string }> {
    const acc = this.account(accountKey);
    if (acc.policies?.disableExport)
      throw new Error(t("Eine Richtlinie deiner Organisation verbietet den Export des persönlichen Tresors."));
    if (verify.mode === "otp") {
      try {
        await this.api(acc).send("POST", "/accounts/verify-otp", { otp: verify.secret.trim() });
      } catch {
        throw new Error(t("Der Bestätigungscode ist ungültig"));
      }
    } else if (!(await this.verifyUser(accountKey, verify.secret, verify.mode))) {
      throw new Error(verify.mode === "pin" ? t("Falsche PIN") : t("Falsches Master-Passwort"));
    }
    const data = await buildExport(await this.exportContext(accountKey), format, filePassword);
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const who = acc.email.replace(/[^a-z0-9._-]+/gi, "_");
    const fileName =
      format === "csv"
        ? `bitwarden_export_${who}_${ts}.csv`
        : format === "json"
          ? `bitwarden_export_${who}_${ts}.json`
          : `bitwarden_encrypted_export_${who}_${ts}.json`;
    return { data, fileName };
  }

  /** Encrypted Bitwarden export → unencrypted document (the popup converts it into items). */
  async decryptImportFile(accountKey: string, doc: any, password?: string) {
    return decryptExport(await this.exportContext(accountKey), doc, password);
  }

  /** Create imported items (and their folders) in the personal vault of an account. */
  async importItems(
    accountKey: string,
    items: (ItemView & { folderName?: string; passkeysPlain?: Record<string, string>[] })[],
  ): Promise<{ imported: number }> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const v = await this.ensureVault(accountKey);
    const existing = new Map((v?.folders ?? []).map((f) => [f.name, f.id]));
    const folders: { id?: string; name: string }[] = [];
    const folderIndex = new Map<string, number>();
    const relations: { key: number; value: number }[] = [];
    const ciphers: any[] = [];
    for (const it of items) {
      const item: ItemView = {
        ...it,
        id: "",
        accountKey,
        organizationId: null,
        folderId: null,
        collectionIds: [],
        name: it.name?.trim() || "--",
        fields: it.fields ?? [],
        passwordHistory: it.passwordHistory ?? [],
        attachments: [],
      };
      if (item.login) item.login = { ...item.login, uris: item.login.uris ?? [], passkeys: 0 };
      const req = await buildCipherRequest(item, null, keys, acc.id, { importPasskeys: it.passkeysPlain });
      req.folderId = null;
      const name = it.folderName?.trim();
      if (name) {
        let idx = folderIndex.get(name);
        if (idx === undefined) {
          idx = folders.length;
          folders.push({ ...(existing.has(name) ? { id: existing.get(name) } : {}), name: await encryptFolderName(name, keys) });
          folderIndex.set(name, idx);
        }
        relations.push({ key: ciphers.length, value: idx });
      }
      ciphers.push(req);
    }
    if (!ciphers.length) return { imported: 0 };
    await this.api(acc).send("POST", "/ciphers/import", { ciphers, folders, folderRelationships: relations });
    await this.sync(accountKey);
    return { imported: ciphers.length };
  }

  // -------------------------------------------------------------------------------------------
  // attachments

  private uploads = new Map<
    string,
    { accountKey: string; itemId: string; fileName: string; size: number; chunks: Uint8Array[]; got: number; at: number }
  >();

  /** Start an upload; the file arrives in base64 chunks (extension messaging carries JSON only). */
  async attachmentUploadStart(accountKey: string, itemId: string, fileName: string, size: number): Promise<string> {
    if (!(size > 0)) throw new Error(t("Die Datei ist leer"));
    if (size > MAX_ATTACHMENT) throw new Error(t("Die Datei ist zu groß (höchstens 500 MB)"));
    const item = await this.findItem(accountKey, itemId);
    if (!item) throw new Error(t("Eintrag nicht gefunden – bitte synchronisieren"));
    if (!item.edit) throw new Error(t("Keine Berechtigung, diesen Eintrag zu ändern"));
    const now = Date.now();
    for (const [k, u] of this.uploads) if (now - u.at > 30 * 60_000) this.uploads.delete(k);
    const id = newGuid();
    this.uploads.set(id, { accountKey, itemId, fileName: fileName || "datei", size, chunks: [], got: 0, at: now });
    return id;
  }

  attachmentUploadChunk(id: string, b64: string) {
    const u = this.uploads.get(id);
    if (!u) throw new Error(t("Upload abgebrochen"));
    const bytes = b64decode(b64);
    u.got += bytes.length;
    if (u.got > u.size) {
      this.uploads.delete(id);
      throw new Error(t("Upload abgebrochen"));
    }
    u.chunks.push(bytes);
    u.at = Date.now();
  }

  async attachmentUploadFinish(id: string): Promise<ItemView | undefined> {
    const u = this.uploads.get(id);
    this.uploads.delete(id);
    if (!u || u.got !== u.size) throw new Error(t("Upload abgebrochen"));
    const plain = new Uint8Array(u.size);
    let off = 0;
    for (const c of u.chunks) {
      plain.set(c, off);
      off += c.length;
    }
    return this.putAttachment(u.accountKey, u.itemId, u.fileName, plain);
  }

  /** Encrypt a file with a new file key and attach it to an item (rolled back if the upload fails). */
  private async putAttachment(accountKey: string, itemId: string, fileName: string, plain: Uint8Array): Promise<ItemView | undefined> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const data = await this.rawSync(accountKey);
    const raw = (data.ciphers ?? []).find((c: any) => c.id === itemId);
    if (!raw) throw new Error(t("Eintrag nicht gefunden – bitte synchronisieren"));
    const cipherKey = await cipherKeyFor(raw, keys);
    const fileKey = generateCbcHmacKey();
    const encData = await encryptFileData(plain, fileKey);
    const encFileName = await encryptString(fileName, cipherKey);
    const api = this.api(acc);
    const up = camelize(
      await api.send("POST", `/ciphers/${itemId}/attachment/v2`, {
        key: await encryptKey(fileKey, cipherKey),
        fileName: encFileName,
        fileSize: encData.length,
        adminRequest: false,
        lastKnownRevisionDate: raw.revisionDate ?? null,
      }),
    );
    try {
      if (up.fileUploadType === 1) await azureUpload(up.url, encData);
      else {
        const fd = new FormData();
        fd.append("data", new Blob([encData.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }), encFileName);
        await sendBody(api, `${acc.urls.api}/ciphers/${itemId}/attachment/${up.attachmentId}`, "POST", fd);
      }
    } catch (e) {
      // roll back the announced attachment
      await api.send("DELETE", `/ciphers/${itemId}/attachment/${up.attachmentId}`).catch(() => {});
      throw e;
    }
    return this.refreshCipher(accountKey, itemId);
  }

  async attachmentDelete(accountKey: string, itemId: string, attachmentId: string): Promise<ItemView | undefined> {
    const acc = this.account(accountKey);
    await this.api(acc).send("DELETE", `/ciphers/${itemId}/attachment/${attachmentId}`);
    return this.refreshCipher(accountKey, itemId);
  }

  /**
   * Download URL and decryption key of an attachment. The file itself is fetched and decrypted by
   * the extension page that asked for it (large files would not fit through extension messaging).
   */
  async attachmentDownload(
    accountKey: string,
    itemId: string,
    attachmentId: string,
  ): Promise<{ url: string; key: SerializedKey; fileName: string; size?: number }> {
    const src = await this.attachmentSource(accountKey, itemId, attachmentId);
    return { url: src.url, key: serializeKey(src.fileKey), fileName: src.fileName, size: src.size };
  }

  /** Download URL, file key and name of an attachment (the key stays in the background). */
  private async attachmentSource(
    accountKey: string,
    itemId: string,
    attachmentId: string,
  ): Promise<{ url: string; fileKey: SymKey; fileName: string; size?: number }> {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const data = await this.rawSync(accountKey);
    const raw = (data.ciphers ?? []).find((c: any) => c.id === itemId);
    const att = raw?.attachments?.find((a: any) => a.id === attachmentId);
    if (!raw || !att) throw new Error(t("Anhang nicht gefunden – bitte synchronisieren"));
    const cipherKey = await cipherKeyFor(raw, keys);
    let url: string | undefined;
    let meta: any = att;
    try {
      // fresh, short-lived download URL (cloud storage links in the sync data expire)
      const r = camelize(await this.api(acc).send("GET", `/ciphers/${itemId}/attachment/${attachmentId}`));
      if (r?.url) {
        url = r.url;
        meta = { ...att, ...r };
      }
    } catch (e) {
      if (!att.url) throw e;
    }
    url = url ?? att.url;
    if (!url) throw new Error(t("Der Server liefert keine Download-Adresse für diesen Anhang"));
    const fileKey = meta.key ? await decryptKey(meta.key, cipherKey) : cipherKey;
    let fileName = "anhang";
    try {
      fileName = (await decryptString(meta.fileName, cipherKey)) || fileName;
    } catch {
      /* keep default */
    }
    const size = Number(meta.size);
    return { url, fileKey, fileName, size: Number.isFinite(size) ? size : undefined };
  }

  /** Fetch and decrypt an attachment inside the background. */
  private async attachmentPlain(accountKey: string, itemId: string, attachmentId: string): Promise<Uint8Array> {
    const src = await this.attachmentSource(accountKey, itemId, attachmentId);
    if (src.size != null && src.size > MAX_ATTACHMENT) throw new Error(t("Die Datei ist zu groß (höchstens 500 MB)"));
    const res = await fetch(src.url, { credentials: "omit", cache: "no-store" });
    if (!res.ok) throw new Error(t("Download fehlgeschlagen (HTTP {status})", { status: res.status }));
    try {
      return await decryptFileData(new Uint8Array(await res.arrayBuffer()), src.fileKey);
    } catch {
      throw new Error(t("Der Anhang konnte nicht entschlüsselt werden"));
    }
  }

  // -------------------------------------------------------------------------------------------
  // copy into another account

  /**
   * Copy an item into the personal vault of another unlocked account: all data, passkeys and
   * attachments are re-encrypted with the target account's keys. The original stays untouched.
   * A failed attachment does not undo the copy; its name is reported in `attachmentsFailed`.
   */
  async copyItemToAccount(
    sourceKey: string,
    itemId: string,
    targetKey: string,
    targetFolderId: string | null,
  ): Promise<{ id: string; attachmentsFailed: string[] }> {
    if (sourceKey === targetKey) throw new Error(t("Bitte ein anderes Konto wählen"));
    const target = this.account(targetKey);
    if (!this.isUnlocked(sourceKey) || !this.isUnlocked(targetKey)) throw new Error(t("Konto ist gesperrt"));
    const item = await this.findItem(sourceKey, itemId);
    const raw = ((await this.rawSync(sourceKey)).ciphers ?? []).find((c: any) => c.id === itemId);
    if (!item || !raw) throw new Error(t("Eintrag nicht gefunden – bitte synchronisieren"));
    if (item.deletedDate) throw new Error(t("Einträge im Papierkorb können nicht kopiert werden"));
    // the organization hides the password from this user: a copy would reveal it
    if (!item.viewPassword) throw new Error(t("Das Passwort dieses Eintrags ist für dich verborgen – er kann nicht kopiert werden."));
    if (item.decryptError || hasDecryptFailure(item))
      throw new Error(t("Der Eintrag konnte nicht vollständig entschlüsselt werden und wird deshalb nicht kopiert."));
    if (!personalItemAllowed(target.policies, item.type))
      throw new Error(t("Eine Richtlinie verbietet Einträge im persönlichen Tresor dieses Kontos."));
    if (targetFolderId && !(await this.ensureVault(targetKey))?.folders.some((f) => f.id === targetFolderId))
      throw new Error(t("Ordner nicht gefunden – bitte synchronisieren"));

    const passkeys = item.type === CipherType.Login ? await plainPasskeys(raw, await this.ensureKeys(sourceKey), true) : undefined;
    const copy: ItemView = {
      ...item,
      id: "",
      accountKey: targetKey,
      organizationId: null,
      folderId: targetFolderId,
      collectionIds: [],
      attachments: [],
      edit: true,
      viewPassword: true,
      archivedDate: null,
    };
    if (copy.login) copy.login = { ...copy.login, passkeys: 0, fido2: undefined };
    const created = await this.saveItem(targetKey, copy, true, { importPasskeys: passkeys });
    if (!created?.id) throw new Error(t("Kopieren fehlgeschlagen"));

    // one attachment at a time: download, decrypt, re-encrypt and upload, then let it go
    const attachmentsFailed: string[] = [];
    for (const a of item.attachments) {
      try {
        const plain = await this.attachmentPlain(sourceKey, itemId, a.id);
        await this.putAttachment(targetKey, created.id, a.fileName, plain);
      } catch (e: any) {
        console.warn("copy attachment failed", e?.message ?? String(e));
        attachmentsFailed.push(a.fileName);
      }
    }
    await this.sync(targetKey).catch((e) => console.warn("sync after copy failed", e?.message ?? String(e)));
    return { id: created.id, attachmentsFailed };
  }

  // -------------------------------------------------------------------------------------------
  // passkeys

  /** Decrypted private key of the (first) passkey of an item – only used inside the background. */
  async passkeySecret(accountKey: string, itemId: string): Promise<{ pkcs8: Uint8Array; counter: number }> {
    const keys = await this.ensureKeys(accountKey);
    const data = await this.rawSync(accountKey);
    const raw = (data.ciphers ?? []).find((c: any) => c.id === itemId);
    const f = raw?.login?.fido2Credentials?.[0];
    if (!f) throw new Error(t("Passkey nicht gefunden"));
    const ck = await cipherKeyFor(raw, keys);
    const keyValue = await decryptString(f.keyValue, ck);
    const counter = Number(f.counter ? await decryptString(f.counter, ck) : 0);
    return { pkcs8: b64decode(keyValue), counter: Number.isFinite(counter) ? counter : 0 };
  }

  /** Store a new signature counter (only for passkeys that use one; ours stay at 0 like Bitwarden's). */
  async updatePasskeyCounter(accountKey: string, itemId: string, counter: number) {
    const acc = this.account(accountKey);
    const keys = await this.ensureKeys(accountKey);
    const data = await this.rawSync(accountKey);
    const original = (data.ciphers ?? []).find((c: any) => c.id === itemId);
    if (!original?.login?.fido2Credentials?.length || original.edit === false) return;
    const item = await this.findItem(accountKey, itemId);
    if (!item) return;
    const ck = await cipherKeyFor(original, keys);
    const mod = structuredClone(original);
    mod.login.fido2Credentials[0].counter = await encryptString(String(counter), ck);
    const body = await buildCipherRequest(item, mod, keys, acc.id);
    const res = await this.api(acc).send("PUT", `/ciphers/${itemId}`, body);
    if (res?.id) {
      if (res.collectionIds == null) res.collectionIds = original.collectionIds ?? [];
      await this.applyCipher(accountKey, res);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Send

  private async sendContext(accountKey: string) {
    const acc = this.account(accountKey);
    const st = this.unlocked.get(accountKey);
    if (!st) throw new Error(t("Konto ist gesperrt"));
    return { acc, userKey: st.userKey, api: this.api(acc), linkBase: sendUrlBase(acc) };
  }

  async listSends(accountKey: string): Promise<SendListResponse> {
    const { userKey, linkBase } = await this.sendContext(accountKey);
    const data = await this.rawSync(accountKey);
    const sends = await Promise.all((data.sends ?? []).map((r: any) => decryptSend(r, accountKey, userKey, linkBase)));
    sends.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const p = data.profile ?? {};
    const pol = this.getAccount(accountKey)?.policies;
    return {
      sends,
      premium: !!(p.premium || p.premiumFromOrganization || (p.organizations ?? []).some((o: any) => o.usersGetPremium)),
      disableSend: !!pol?.disableSend,
      disableHideEmail: !!pol?.disableHideEmail,
    };
  }

  private async applySend(accountKey: string, raw: any | null, removeId?: string) {
    const data = await this.rawSync(accountKey);
    const id = raw?.id ?? removeId;
    data.sends = (data.sends ?? []).filter((x: any) => x.id !== id);
    if (raw) data.sends.push(raw);
    await local.set("sync:" + accountKey, data);
    this.broadcast("sendsChanged");
  }

  private assertSendAllowed(accountKey: string, edit?: SendEdit) {
    const pol = this.getAccount(accountKey)?.policies;
    if (pol?.disableSend) throw new Error(t("Send ist durch eine Richtlinie deiner Organisation deaktiviert"));
    if (edit?.hideEmail && pol?.disableHideEmail)
      throw new Error(t("Das Verbergen der E-Mail-Adresse ist durch eine Richtlinie deiner Organisation nicht erlaubt"));
  }

  /** Start the upload of the file of a new file Send (chunks via attachmentUploadChunk). */
  sendUploadStart(accountKey: string, fileName: string, size: number): string {
    const MAX = 500 * 1024 * 1024;
    if (!(size > 0)) throw new Error(t("Die Datei ist leer"));
    if (size > MAX) throw new Error(t("Die Datei ist zu groß (höchstens 500 MB)"));
    const now = Date.now();
    for (const [k, u] of this.uploads) if (now - u.at > 30 * 60_000) this.uploads.delete(k);
    const id = newGuid();
    this.uploads.set(id, { accountKey, itemId: "", fileName: fileName || "datei", size, chunks: [], got: 0, at: now });
    return id;
  }

  private takeUpload(id: string, accountKey: string) {
    const u = this.uploads.get(id);
    this.uploads.delete(id);
    if (!u || u.accountKey !== accountKey || u.itemId !== "" || u.got !== u.size) throw new Error(t("Upload abgebrochen"));
    const plain = new Uint8Array(u.size);
    let off = 0;
    for (const c of u.chunks) {
      plain.set(c, off);
      off += c.length;
    }
    return { plain, fileName: u.fileName };
  }

  async saveSend(accountKey: string, edit: SendEdit): Promise<SendView> {
    this.assertSendAllowed(accountKey, edit);
    if (!edit.name.trim()) throw new Error(t("Bitte einen Namen eingeben"));
    const { acc, userKey, api, linkBase } = await this.sendContext(accountKey);
    const data = await this.rawSync(accountKey);
    const original = edit.id ? (data.sends ?? []).find((x: any) => x.id === edit.id) : undefined;
    if (edit.id && !original) throw new Error(t("Send nicht gefunden – bitte synchronisieren"));
    let res: any;
    if (original) {
      if (original.type !== edit.type) throw new Error(t("Der Typ eines Sends lässt sich nicht ändern"));
      const { body } = await buildSendRequest(edit, userKey, original);
      res = camelize(await api.send("PUT", `/sends/${original.id}`, body));
    } else if (edit.type === SendType.Text) {
      const { body } = await buildSendRequest(edit, userKey);
      res = camelize(await api.send("POST", "/sends", body));
    } else {
      if (!edit.uploadId) throw new Error(t("Bitte eine Datei auswählen"));
      const { plain, fileName } = this.takeUpload(edit.uploadId, accountKey);
      const { body, key } = await buildSendRequest(edit, userKey, undefined, fileName);
      const encData = await encryptFileData(plain, key);
      body.fileLength = encData.length;
      const up = camelize(await api.send("POST", "/sends/file/v2", body));
      res = up.sendResponse;
      const fileId = res?.file?.id;
      if (!res?.id || !fileId) throw new Error(t("Ungültige Antwort des Servers"));
      try {
        if (up.fileUploadType === 1) await azureUpload(up.url, encData);
        else {
          const fd = new FormData();
          fd.append("data", new Blob([encData.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }), body.file.fileName);
          await sendBody(api, `${acc.urls.api}/sends/${res.id}/file/${fileId}`, "POST", fd);
        }
      } catch (e) {
        await api.send("DELETE", `/sends/${res.id}`).catch(() => {});
        throw e;
      }
    }
    if (!res?.id) throw new Error(t("Ungültige Antwort des Servers"));
    await this.applySend(accountKey, res);
    return decryptSend(res, accountKey, userKey, linkBase);
  }

  async deleteSend(accountKey: string, id: string) {
    const { api } = await this.sendContext(accountKey);
    await api.send("DELETE", `/sends/${id}`);
    await this.applySend(accountKey, null, id);
  }

  async removeSendPassword(accountKey: string, id: string): Promise<SendView> {
    this.assertSendAllowed(accountKey);
    const { api, userKey, linkBase } = await this.sendContext(accountKey);
    const res = camelize(await api.send("PUT", `/sends/${id}/remove-password`));
    if (!res?.id) throw new Error(t("Ungültige Antwort des Servers"));
    await this.applySend(accountKey, res);
    return decryptSend(res, accountKey, userKey, linkBase);
  }

  /** Origins of the web vaults of all accounts (their own WebAuthn must not be intercepted). */
  vaultOrigins(): Set<string> {
    const out = new Set<string>();
    for (const a of this.accounts) {
      try {
        out.add(new URL(a.urls.webVault).origin);
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

/** Largest attachment accepted for upload (like the official clients). */
const MAX_ATTACHMENT = 500 * 1024 * 1024;

/** Some field was replaced by the "decryption failed" text: copying it would store that text as data. */
function hasDecryptFailure(item: ItemView): boolean {
  const marker = t("[Entschlüsselung fehlgeschlagen]");
  const walk = (v: unknown): boolean =>
    typeof v === "string" ? v === marker : Array.isArray(v) ? v.some(walk) : !!v && typeof v === "object" && Object.values(v).some(walk);
  return walk(item);
}

/** Upload to Azure blob storage (Bitwarden cloud), as the official clients do. */
async function azureUpload(url: string, data: Uint8Array) {
  const u = new URL(url);
  const version = u.searchParams.get("sv") ?? "2020-04-08";
  const body = data.slice().buffer as ArrayBuffer;
  const SINGLE_MAX = 256 * 1024 * 1024;
  if (data.length <= SINGLE_MAX) {
    const r = await fetch(url, {
      method: "PUT",
      cache: "no-store",
      headers: { "x-ms-date": new Date().toUTCString(), "x-ms-version": version, "x-ms-blob-type": "BlockBlob" },
      body,
    });
    if (r.status !== 201) throw new Error(t("Upload fehlgeschlagen (HTTP {status})", { status: r.status }));
    return;
  }
  // larger files: one block + block list
  const blockId = btoa("000000");
  const bu = new URL(url);
  bu.searchParams.append("comp", "block");
  bu.searchParams.append("blockid", blockId);
  let r = await fetch(bu.toString(), {
    method: "PUT",
    cache: "no-store",
    headers: { "x-ms-date": new Date().toUTCString(), "x-ms-version": version },
    body,
  });
  if (r.status !== 201) throw new Error(t("Upload fehlgeschlagen (HTTP {status})", { status: r.status }));
  const lu = new URL(url);
  lu.searchParams.append("comp", "blocklist");
  r = await fetch(lu.toString(), {
    method: "PUT",
    cache: "no-store",
    headers: { "x-ms-date": new Date().toUTCString(), "x-ms-version": version },
    body: `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>`,
  });
  if (r.status !== 201) throw new Error(t("Upload fehlgeschlagen (HTTP {status})", { status: r.status }));
}
