import type { SerializedKey } from "../crypto/bw";
import type { AccountPublic, ItemView, ServerType, ServerUrls, Settings, VaultData } from "./types";
import type { ForwarderId, ForwarderSettings } from "./forwarders";
import type { ReceiveAuth, ReceiveRequest, ReceiveResult, SendEdit, SendListResponse, SendView } from "./sends";

export interface StateResponse {
  accounts: AccountPublic[];
  settings: Settings;
  version: string;
}

export interface UnlockResult {
  accountKey: string;
  ok: boolean;
  error?: string;
}

export interface SaveItemRequest {
  accountKey: string;
  item: ItemView;
  isNew: boolean;
}

export interface PageMatch {
  url: string;
  host: string;
  itemIds: string[]; // `${accountKey}::${id}`
}

// ---------------------------------------------------------------------------------------------
// Login flows

export type FlowStep =
  | "sso-wait"
  | "twoFactor"
  | "twoFactor-wait"
  | "newDevice"
  | "mp"
  | "tde"
  | "tde-new"
  | "auth-request"
  | "set-password"
  | "kc-confirm"
  | "done"
  | "error";

export interface LoginFlowPublic {
  id: string;
  step: FlowStep;
  server: ServerType;
  baseUrl?: string;
  email: string;
  method: "password" | "sso" | "device" | "passkey";
  existingAccountKey?: string;
  orgIdentifier?: string;
  twoFactor?: { providers: number[]; emailHint?: string };
  waitKind?: "duo" | "webauthn" | "passkey";
  tde?: { canDevice: boolean; canAdmin: boolean; canMp: boolean };
  authRequest?: { type: 0 | 2; fingerprint: string; createdAt: number };
  keyConnectorHost?: string;
  rememberDevice?: boolean;
  error?: string;
  info?: string;
  accountKey?: string;
  ssoRequiredIdentifier?: string;
}

// ---------------------------------------------------------------------------------------------
// Passkeys

/** How the user can (or must) confirm a passkey operation for an account. */
export interface Fido2Verify {
  /** secrets that can be used; empty = nothing to enter */
  modes: ("mp" | "pin")[];
  /** verification is required but the account has neither master password nor PIN */
  missing?: boolean;
}

export interface Fido2CandidateView {
  accountKey: string;
  itemId: string;
  name: string;
  userName: string;
  rpId: string;
  accountLabel: string;
  accountColor: string;
  accountInitials: string;
  verify: Fido2Verify;
}

export interface Fido2AccountView {
  key: string;
  label: string;
  color: string;
  initials: string;
  serverLabel: string;
  unlocked: boolean;
  hasMasterPassword: boolean;
  pinUnlock: boolean;
  /** can be unlocked with biometrics / security key (WebAuthn PRF) */
  bioUnlock: boolean;
}

export interface Fido2SessionData {
  /** gone: the request is finished or unknown */
  kind: "get" | "create" | "excluded" | "gone";
  rpId: string;
  rpName?: string;
  userName?: string;
  origin: string;
  candidates: Fido2CandidateView[];
  fallbackSupported: boolean;
  accounts: Fido2AccountView[];
  /** create: existing logins of the site the passkey can be added to */
  existingLogins: { accountKey: string; itemId: string; name: string; userName: string; hasPasskey: boolean; verify: Fido2Verify }[];
  /** create: verification for a new item per account */
  newItemVerify: Record<string, Fido2Verify>;
  theme: "system" | "light" | "dark";
  pinEnabled: boolean;
}

export interface InlineMenuPasskey {
  accountKey: string;
  itemId: string;
  name: string;
  userName: string;
  accountLabel: string;
  accountColor: string;
  accountInitials: string;
}

// ---------------------------------------------------------------------------------------------
// Save-login notification

export interface NotificationData {
  /** none: nothing to ask (already saved, request gone …) */
  kind: "save" | "update" | "none";
  locked: boolean;
  host: string;
  username: string;
  accounts: { key: string; label: string; color: string; initials: string; serverLabel: string }[];
  defaultAccount?: string;
  folders: { accountKey: string; id: string; name: string }[];
  /** update: items that would get the new password */
  targets: { accountKey: string; itemId: string; name: string; accountLabel: string; accountColor: string }[];
  theme: "system" | "light" | "dark";
}

export interface LoginCapture {
  url: string;
  username: string;
  password?: string;
  /** change-password forms */
  currentPassword?: string;
  newPassword?: string;
}

