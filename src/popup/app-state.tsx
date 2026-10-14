import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { PageMatch, StateResponse } from "../shared/messages";
import type { AccountPublic, CipherType, ItemView, VaultData } from "../shared/types";

export type Route =
  | { name: "vault" }
  | { name: "item"; key: string }
  | { name: "edit"; key?: string; newType?: CipherType; accountKey?: string; prefill?: Partial<ItemView> }
  | { name: "generator" }
  | { name: "genHistory" }
  | { name: "settings"; section?: import("./views/Settings").SettingsSection }
  | { name: "accounts" }
  | { name: "addAccount"; email?: string; server?: string; baseUrl?: string }
  | { name: "lock"; only?: string[] }
  | { name: "trash" }
  | { name: "archive" }
  | { name: "folders" }
  | { name: "export" }
  | { name: "changePassword"; accountKey?: string }
  | { name: "removePassword"; accountKey: string }
  | { name: "authRequests" }
  | { name: "devices" }
  | { name: "atRisk" }
  | { name: "import" }
  | { name: "assign"; key: string }
  | { name: "tools" }
  | { name: "sendEdit"; accountKey: string; id?: string; type?: 0 | 1 };

export interface Filters {
  account: string | null;
  vault: string | null;
  collection: string | null;
  folder: string | null;
  type: string | null;
}

export const EMPTY_FILTERS: Filters = { account: null, vault: null, collection: null, folder: null, type: null };

export interface AppCtxValue {
  state: StateResponse;
  vault: VaultData;
  vaultLoading: boolean;
  accounts: AccountPublic[];
  accountMap: Map<string, AccountPublic>;
  page: PageMatch;
  route: Route;
  go: (r: Route, replace?: boolean) => void;
  back: () => void;
  reload: () => Promise<void>;
  reloadVault: () => Promise<void>;
  filters: Filters;
  setFilters: (f: Filters) => void;
  search: string;
  setSearch: (s: string) => void;
  showFilters: boolean;
  setShowFilters: (v: boolean) => void;
  popout: boolean;
  itemByKey: (key: string) => ItemView | undefined;
}

export const AppCtx = createContext<AppCtxValue>(null as any);
export const useApp = () => useContext(AppCtx);
