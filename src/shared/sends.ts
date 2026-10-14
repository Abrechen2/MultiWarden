// Bitwarden Send: shared types between background and popup.

export enum SendType {
  Text = 0,
  File = 1,
  /** sharing a vault item (newer Bitwarden feature, not created by MultiWarden) */
  Item = 2,
}

/** who can open the Send */
export enum SendAuthType {
  Email = 0,
  Password = 1,
  None = 2,
}

export interface SendView {
  id: string;
  accountKey: string;
  accessId: string;
  type: SendType;
  name: string;
  notes?: string;
  text?: string;
  hidden?: boolean;
  file?: { id?: string; fileName: string; size?: number; sizeName?: string };
  /** share link incl. the key fragment */
  link: string;
  hasPassword: boolean;
  authType: SendAuthType;
  emails?: string[];
  maxAccessCount?: number | null;
  accessCount: number;
  disabled: boolean;
  hideEmail: boolean;
  revisionDate: string;
  deletionDate: string;
  expirationDate?: string | null;
  decryptError?: string;
}

/** create / edit request from the popup (plaintext; encrypted in the background) */
export interface SendEdit {
  id?: string;
  type: SendType.Text | SendType.File;
  name: string;
  notes?: string;
  text?: string;
  hidden?: boolean;
  /** set or replace the password */
  newPassword?: string;
  maxAccessCount?: number | null;
  disabled: boolean;
  hideEmail: boolean;
  deletionDate: string;
  expirationDate?: string | null;
  /** new file Sends: the upload started with sendUploadStart */
  uploadId?: string;
}

export interface SendListResponse {
  sends: SendView[];
  /** file Sends need premium on Bitwarden servers */
  premium: boolean;
  disableSend: boolean;
  disableHideEmail: boolean;
}

/** status of a Send for the list */
export function sendStatus(s: SendView, now = Date.now()): "disabled" | "expired" | "maxed" | "pendingDelete" | "active" {
  if (s.disabled) return "disabled";
  if (s.expirationDate && Date.parse(s.expirationDate) <= now) return "expired";
  if (s.maxAccessCount != null && s.accessCount >= s.maxAccessCount) return "maxed";
  if (Date.parse(s.deletionDate) <= now) return "pendingDelete";
  return "active";
}

// ---------------------------------------------------------------------------------------------
// receiving (opening a Send link)

export interface ReceiveRequest {
  link: string;
  password?: string;
  email?: string;
  otp?: string;
}

/** what the file download needs afterwards (send access token, or the password hash for older servers) */
export interface ReceiveAuth {
  token?: string;
  legacyPassword?: string;
}

export interface ReceivedSend {
  id: string;
  type: SendType;
  name: string;
  text?: string;
  hidden?: boolean;
  file?: { id: string; fileName: string; size?: number; sizeName?: string };
  expirationDate?: string | null;
  /** e-mail address of the sender, unless hidden */
  creatorIdentifier?: string | null;
  /** web vault of the server */
  server: string;
}

export type ReceiveResult =
  | { status: "ok"; send: ReceivedSend; auth: ReceiveAuth }
  | { status: "password" | "wrongPassword" | "email" | "otp" | "wrongCode" | "unavailable" }
  | { status: "error"; error: string };
