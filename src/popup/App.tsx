import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { PageMatch, StateResponse } from "../shared/messages";
import { CipherType, VaultData } from "../shared/types";
import { AppCtx, AppCtxValue, EMPTY_FILTERS, Filters, Route } from "./app-state";
import { Spinner, ToastHost } from "./components";
import { DialogHost } from "./dialogs";
import { Icon } from "./icons";
import { call, onBroadcast } from "./rpc";
import { itemKey } from "./util";
import { AccountsView } from "./views/Accounts";
import { AddAccountView, isActiveFlow } from "./views/AddAccount";
import { GeneratorHistoryView, GeneratorView } from "./views/Generator";
import { ToolsView } from "./views/Tools";
import { SendEditView } from "./views/Send";
import { ItemDetailView } from "./views/ItemDetail";
import { ItemEditView } from "./views/ItemEdit";
import { LockView } from "./views/Lock";
import { SettingsView } from "./views/Settings";
import { TrashView } from "./views/Trash";
import { ArchiveView } from "./views/Archive";
import { AssignView } from "./views/Assign";
import { FoldersView } from "./views/Folders";
import { ExportView, ImportView } from "./views/Transfer";
import { ChangePasswordView, RemovePasswordView } from "./views/ChangePassword";
import { AuthRequestsView, DevicesView } from "./views/Security";
import { AtRiskView } from "./views/AtRisk";
import { VaultView } from "./views/Vault";

import { setLanguage, t } from "../shared/i18n";
import { applyAppearance } from "../shared/appearance";
const EMPTY_VAULT: VaultData = { items: [], folders: [], collections: [], organizations: [] };
const params = new URLSearchParams(location.search);
/** a separate window or the sidebar (Firefox / Opera): stays open, takes the full size */
const sidebar = params.has("sidebar");
const popout = params.has("popout") || sidebar;

/** "New item" from the inline menu / context menu: popup.html?popout=1&add=<type>&uri=<page> */
function addRoute(): Route | null {
  const type = Number(params.get("add"));
  if (!type) return null;
  const uri = params.get("uri") ?? "";
  if (type !== CipherType.Login || !uri) return { name: "edit", newType: type };
  let host = "";
  try {
    host = new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    /* ignore */
  }
  return {
    name: "edit",
    newType: type,
    prefill: { login: { uris: [{ uri: uri.split("?")[0] }], passkeys: 0 } as any, name: host },
  };
}
let addPending =
  addRoute() ??
  (params.get("route") === "authRequests"
    ? ({ name: "authRequests" } as Route)
    : params.get("route") === "sendFile" && params.get("account")
      ? ({ name: "sendEdit", accountKey: params.get("account")!, type: 1 } as Route)
      : params.get("bio") === "enable"
        ? ({ name: "settings", section: "security" } as Route)
        : null);

function applyPrefs(st: StateResponse) {
  setLanguage(st.settings.language);
  applyAppearance(st.settings);
  const w = st.settings.popupWidth ?? "default";
  document.documentElement.classList.toggle("w-wide", w === "wide");
  document.documentElement.classList.toggle("w-xwide", w === "extraWide");
}

async function loadUiState(): Promise<{ filters?: Filters; showFilters?: boolean }> {
  try {
    const r = await chrome.storage.session.get("popupUi");
    return (r.popupUi as any) ?? {};
  } catch {
    return {};
  }
}

function saveUiState(v: { filters: Filters; showFilters: boolean }) {
  try {
    chrome.storage.session.set({ popupUi: v });
  } catch {
    /* ignore */
  }
}

