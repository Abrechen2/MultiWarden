// Email forwarding services for the username generator (same services and API calls as the
// official clients). The tokens are kept encrypted in the background (secret store).
import { tk } from "./i18n";

export type ForwarderId = "addyio" | "duckduckgo" | "fastmail" | "firefoxrelay" | "forwardemail" | "simplelogin";

export interface ForwarderSettings {
  token?: string;
  domain?: string;
  baseUrl?: string;
  prefix?: string;
}

export interface ForwarderMeta {
  id: ForwarderId;
  name: string;
  /** settings the user has to / can enter */
  fields: ("token" | "domain" | "baseUrl" | "prefix")[];
  required: ("token" | "domain")[];
  defaultBaseUrl: string;
  tokenLabel: string;
}

export const FORWARDERS: ForwarderMeta[] = [
  {
    id: "addyio",
    name: "addy.io",
    fields: ["token", "domain", "baseUrl"],
    required: ["token", "domain"],
    defaultBaseUrl: "https://app.addy.io",
    tokenLabel: tk("API-Zugriffstoken"),
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo",
    fields: ["token"],
    required: ["token"],
    defaultBaseUrl: "https://quack.duckduckgo.com/api",
    tokenLabel: tk("API-Schlüssel"),
  },
  {
    id: "fastmail",
    name: "Fastmail",
    fields: ["token", "prefix"],
    required: ["token"],
    defaultBaseUrl: "https://api.fastmail.com",
    tokenLabel: tk("API-Token"),
  },
  {
    id: "firefoxrelay",
    name: "Firefox Relay",
    fields: ["token"],
    required: ["token"],
    defaultBaseUrl: "https://relay.firefox.com/api",
    tokenLabel: tk("API-Schlüssel"),
  },
  {
    id: "forwardemail",
    name: "Forward Email",
    fields: ["token", "domain"],
    required: ["token", "domain"],
    defaultBaseUrl: "https://api.forwardemail.net",
    tokenLabel: tk("API-Schlüssel"),
  },
  {
    id: "simplelogin",
    name: "SimpleLogin",
    fields: ["token", "baseUrl"],
    required: ["token"],
    defaultBaseUrl: "https://app.simplelogin.io",
    tokenLabel: tk("API-Schlüssel"),
  },
];

export const forwarderMeta = (id: string) => FORWARDERS.find((f) => f.id === id);
