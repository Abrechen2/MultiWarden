import type { AccountPolicies } from "./policies";
import type { KdfConfig, SerializedKey } from "../crypto/bw";

export type ServerType = "us" | "eu" | "selfhosted";

export interface ServerUrls {
  base?: string;
  api: string;
  identity: string;
  icons: string;
  webVault: string;
  /** event logs of organizations (POST /collect) */
  events?: string;
  /** live sync (SignalR hub) */
  notifications?: string;
}

export interface AccountRecord {
  id: string; // Bitwarden user id (JWT sub) — unique per server
  key: string; // local unique key: `${host}|${userId}`
  email: string;
  name?: string;
  server: ServerType;
  urls: ServerUrls;
  /** how the user key is obtained after login */
  decryption?: "masterPassword" | "tde" | "keyConnector";
  /** false for SSO accounts without master password (TDE / Key Connector) */
  hasMasterPassword?: boolean;
  ssoOrgIdentifier?: string;
  keyConnectorUrl?: string;
  kdf: KdfConfig;
  salt: string;
  encUserKey: string;
  accessToken?: string;
  accessTokenExp?: number;
  refreshToken?: string;
  clientId: string;
  color: string;
  label?: string;
  needsLogin?: boolean;
  /** temp: admin set a temporary password; weak: does not meet the organization's policy */
  forcePasswordChange?: "temp" | "weak";
  /** organization switched to Key Connector: the master password can be removed (or the organization left) */
  kcMigration?: KcMigration;
  /** organization policies that apply to this account (from the last sync) */
  policies?: AccountPolicies;
  /** organizations with event logs (client events are collected for their items) */
  eventOrgs?: string[];
  lastSync?: number;
  order: number;
  addedAt: number;
}

export interface KcMigration {
  orgId: string;
  orgName: string;
  url: string;
}

export type AccountStatus = "unlocked" | "locked" | "loggedOut";

export interface AccountPublic {
  key: string;
  id: string;
  email: string;
  name?: string;
  server: ServerType;
  serverLabel: string;
  webVault: string;
  iconsUrl: string;
  color: string;
  label: string;
  initials: string;
  status: AccountStatus;
  hasMasterPassword: boolean;
  decryption: "masterPassword" | "tde" | "keyConnector";
  sso: boolean;
  pinUnlock: boolean;
  /** can be unlocked with biometrics / security key (WebAuthn PRF) */
  bioUnlock: boolean;
  forcePasswordChange?: "temp" | "weak";
  kcMigration?: KcMigration;
  policies?: AccountPolicies;
  /** items whose password the organization asks to change (security tasks) */
  atRisk?: string[];
  lastSync?: number;
  syncing?: boolean;
  syncError?: string;
  itemCount?: number;
}

export interface PasskeyMeta {
  credentialId: string;
  rpId: string;
  rpName?: string;
  userName?: string;
  userDisplayName?: string;
  userHandle?: string;
  discoverable: boolean;
  counter: number;
  creationDate?: string;
}

export enum CipherType {
  Login = 1,
  SecureNote = 2,
  Card = 3,
  Identity = 4,
  SshKey = 5,
  BankAccount = 6,
  DriversLicense = 7,
  Passport = 8,
}

export enum UriMatch {
  Domain = 0,
  Host = 1,
  StartsWith = 2,
  Exact = 3,
  RegularExpression = 4,
  Never = 5,
}

export enum FieldType {
  Text = 0,
  Hidden = 1,
  Boolean = 2,
  Linked = 3,
}

export interface LoginUriView {
  uri: string;
  match?: UriMatch | null;
}

export interface FieldView {
  name: string;
  value: string;
  type: FieldType;
  linkedId?: number | null;
}

/** result of the last login with an item; never holds a password or hash */
export interface OutcomeRecord {
  at: number;
  ok: boolean;
  /** password revision of the item when the outcome was recorded */
  rev: string;
}

