import { CipherType, ItemView } from "./types";

/** Skeleton of a new login item (used by the save-login prompt and for new passkeys). */
export function newLoginItem(
  accountKey: string,
  p: { name: string; username?: string; password?: string; uri?: string; folderId?: string | null },
): ItemView {
  return {
    id: "",
    accountKey,
    organizationId: null,
    folderId: p.folderId ?? null,
    collectionIds: [],
    type: CipherType.Login,
    name: p.name,
    notes: "",
    favorite: false,
    reprompt: 0,
    edit: true,
    viewPassword: true,
    login: {
      username: p.username ?? "",
      password: p.password ?? "",
      totp: "",
      uris: p.uri ? [{ uri: p.uri, match: null }] : [],
      passkeys: 0,
    },
    fields: [],
    passwordHistory: [],
    attachments: [],
  };
}

/** Whether an item may be copied into the personal vault of `targetKey`: another account always, the own account only for organization items. */
export function canCopyInto(item: Pick<ItemView, "accountKey" | "organizationId">, targetKey: string): boolean {
  return targetKey !== item.accountKey || !!item.organizationId;
}
