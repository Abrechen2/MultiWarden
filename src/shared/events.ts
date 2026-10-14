// Client-side events for the event logs of organizations (numbers as in Bitwarden/Vaultwarden).
export const EventType = {
  UserClientExportedVault: 1007,
  CipherClientViewed: 1107,
  CipherClientToggledPasswordVisible: 1108,
  CipherClientToggledHiddenFieldVisible: 1109,
  CipherClientToggledCardCodeVisible: 1110,
  CipherClientCopiedPassword: 1111,
  CipherClientCopiedHiddenField: 1112,
  CipherClientCopiedCardCode: 1113,
  CipherClientAutofilled: 1114,
  CipherClientToggledCardNumberVisible: 1117,
} as const;