export interface ItemView {
  id: string;
  accountKey: string;
  organizationId?: string | null;
  folderId?: string | null;
  collectionIds: string[];
  type: CipherType;
  name: string;
  notes?: string;
  favorite: boolean;
  reprompt: number;
  edit: boolean;
  viewPassword: boolean;
  login?: {
    username?: string;
    password?: string;
    totp?: string;
    uris: LoginUriView[];
    passwordRevisionDate?: string | null;
    autofillOnPageLoad?: boolean | null;
    passkeys: number;
    /** passkey metadata (the private key never leaves the background) */
    fido2?: PasskeyMeta[];
  };
  card?: Record<string, string | undefined>;
  identity?: Record<string, string | undefined>;
  sshKey?: Record<string, string | undefined>;
  secureNote?: { type: number };
  /** other / newer item types (bank account, driver's license, passport …) */
  extra?: Record<string, string | undefined>;
  fields: FieldView[];
  passwordHistory: { password: string; lastUsedDate: string }[];
  attachments: { id: string; fileName: string; size?: string; sizeName?: string }[];
  creationDate?: string;
  revisionDate?: string;
  deletedDate?: string | null;
  archivedDate?: string | null;
  decryptError?: string;
}

export interface FolderView {
  id: string;
  accountKey: string;
  name: string;
}

export interface CollectionView {
  id: string;
  accountKey: string;
  organizationId: string;
  name: string;
  readOnly?: boolean;
  manage?: boolean;
}

export interface OrganizationView {
  id: string;
  accountKey: string;
  name: string;
}

export interface VaultData {
  items: ItemView[];
  folders: FolderView[];
  collections: CollectionView[];
  organizations: OrganizationView[];
}

/** minutes (0 = immediately when the popup closes), on browser restart, or never */
export type VaultTimeout = "restart" | "never" | number;