export function App() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [vault, setVault] = useState<VaultData>(EMPTY_VAULT);
  const [vaultLoading, setVaultLoading] = useState(false);
  const [page, setPage] = useState<PageMatch>({ url: "", host: "", itemIds: [] });
  const [stack, setStack] = useState<Route[]>([]);
  const [filters, setFiltersRaw] = useState<Filters>(EMPTY_FILTERS);
  const [showFilters, setShowFiltersRaw] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** an interactive login (SSO, Duo, security key …) is running → show it first */
  const [flowActive, setFlowActive] = useState<boolean | null>(null);
  const uiLoaded = useRef(false);

  const reload = useCallback(async () => {
    try {
      const s = await call("getState", {});
      setState(s);
      applyPrefs(s);
      return;
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const reloadVault = useCallback(async () => {
    setVaultLoading(true);
    try {
      const [v, p] = await Promise.all([
        call("getVault", {}),
        call("getPageMatches", {}).catch(() => ({ url: "", host: "", itemIds: [] })),
      ]);
      setVault(v);
      setPage(p);
    } finally {
      setVaultLoading(false);
    }
  }, []);

  // initial load
  useEffect(() => {
    if (popout) document.body.classList.add("popout");
    if (sidebar) document.body.classList.add("sidebar");
    (async () => {
      const ui = await loadUiState();
      if (ui.filters) setFiltersRaw({ ...EMPTY_FILTERS, ...ui.filters });
      if (ui.showFilters !== undefined) setShowFiltersRaw(ui.showFilters);
      uiLoaded.current = true;
      const [, f] = await Promise.all([reload(), call("loginGet", {}).catch(() => null)]);
      setFlowActive(isActiveFlow(f));
    })();
    const off = onBroadcast((ev) => {
      if (ev === "stateChanged" || ev === "locked") reload();
      if (ev === "vaultChanged" || ev === "locked") reloadVault();
      // the login window may already be open with another view when a flow continues there
      if (ev === "loginFlowChanged" && popout)
        call("loginGet", {})
          .then((f) => {
            if (isActiveFlow(f)) setStack((s) => (s[s.length - 1]?.name === "addAccount" ? s : [...s, { name: "addAccount" }]));
          })
          .catch(() => {});
    });
    call("touch", {}).catch(() => {});
    // the sidebar stays open while the user browses: keep the "suggestions for this page" current
    let offTabs = () => {};
    if (sidebar && chrome.tabs?.onActivated) {
      const refreshPage = () =>
        call("getPageMatches", {})
          .then(setPage)
          .catch(() => {});
      const onUpd = (_id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
        if (tab.active && (info.status === "complete" || info.url)) refreshPage();
      };
      chrome.tabs.onActivated.addListener(refreshPage);
      chrome.tabs.onUpdated.addListener(onUpd);
      offTabs = () => {
        chrome.tabs.onActivated.removeListener(refreshPage);
        chrome.tabs.onUpdated.removeListener(onUpd);
      };
    }
    return () => {
      off();
      offTabs();
    };
  }, []);

  const anyUnlocked = !!state?.accounts.some((a) => a.status === "unlocked");

  // initial route once state is known
  useEffect(() => {
    if (!state || flowActive === null) return;
    if (stack.length === 0) {
      if (state.accounts.length === 0 || flowActive) setStack([{ name: "addAccount" }]);
      else if (!anyUnlocked) setStack([{ name: "lock" }]);
      else if (addPending) {
        setStack([{ name: addPending.name === "sendEdit" ? "tools" : "vault" }, addPending]);
        addPending = null;
      } else setStack([{ name: "vault" }]);
    } else {
      // vault became completely locked → lock screen
      const cur = stack[stack.length - 1];
      if (state.accounts.length === 0 && cur.name !== "addAccount") setStack([{ name: "addAccount" }]);
      else if (state.accounts.length && !anyUnlocked && !["lock", "addAccount", "settings", "accounts"].includes(cur.name))
        setStack([{ name: "lock" }]);
    }
  }, [state, flowActive]);

  // "new item" requested while the vault was locked → open the editor after unlocking
  const topName = stack[stack.length - 1]?.name;
  useEffect(() => {
    if (anyUnlocked && addPending && topName === "vault") {
      const r = addPending;
      addPending = null;
      setStack((s) => [...s, r]);
    }
  }, [topName, anyUnlocked]);

  useEffect(() => {
    if (anyUnlocked) reloadVault();
    else setVault(EMPTY_VAULT);
  }, [anyUnlocked, state?.accounts.map((a) => a.key + a.status).join(",")]);

  const setFilters = (f: Filters) => {
    setFiltersRaw(f);
    if (uiLoaded.current) saveUiState({ filters: f, showFilters });
  };
  const setShowFilters = (v: boolean) => {
    setShowFiltersRaw(v);
    if (uiLoaded.current) saveUiState({ filters, showFilters: v });
  };

  // drop filters that point to accounts that no longer exist
  useEffect(() => {
    if (state && filters.account && !state.accounts.some((a) => a.key === filters.account)) setFilters({ ...filters, account: null });
  }, [state]);

  const itemMap = useMemo(() => new Map(vault.items.map((i) => [itemKey(i), i])), [vault]);

  if (error)
    return (
      <div class="empty">
        <Icon name="alert" size={28} />
        {error}
      </div>
    );
  if (!state || stack.length === 0)
    return (
      <div class="empty" style={{ paddingTop: 200 }}>
        <Spinner />
      </div>
    );

  const route = stack[stack.length - 1];
  const accountMap = new Map(state.accounts.map((a) => [a.key, a]));
  const ctx: AppCtxValue = {
    state,
    vault,
    vaultLoading,
    accounts: state.accounts,
    accountMap,
    page,
    route,
    go: (r, replace) => setStack((s) => (replace ? [...s.slice(0, -1), r] : [...s, r])),
    back: () =>
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : [{ name: anyUnlocked ? "vault" : state.accounts.length ? "lock" : "addAccount" }])),
    reload,
    reloadVault,
    filters,
    setFilters,
    search,
    setSearch,
    showFilters,
    setShowFilters,
    popout,
    itemByKey: (k) => itemMap.get(k),
  };

  const tabRoot = (r: Route) => setStack([r]);
  const showTabs = ["vault", "generator", "tools", "settings"].includes(route.name) && anyUnlocked;

  let view;
  switch (route.name) {
    case "vault":
      view = <VaultView />;
      break;
    case "item":
      view = <ItemDetailView key={route.key} itemKeyStr={route.key} />;
      break;
    case "edit":
      view = <ItemEditView key={(route.key ?? "new") + (route.newType ?? "")} route={route} />;
      break;
    case "generator":
      view = <GeneratorView />;
      break;
    case "settings":
      view = <SettingsView key={route.section ?? ""} section={route.section} />;
      break;
    case "tools":
      view = <ToolsView />;
      break;
    case "sendEdit":
      view = <SendEditView key={(route.id ?? "new") + (route.type ?? "")} route={route} />;
      break;
    case "accounts":
      view = <AccountsView />;
      break;
    case "addAccount":
      view = <AddAccountView route={route} />;
      break;
    case "lock":
      view = <LockView only={route.only} />;
      break;
    case "trash":
      view = <TrashView />;
      break;
    case "archive":
      view = <ArchiveView />;
      break;
    case "genHistory":
      view = <GeneratorHistoryView />;
      break;
    case "export":
      view = <ExportView />;
      break;
    case "changePassword":
      view = <ChangePasswordView accountKey={route.accountKey} />;
      break;
    case "removePassword":
      view = <RemovePasswordView accountKey={route.accountKey} />;
      break;
    case "authRequests":
      view = <AuthRequestsView />;
      break;
    case "devices":
      view = <DevicesView />;
      break;
    case "atRisk":
      view = <AtRiskView />;
      break;
    case "import":
      view = <ImportView />;
      break;
    case "folders":
      view = <FoldersView />;
      break;
    case "assign":
      view = <AssignView itemKeyStr={route.key} />;
      break;
  }

  return (
    <AppCtx.Provider value={ctx}>
      <ToastHost>
        <DialogHost>
          <div class="app" onClick={throttledTouch}>
            {view}
            {showTabs && (
              <nav class="tabs" aria-label={t("Navigation")}>
                <button class={route.name === "vault" ? "on" : ""} onClick={() => tabRoot({ name: "vault" })}>
                  <Icon name="vault" size={20} />
                  {t("Tresor")}
                </button>
                <button class={route.name === "generator" ? "on" : ""} onClick={() => tabRoot({ name: "generator" })}>
                  <Icon name="wand" size={20} />
                  {t("Generator")}
                </button>
                <button class={route.name === "tools" ? "on" : ""} onClick={() => tabRoot({ name: "tools" })} data-testid="tab-tools">
                  <Icon name="wrench" size={20} />
                  {t("Tools")}
                </button>
                <button class={route.name === "settings" ? "on" : ""} onClick={() => tabRoot({ name: "settings" })}>
                  <Icon name="settings" size={20} />
                  {t("Einstellungen")}
                </button>
              </nav>
            )}
          </div>
        </DialogHost>
      </ToastHost>
    </AppCtx.Provider>
  );
}

let lastTouch = 0;
function throttledTouch() {
  const now = Date.now();
  if (now - lastTouch > 30_000) {
    lastTouch = now;
    call("touch", {}).catch(() => {});
  }
}