export interface Rpc {
  getState: { req: Record<string, never>; res: StateResponse };
  // login flows
  loginGet: { req: Record<string, never>; res: LoginFlowPublic | null };
  loginStart: { req: { server: ServerType; baseUrl?: string; email: string; password: string }; res: LoginFlowPublic };
  loginSsoLookup: { req: { server: ServerType; baseUrl?: string; email: string }; res: { identifier: string | null } };
  loginSsoStart: {
    req: { server?: ServerType; baseUrl?: string; email?: string; orgIdentifier?: string; accountKey?: string };
    res: LoginFlowPublic;
  };
  loginTwoFactor: { req: { provider: number; token: string; remember: boolean }; res: LoginFlowPublic };
  loginSendEmail: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  loginDuo: { req: { provider: number; remember: boolean }; res: LoginFlowPublic };
  loginWebAuthn: { req: { remember: boolean }; res: LoginFlowPublic };
  loginNewDevice: { req: { otp: string }; res: LoginFlowPublic };
  loginResendDevice: { req: Record<string, never>; res: { ok: boolean; error?: string } };
  loginMasterPassword: { req: { password: string; rememberDevice?: boolean }; res: LoginFlowPublic };
  loginTde: { req: { option: "device" | "admin" | "mp"; rememberDevice: boolean }; res: LoginFlowPublic };
  loginTdeCreate: { req: { rememberDevice: boolean }; res: LoginFlowPublic };
  loginPoll: { req: Record<string, never>; res: LoginFlowPublic | null };
  loginSetPassword: { req: { password: string; hint?: string }; res: LoginFlowPublic };
  loginKeyConnector: { req: Record<string, never>; res: LoginFlowPublic };
  loginPasskey: { req: { server: ServerType; baseUrl?: string }; res: LoginFlowPublic };
  loginCancel: { req: Record<string, never>; res: { ok: true } };
  loginAck: { req: Record<string, never>; res: { ok: true } };
  // lock / unlock
  unlock: { req: { password: string; accountKeys?: string[] }; res: { results: UnlockResult[] } };
  unlockPin: { req: { pin: string }; res: { results: UnlockResult[]; error?: string } };
  biometricEnable: { req: { credentialId: string; salt: string; prf: string }; res: { ok: true } };
  biometricDisable: { req: Record<string, never>; res: { ok: true } };
  unlockBiometric: { req: { prf: string }; res: { results: UnlockResult[]; error?: string } };
  setPin: { req: { pin: string; lockAfterRestart: boolean }; res: { ok: true } };
  disablePin: { req: Record<string, never>; res: { ok: true } };
  lock: { req: { accountKey?: string }; res: { ok: true } };
  logout: { req: { accountKey: string }; res: { ok: true } };
  sync: { req: { accountKey?: string }; res: { ok: boolean; errors: Record<string, string> } };
  getVault: { req: Record<string, never>; res: VaultData };
  getPageMatches: { req: { url?: string; tabId?: number }; res: PageMatch };
  autofill: {
    req: { accountKey: string; itemId: string; tabId?: number; force?: boolean };
    res: { ok: boolean; error?: string; code?: "mismatch" | "insecure"; totpCopied?: string };
  };
  saveItem: { req: SaveItemRequest; res: { ok: boolean; error?: string; item?: ItemView } };
  deleteItem: { req: { accountKey: string; itemId: string; permanent?: boolean }; res: { ok: boolean; error?: string } };
  restoreItem: { req: { accountKey: string; itemId: string }; res: { ok: boolean; error?: string } };
  updateAccount: { req: { accountKey: string; label?: string; color?: string; order?: number }; res: { ok: true } };
  moveAccount: { req: { accountKey: string; direction: -1 | 1 }; res: { ok: true } };
  setSettings: { req: Partial<Settings>; res: Settings };
  touch: { req: Record<string, never>; res: { ok: true } };
  markUsed: { req: { accountKey: string; itemId: string }; res: { ok: true } };
  createFolder: { req: { accountKey: string; name: string }; res: { ok: boolean; error?: string; id?: string } };
  attachmentDownload: {
    req: { accountKey: string; itemId: string; attachmentId: string };
    res: { url: string; key: SerializedKey; fileName: string; size?: number };
  };
  neverDomains: { req: { remove?: string }; res: { domains: string[] } };
  register: {
    req: { server: ServerType; baseUrl?: string; email: string; name: string; password: string; hint?: string };
    res: { status: "done" | "verify-email"; flow?: LoginFlowPublic };
  };
  loginDevice: { req: { server: ServerType; baseUrl?: string; email: string }; res: LoginFlowPublic };
  authRequests: {
    req: Record<string, never>;
    res: { requests: { accountKey: string; id: string; device: string; ip: string; created: number; fingerprint: string; publicKey: string }[] };
  };
  /** publicKey: the key whose fingerprint was shown; approval fails if the server's key differs */
  authRequestRespond: { req: { accountKey: string; id: string; approve: boolean; publicKey?: string }; res: { ok: true } };
  fingerprint: { req: { accountKey: string }; res: { phrase: string } };
  devices: {
    req: { accountKey: string };
    res: { devices: { id: string; name: string; type: number; identifier: string; created: string; current: boolean; trusted: boolean }[] };
  };
  deviceRemove: { req: { accountKey: string; id: string }; res: { ok: boolean; error?: string } };
  masterPasswordPolicy: { req: { accountKey: string }; res: { policy: import("./mp-policy").MpPolicy | null } };
  changeMasterPassword: { req: { accountKey: string; current: string; next: string; hint: string }; res: { relogin: boolean } };
  updateTempPassword: { req: { accountKey: string; next: string; hint: string }; res: { relogin: boolean } };
  getCustomEnv: { req: { baseUrl: string }; res: { env: Partial<ServerUrls> } };
  setCustomEnv: { req: { baseUrl: string; env: Partial<ServerUrls> }; res: { ok: true } };
  phishingContinue: { req: { url: string }; res: { ok: true } };
  phishingLeave: { req: Record<string, never>; res: { ok: true } };
  changePasswordUrl: { req: { uri: string }; res: { url: string } };
  collectEvent: { req: { accountKey: string; itemId: string; type: number }; res: { ok: true } };
  pendingEvents: {
    req: Record<string, never>;
    res: { events: Record<string, { type: number; cipherId?: string; organizationId?: string; date: string }[]> };
  };
  removeMasterPassword: { req: { accountKey: string; password: string }; res: { ok: true } };
  leaveOrganization: { req: { accountKey: string; orgId: string }; res: { ok: true } };
  requestPasswordHint: { req: { server: ServerType; baseUrl?: string; email: string }; res: { ok: true } };
  verifyMethods: { req: { accountKey: string }; res: { mp: boolean; pin: boolean } };
  exportRequestOtp: { req: { accountKey: string }; res: { ok: true } };
  exportVault: {
    req: {
      accountKey: string;
      format: "json" | "csv" | "encrypted_json" | "password_json";
      mode: "mp" | "pin" | "otp";
      secret: string;
      filePassword?: string;
    };
    res: { data: string; fileName: string };
  };
  importDecrypt: { req: { accountKey: string; doc: any; password?: string }; res: { doc: any } };
  importItems: { req: { accountKey: string; items: any[] }; res: { imported: number } };
  generatorHistory: {
    req: Record<string, never>;
    res: {
      locked: boolean;
      history: { value: string; date: number; kind: "password" | "passphrase" | "username" | "email"; site?: string }[];
    };
  };
  generatorHistoryAdd: { req: { value: string; kind: "password" | "passphrase" | "username" | "email"; site?: string }; res: { ok: true } };
  generatorHistoryClear: { req: Record<string, never>; res: { ok: true } };
  forwarderSettings: { req: Record<string, never>; res: { forwarders: Partial<Record<ForwarderId, ForwarderSettings>> } };
  forwarderSave: { req: { id: ForwarderId; settings: ForwarderSettings }; res: { ok: true } };
  forwarderGenerate: { req: { id: ForwarderId; website?: string }; res: { email: string } };
  attachmentUploadStart: { req: { accountKey: string; itemId: string; fileName: string; size: number }; res: { id: string } };
  listSends: { req: { accountKey: string }; res: SendListResponse };
  sendUploadStart: { req: { accountKey: string; fileName: string; size: number }; res: { id: string } };
  saveSend: { req: { accountKey: string; send: SendEdit }; res: { ok: boolean; send?: SendView; error?: string } };
  deleteSend: { req: { accountKey: string; id: string }; res: { ok: boolean; error?: string } };
  removeSendPassword: { req: { accountKey: string; id: string }; res: { ok: boolean; send?: SendView; error?: string } };
  receiveSend: { req: ReceiveRequest; res: ReceiveResult };
  receiveSendFile: { req: { link: string; sendId: string; fileId: string; auth: ReceiveAuth }; res: { url: string; key: SerializedKey } };
  attachmentUploadChunk: { req: { id: string; data: string }; res: { ok: true } };
  attachmentUploadFinish: { req: { id: string }; res: { ok: boolean; error?: string } };
  attachmentDelete: { req: { accountKey: string; itemId: string; attachmentId: string }; res: { ok: boolean; error?: string } };
  renameFolder: { req: { accountKey: string; folderId: string; name: string }; res: { ok: boolean; error?: string } };
  deleteFolder: { req: { accountKey: string; folderId: string }; res: { ok: boolean; error?: string } };
  archiveItem: { req: { accountKey: string; itemId: string; archive: boolean }; res: { ok: boolean; error?: string } };
  shareItem: {
    req: { accountKey: string; item: ItemView; organizationId: string; collectionIds: string[] };
    res: { ok: boolean; error?: string; item?: ItemView };
  };
  setItemCollections: { req: { accountKey: string; itemId: string; collectionIds: string[] }; res: { ok: boolean; error?: string } };
  // inline menu
  inlineMenuToken: { req: { url: string; kind: MenuKind; opid?: string }; res: { token: string | null } };
  inlineMenuData: { req: { token: string }; res: InlineMenuData };
  inlineMenuFill: { req: { token: string; accountKey: string; itemId: string }; res: { ok: boolean } };
  inlineMenuGenerate: { req: { token: string }; res: { password: string } };
  inlineMenuFillGenerated: { req: { token: string }; res: { ok: boolean } };
  inlineMenuNew: { req: { token: string }; res: { ok: boolean } };
  pageLoadFill: { req: { url: string }; res: { ok: boolean } };
  inlineMenuPasskey: { req: { token: string; accountKey: string; itemId: string }; res: { ok: boolean } };
  openPopup: { req: Record<string, never>; res: { ok: boolean } };
  verifyPassword: { req: { accountKey: string; password: string }; res: { ok: boolean } };
  copyText: { req: { text: string }; res: { ok: true } };
  scheduleClipboardClear: { req: Record<string, never>; res: { ok: true } };
  // passkey dialog
  fido2Session: { req: { token: string }; res: Fido2SessionData };
  fido2Pick: {
    req: { token: string; accountKey: string; itemId: string; secret?: string; mode?: "mp" | "pin" };
    res: { ok: boolean; error?: string };
  };
  fido2Save: {
    req: { token: string; accountKey: string; itemId?: string; secret?: string; mode?: "mp" | "pin" };
    res: { ok: boolean; error?: string };
  };
  fido2Fallback: { req: { token: string }; res: { ok: true } };
  fido2Cancel: { req: { token: string }; res: { ok: true } };
  fido2Ping: { req: { token: string }; res: { ok: boolean } };
  // save-login notification
  notifyCapture: { req: LoginCapture; res: { ok: true } };
  notifyData: { req: { token: string }; res: NotificationData };
  notifySave: { req: { token: string; accountKey: string; folderId?: string }; res: { ok: boolean; error?: string } };
  notifyUpdate: { req: { token: string; targets: { accountKey: string; itemId: string }[] }; res: { ok: boolean; error?: string } };
  notifyNever: { req: { token: string }; res: { ok: true } };
  notifyClose: { req: { token: string }; res: { ok: true } };
}

