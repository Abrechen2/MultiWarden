// Field tables of the structured item types (identity, bank account, driver's license, passport).
import { tk } from "../../shared/i18n";
import { CipherType } from "../../shared/types";

export interface FieldDef {
  key: string;
  /** German source text (translate with t()) */
  label: string;
  /** hidden by default, copy counts as sensitive */
  secret?: boolean;
  mono?: boolean;
  input?: "text" | "date" | "tel" | "email" | "select";
  options?: [string, string][];
}

export const IDENTITY_FIELDS: FieldDef[] = [
  { key: "title", label: tk("Anrede") },
  { key: "firstName", label: tk("Vorname") },
  { key: "middleName", label: tk("Zweiter Vorname") },
  { key: "lastName", label: tk("Nachname") },
  { key: "username", label: tk("Benutzername") },
  { key: "company", label: tk("Firma") },
  { key: "email", label: tk("E-Mail"), input: "email" },
  { key: "phone", label: tk("Telefon"), input: "tel" },
  { key: "address1", label: tk("Adresse 1") },
  { key: "address2", label: tk("Adresse 2") },
  { key: "address3", label: tk("Adresse 3") },
  { key: "postalCode", label: tk("Postleitzahl") },
  { key: "city", label: tk("Stadt") },
  { key: "state", label: tk("Bundesland") },
  { key: "country", label: tk("Land") },
  { key: "ssn", label: tk("Sozialversicherungsnummer"), secret: true },
  { key: "passportNumber", label: tk("Reisepassnummer"), secret: true },
  { key: "licenseNumber", label: tk("Führerscheinnummer"), secret: true },
];

export const EXTRA_FIELDS: Record<number, FieldDef[]> = {
  [CipherType.BankAccount]: [
    { key: "bankName", label: tk("Bank") },
    { key: "nameOnAccount", label: tk("Kontoinhaber") },
    {
      key: "accountType",
      label: tk("Kontoart"),
      input: "select",
      options: [
        ["checking", tk("Girokonto")],
        ["savings", tk("Sparkonto")],
        ["certificateOfDeposit", tk("Festgeld")],
        ["lineOfCredit", tk("Kreditlinie")],
        ["investmentBrokerage", tk("Depot")],
        ["moneyMarket", tk("Tagesgeld")],
        ["other", tk("Sonstiges")],
      ],
    },
    { key: "iban", label: tk("IBAN"), secret: true, mono: true },
    { key: "swiftCode", label: tk("BIC / SWIFT"), mono: true },
    { key: "accountNumber", label: tk("Kontonummer"), secret: true, mono: true },
    { key: "routingNumber", label: tk("Bankleitzahl / Routing-Nummer"), mono: true },
    { key: "branchNumber", label: tk("Filialnummer") },
    { key: "pin", label: tk("PIN"), secret: true, mono: true },
    { key: "bankContactPhone", label: tk("Telefon der Bank"), input: "tel" },
  ],
  [CipherType.DriversLicense]: [
    { key: "firstName", label: tk("Vorname") },
    { key: "middleName", label: tk("Zweiter Vorname") },
    { key: "lastName", label: tk("Nachname") },
    { key: "dateOfBirth", label: tk("Geburtsdatum"), input: "date" },
    { key: "licenseNumber", label: tk("Führerscheinnummer"), secret: true, mono: true },
    { key: "licenseClass", label: tk("Führerscheinklassen") },
    { key: "issuingCountry", label: tk("Ausstellendes Land") },
    { key: "issuingState", label: tk("Ausstellendes Bundesland") },
    { key: "issuingAuthority", label: tk("Ausstellende Behörde") },
    { key: "issueDate", label: tk("Ausstellungsdatum"), input: "date" },
    { key: "expirationDate", label: tk("Gültig bis"), input: "date" },
  ],
  [CipherType.Passport]: [
    { key: "givenName", label: tk("Vornamen") },
    { key: "surname", label: tk("Nachname") },
    { key: "dateOfBirth", label: tk("Geburtsdatum"), input: "date" },
    { key: "birthPlace", label: tk("Geburtsort") },
    { key: "sex", label: tk("Geschlecht") },
    { key: "nationality", label: tk("Staatsangehörigkeit") },
    { key: "passportNumber", label: tk("Reisepassnummer"), secret: true, mono: true },
    { key: "passportType", label: tk("Passtyp") },
    { key: "nationalIdentificationNumber", label: tk("Nationale Identifikationsnummer"), secret: true, mono: true },
    { key: "issuingCountry", label: tk("Ausstellendes Land") },
    { key: "issuingAuthority", label: tk("Ausstellende Behörde") },
    { key: "issueDate", label: tk("Ausstellungsdatum"), input: "date" },
    { key: "expirationDate", label: tk("Gültig bis"), input: "date" },
  ],
};

/** Types the editor can create. */
export const CREATABLE_TYPES = [
  CipherType.Login,
  CipherType.Card,
  CipherType.Identity,
  CipherType.SecureNote,
  CipherType.SshKey,
  CipherType.BankAccount,
  CipherType.DriversLicense,
  CipherType.Passport,
];