export interface Settings {
  vaultTimeout: VaultTimeout;
  /** what happens when the timeout is reached */
  vaultTimeoutAction: "lock" | "logout";
  lockOnSystemLock: boolean;
  inlineMenu: boolean;
  showFavicons: boolean;
  defaultUriMatch: UriMatch;
  autoCopyTotp: boolean;
  clearClipboardSeconds: number; // 0 = never
  theme: "system" | "light" | "dark";
  /** offer to save new logins / update changed passwords after a form submission */
  promptSave: boolean;
  /** remember per login whether the last sign-in worked (local, no password stored) */
  trackLoginOutcome: boolean;
  /** ask in the page whether the sign-in worked after a fill */
  askLoginOutcome: boolean;
  promptUpdate: boolean;
  /** handle WebAuthn requests of websites with passkeys from the vaults */
  passkeys: boolean;
  /** PIN unlock */
  pinEnabled: boolean;
  /** require master password / SSO again after a browser restart (PIN only within the session) */
  pinLockAfterRestart: boolean;
  // --- appearance ---
  language: "system" | "de" | "en" | "fr" | "es";
  colorScheme: "multiwarden" | "mint" | "tuvia" | "red" | "gray" | "custom";
  customColors: Partial<{
    background: string;
    container: string;
    accent: string;
    text: string;
    textMuted: string;
    border: string;
    danger: string;
  }>;
  compactMode: boolean;
  animations: boolean;
  popupWidth: "default" | "wide" | "extraWide";
  /** single: all settings on one page; sections: one sub page per section (like Bitwarden) */
  settingsLayout: "single" | "sections";
  /** copy buttons directly in the vault list */
  quickCopy: boolean;
  /** number of matching logins on the toolbar icon */
  badgeCounter: boolean;
  // --- autofill ---
  /** inline menu opens only via the icon in the field instead of on focus */
  inlineMenuOnIcon: boolean;
  inlineMenuCards: boolean;
  inlineMenuIdentities: boolean;
  /** popup: cards / identities among the autofill suggestions */
  suggestCards: boolean;
  suggestIdentities: boolean;
  autofillOnPageLoad: boolean;
  /** warn before known phishing links (Bitwarden's list, checked locally) */
  phishingWarning: boolean;
  /** page-load fill for logins without their own choice */
  autofillOnPageLoadDefault: boolean;
  contextMenu: boolean;
  /** honour data-bwignore / span[data-bwautofill] of websites */
  honorBwIgnore: boolean;
  honorBwAutofill: boolean;
  /** answer HTTP Basic/Digest authentication with the one matching login */
  basicAuth: boolean;
  /** no inline menu, page-load fill, save prompts or passkeys on these hosts */
  blockedDomains: string[];
  /** this browser answers "login with device" requests of the accounts' other devices */
  approveLoginRequests: boolean;
  /** unlock with Windows Hello / Touch ID / security key (WebAuthn PRF credential of this extension) */
  biometric: { credentialId: string; salt: string } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  vaultTimeout: "restart",
  vaultTimeoutAction: "lock",
  lockOnSystemLock: true,
  inlineMenu: true,
  showFavicons: true,
  defaultUriMatch: UriMatch.Domain,
  autoCopyTotp: true,
  clearClipboardSeconds: 0,
  theme: "system",
  promptSave: true,
  trackLoginOutcome: true,
  askLoginOutcome: true,
  promptUpdate: true,
  passkeys: true,
  pinEnabled: false,
  pinLockAfterRestart: true,
  language: "system",
  colorScheme: "multiwarden",
  customColors: {},
  compactMode: false,
  animations: true,
  popupWidth: "default",
  settingsLayout: "single",
  quickCopy: false,
  badgeCounter: true,
  inlineMenuOnIcon: false,
  inlineMenuCards: true,
  inlineMenuIdentities: true,
  suggestCards: true,
  suggestIdentities: true,
  autofillOnPageLoad: false,
  phishingWarning: false,
  autofillOnPageLoadDefault: true,
  contextMenu: true,
  honorBwIgnore: false,
  honorBwAutofill: false,
  basicAuth: true,
  blockedDomains: [],
  approveLoginRequests: false,
  biometric: null,
};

export const SERVER_PRESETS: Record<Exclude<ServerType, "selfhosted">, ServerUrls & { label: string }> = {
  us: {
    label: "bitwarden.com",
    api: "https://api.bitwarden.com",
    identity: "https://identity.bitwarden.com",
    icons: "https://icons.bitwarden.net",
    webVault: "https://vault.bitwarden.com",
    events: "https://events.bitwarden.com",
    notifications: "https://notifications.bitwarden.com",
  },
  eu: {
    label: "bitwarden.eu",
    api: "https://api.bitwarden.eu",
    identity: "https://identity.bitwarden.eu",
    icons: "https://icons.bitwarden.eu",
    webVault: "https://vault.bitwarden.eu",
    events: "https://events.bitwarden.eu",
    notifications: "https://notifications.bitwarden.eu",
  },
};

export function selfHostedUrls(base: string): ServerUrls {
  let b = base.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(b)) b = "https://" + b;
  return {
    base: b,
    api: b + "/api",
    identity: b + "/identity",
    icons: b + "/icons",
    webVault: b,
    events: b + "/events",
    notifications: b + "/notifications",
  };
}

/** Events / notifications URL also for accounts stored before these URLs existed. */
export function serviceUrl(urls: ServerUrls, kind: "events" | "notifications"): string {
  if (urls[kind]) return urls[kind]!;
  const base = urls.base ?? urls.api.replace(/\/api\/?$/, "");
  if (/^https:\/\/api\.bitwarden\.(com|eu)$/.test(base)) return base.replace("//api.", "//" + kind + ".");
  return base + "/" + kind;
}

export const ACCOUNT_COLORS = ["#175ddc", "#c2185b", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f", "#ad1457", "#5d4037"];