export interface InlineMenuItem {
  accountKey: string;
  id: string;
  /** login / card / identity */
  type: number;
  name: string;
  /** username, card number ending, name of the person … */
  username: string;
  accountLabel: string;
  accountColor: string;
  accountInitials: string;
  icon?: string;
}

export interface InlineMenuData {
  kind: MenuKind;
  locked: boolean;
  hasAccounts: boolean;
  items: InlineMenuItem[];
  /** new-password fields: a freshly generated password to fill */
  generated?: string;
  passkeys: InlineMenuPasskey[];
  showFavicons: boolean;
  theme: "system" | "light" | "dark";
  multi: boolean;
}

export type RpcName = keyof Rpc;

export interface RpcMessage<K extends RpcName = RpcName> {
  rpc: K;
  args: Rpc[K]["req"];
}

export type RpcReply<K extends RpcName = RpcName> = { ok: true; data: Rpc[K]["res"] } | { ok: false; error: string };

export interface BroadcastEvent {
  event: "stateChanged" | "vaultChanged" | "locked" | "loginFlowChanged";
}

export interface FieldInfo {
  opid: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  label: string;
  visible: boolean;
  form: string;
}

export interface CollectResult {
  url: string;
  origin: string;
  /** password field for an existing password (login) */
  hasPassword: boolean;
  /** password field for a new password (registration / change) */
  hasNewPassword: boolean;
  hasUsername: boolean;
  hasTotp: boolean;
  /** number of payment card fields; hasCardNumber: card number or CVC among them */
  cardFields: number;
  hasCardNumber: boolean;
  identityFields: number;
  fields: FieldInfo[];
}

/** Data sent to a frame to fill (content/fill.ts). */
export interface FillData {
  /** origin of the frame the background matched; the content side refuses to fill if it navigated since */
  expectOrigin?: string;
  kind?: "login" | "card" | "identity" | "generated";
  username?: string;
  password?: string;
  totp?: string;
  fields?: { name: string; value: string }[];
  card?: Record<string, string | undefined>;
  identity?: Record<string, string | undefined>;
  /** the field the user started from (inline menu / context menu) */
  targetOpid?: string;
  /** autofill on page load: never overwrite what is already there */
  onlyEmpty?: boolean;
  /** card data goes into a cross-origin frame only if it holds a card number / CVC field */
  requireCardNumber?: boolean;
}

export type MenuKind = "login" | "newPassword" | "card" | "identity";
