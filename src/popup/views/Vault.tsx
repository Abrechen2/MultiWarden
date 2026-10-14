import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AccountPublic, CipherType, ItemView } from "../../shared/types";
import { canCreateIn } from "./ItemEdit";
import { useAtRiskItems } from "./AtRisk";
import { useApp } from "../app-state";
import { CREATABLE_TYPES } from "./item-fields";
import { AccountBadge, Avatar, ChipOption, ChipSelect, ItemIcon, MenuItem, Popover, Spinner, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";
import { compareItems, itemKey, searchMatch, subtitle, TYPE_ICON, TYPE_LABEL } from "../util";
import { useItemActions } from "./item-actions";

import { t } from "../../shared/i18n";
const PAGE = 150;
/** pseudo type of the type filter: logins with a passkey */
const PASSKEY_FILTER = "passkey";
/** item types the type filter always offers (like the official clients, plus the newer experimental ones) */
const FILTER_TYPES = [
  CipherType.Login,
  CipherType.SecureNote,
  CipherType.Card,
  CipherType.Identity,
  CipherType.SshKey,
  CipherType.BankAccount,
  CipherType.DriversLicense,
  CipherType.Passport,
];

export function VaultView() {
  const app = useApp();
  const { vault, filters, setFilters, accounts, accountMap, search, setSearch, showFilters, setShowFilters } = app;
  const unlocked = accounts.filter((a) => a.status === "unlocked");
  const lockedCount = accounts.filter((a) => a.status !== "unlocked").length;
  const atRisk = useAtRiskItems();
  const multi = accounts.length > 1;
  const [addOpen, setAddOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const acctRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const folderName = useMemo(() => {
    const m = new Map(vault.folders.map((f) => [f.accountKey + "::" + f.id, f.name]));
    return (i: ItemView) => (i.folderId ? m.get(i.accountKey + "::" + i.folderId) : undefined);
  }, [vault]);

  const inAccount = (x: { accountKey: string }) => !filters.account || x.accountKey === filters.account;

  // ---- filter options ----
  const accountOptions: ChipOption[] = unlocked.map((a) => ({
    value: a.key,
    label: a.label,
    meta: a.serverLabel,
    lead: <Avatar acc={a} size="sm" />,
  }));

  /** accounts of an entry, in the order of the account list (only shown with more than one account) */
  const accsOf = (keys: Set<string>) => (multi ? accounts.filter((a) => keys.has(a.key)) : undefined);

  const orgOptions: ChipOption[] = useMemo(() => {
    const byId = new Map<string, { name: string; keys: Set<string> }>();
    for (const o of vault.organizations.filter(inAccount)) {
      const g = byId.get(o.id) ?? { name: o.name, keys: new Set<string>() };
      g.keys.add(o.accountKey);
      byId.set(o.id, g);
    }
    const out: ChipOption[] = [{ value: "personal", label: t("Mein Tresor"), icon: "user" }];
    for (const [id, g] of byId) out.push({ value: "org:" + id, label: g.name, icon: "building", accounts: accsOf(g.keys) });
    return out;
  }, [vault, filters.account, accounts]);

  const collectionOptions: ChipOption[] = useMemo(() => {
    const orgFilter = filters.vault?.startsWith("org:") ? filters.vault.slice(4) : null;
    const byId = new Map<string, { name: string; org: string; keys: Set<string> }>();
    for (const c of vault.collections.filter(inAccount)) {
      if (orgFilter && c.organizationId !== orgFilter) continue;
      const g = byId.get(c.id) ?? { name: c.name, org: c.organizationId, keys: new Set<string>() };
      g.keys.add(c.accountKey);
      byId.set(c.id, g);
    }
    const byOrg = new Map<string, { name: string; cols: { id: string; name: string; keys: Set<string> }[] }>();
    for (const [id, c] of byId) {
      const org = vault.organizations.find((o) => o.id === c.org);
      const g = byOrg.get(c.org) ?? { name: org?.name ?? "Organisation", cols: [] };
      g.cols.push({ id, name: c.name, keys: c.keys });
      byOrg.set(c.org, g);
    }
    const out: ChipOption[] = [];
    for (const g of byOrg.values()) {
      if (byOrg.size > 1) out.push({ value: "", label: g.name, header: true });
      g.cols.sort((a, b) => a.name.localeCompare(b.name, "de"));
      for (const c of g.cols) {
        const parts = c.name.split("/");
        out.push({ value: c.id, label: parts[parts.length - 1], indent: parts.length - 1, icon: "collection", accounts: accsOf(c.keys) });
      }
    }
    return out;
  }, [vault, filters.account, filters.vault, accounts]);

  const folderOptions: ChipOption[] = useMemo(() => {
    const names = new Map<string, { name: string; keys: Set<string> }>();
    for (const f of vault.folders.filter(inAccount)) {
      const k = f.name.toLocaleLowerCase("de");
      const g = names.get(k) ?? { name: f.name, keys: new Set<string>() };
      g.keys.add(f.accountKey);
      names.set(k, g);
    }
    const out: ChipOption[] = [...names.entries()]
      .sort((a, b) => a[1].name.localeCompare(b[1].name, "de"))
      .map(([k, g]) => {
        const parts = g.name.split("/");
        return {
          value: "name:" + k,
          label: parts[parts.length - 1],
          indent: parts.length - 1,
          icon: "folder" as const,
          accounts: accsOf(g.keys),
        };
      });
    out.push({ value: "none", label: t("Kein Ordner"), icon: "folder" });
    return out;
  }, [vault, filters.account, accounts]);

  const typeOptions: ChipOption[] = useMemo(() => {
    const present = new Set(vault.items.filter((i) => !i.deletedDate && inAccount(i)).map((i) => i.type));
    // all known types, including the newer ones (SSH key, bank account, driver's license, passport)
    FILTER_TYPES.forEach((tx) => present.add(tx));
    const out: ChipOption[] = [...present]
      .sort((a, b) => a - b)
      .map((tx) => ({ value: String(tx), label: TYPE_LABEL[tx] ?? t("Typ {n}", { n: tx }), icon: TYPE_ICON[tx] ?? "note" }));
    // logins that have a passkey
    out.splice(out.findIndex((o) => o.value === String(CipherType.Login)) + 1, 0, {
      value: PASSKEY_FILTER,
      label: t("Login mit Passkey"),
      icon: "passkey",
    });
    return out;
  }, [vault, filters.account]);

  // ---- filtering ----
  const passes = (i: ItemView) => {
    if (i.deletedDate || i.archivedDate) return false;
    if (filters.account && i.accountKey !== filters.account) return false;
    if (filters.vault === "personal" && i.organizationId) return false;
    if (filters.vault?.startsWith("org:") && i.organizationId !== filters.vault.slice(4)) return false;
    if (filters.collection && !i.collectionIds.includes(filters.collection)) return false;
    if (filters.folder) {
      if (filters.folder === "none") {
        if (i.folderId) return false;
      } else {
        const fn = folderName(i);
        if (!fn || fn.toLocaleLowerCase("de") !== filters.folder.slice(5)) return false;
      }
    }
    if (filters.type === PASSKEY_FILTER) {
      if (i.type !== CipherType.Login || !(i.login?.passkeys ?? 0)) return false;
    } else if (filters.type && String(i.type) !== filters.type) return false;
    return true;
  };

  const filtered = useMemo(() => vault.items.filter(passes).sort(compareItems), [vault, filters, folderName]);
  const results = useMemo(() => (search ? filtered.filter((i) => searchMatch(i, search)) : filtered), [filtered, search]);
  const suggestions = useMemo(() => {
    const set = new Set(app.page.itemIds);
    const order = new Map(app.page.itemIds.map((k, idx) => [k, idx]));
    const logins = filtered.filter((i) => set.has(itemKey(i))).sort((a, b) => order.get(itemKey(a))! - order.get(itemKey(b))!);
    if (!app.page.host) return logins;
    // cards and identities can be filled on any page
    const st = app.state.settings;
    const extra = filtered.filter(
      (i) => (st.suggestCards && i.type === CipherType.Card) || (st.suggestIdentities && i.type === CipherType.Identity),
    );
    return [...logins, ...extra];
  }, [filtered, app.page, app.state.settings]);
  const loginSuggestions = suggestions.filter((i) => i.type === CipherType.Login).length;
  const favorites = useMemo(() => filtered.filter((i) => i.favorite), [filtered]);

  const anyFilter = !!(filters.account || filters.vault || filters.collection || filters.folder || filters.type);

  useEffect(() => setLimit(PAGE), [search, filters]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => {
      if (e[0].isIntersecting) setLimit((l) => l + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [results.length, limit]);

  const setF = (k: keyof typeof filters, v: string | null) => {
    const next = { ...filters, [k]: v };
    // keep dependent filters consistent
    if (k === "account") {
      next.collection = null;
      if (v && filters.vault?.startsWith("org:") && !vault.organizations.some((o) => o.accountKey === v && "org:" + o.id === filters.vault))
        next.vault = null;
      if (
        v &&
        filters.folder &&
        filters.folder !== "none" &&
        !vault.folders.some((f) => f.accountKey === v && "name:" + f.name.toLocaleLowerCase("de") === filters.folder)
      )
        next.folder = null;
    }
    if (k === "vault" && v !== filters.vault) next.collection = null;
    if (k === "collection" && v) {
      const c = vault.collections.find((x) => x.id === v);
      if (c && filters.vault === "personal") next.vault = null;
    }
    setFilters(next);
  };

  const showSections = !search && !anyFilter;

  return (
    <>
      <div class="topbar">
        <h1>{t("Tresor")}</h1>
        <button class="btn btn-primary btn-sm" ref={addRef} onClick={() => setAddOpen(true)} data-testid="add">
          <Icon name="plus" size={16} />
          {t("Hinzufügen")}
        </button>
        {!app.popout && (
          <button
            class="icon-btn"
            title={t("In eigenem Fenster öffnen")}
            onClick={() => {
              chrome.windows.create({ url: chrome.runtime.getURL("popup.html?popout=1"), type: "popup", width: 420, height: 680 });
              window.close();
            }}
          >
            <Icon name="popout" size={18} />
          </button>
        )}
        <button class="avatar-stack" ref={acctRef} onClick={() => setAcctOpen(true)} title={t("Konten")} data-testid="accounts-menu">
          {accounts.slice(0, 3).map((a) => (
            <Avatar acc={a} key={a.key} />
          ))}
          {accounts.length > 3 && (
            <span class="avatar" style={{ background: "var(--text-faint)" }}>
              <span class="ini">+{accounts.length - 3}</span>
            </span>
          )}
        </button>
      </div>
      {addOpen && (
        <Popover anchor={addRef.current} onClose={() => setAddOpen(false)} align="end">
          {CREATABLE_TYPES.filter((tx) =>
            app.accounts.some((a) => a.status === "unlocked" && canCreateIn(a, tx, app.vault.organizations)),
          ).map((tx) => (
            <MenuItem
              key={tx}
              icon={TYPE_ICON[tx]}
              onClick={() => {
                setAddOpen(false);
                app.go({ name: "edit", newType: tx, accountKey: filters.account ?? undefined });
              }}
            >
              {TYPE_LABEL[tx]}
            </MenuItem>
          ))}
        </Popover>
      )}
      {acctOpen && <AccountsPopover anchor={acctRef.current} onClose={() => setAcctOpen(false)} />}

      <main>
        {app.accounts
          .filter((a) => a.status === "unlocked" && a.forcePasswordChange)
          .map((a) => (
            <div class="banner warn" key={"fpc" + a.key} data-testid="force-password-banner">
              <Icon name="key" size={16} />
              <span class="grow">{t("{account}: Das Master-Passwort muss geändert werden.", { account: a.label })}</span>
              <button class="btn btn-secondary btn-sm" onClick={() => app.go({ name: "changePassword", accountKey: a.key })}>
                {t("Ändern")}
              </button>
            </div>
          ))}
        {atRisk.length > 0 && (
          <div class="banner warn" data-testid="at-risk-banner">
            <Icon name="alert" size={16} />
            <span class="grow">
              {atRisk.length === 1
                ? t("Deine Organisation bittet dich, 1 gefährdetes Passwort zu ändern.")
                : t("Deine Organisation bittet dich, {n} gefährdete Passwörter zu ändern.", { n: atRisk.length })}
            </span>
            <button class="btn btn-secondary btn-sm" onClick={() => app.go({ name: "atRisk" })}>
              {t("Ansehen")}
            </button>
          </div>
        )}
        {app.accounts
          .filter((a) => a.status === "unlocked" && a.kcMigration)
          .map((a) => (
            <div class="banner warn" key={"kc" + a.key} data-testid="kc-migration-banner">
              <Icon name="building" size={16} />
              <span class="grow">
                {t("{account}: {org} braucht kein Master-Passwort mehr.", { account: a.label, org: a.kcMigration!.orgName })}
              </span>
              <button class="btn btn-secondary btn-sm" onClick={() => app.go({ name: "removePassword", accountKey: a.key })}>
                {t("Weiter")}
              </button>
            </div>
          ))}
        {lockedCount > 0 && (
          <div class="banner warn" data-testid="locked-banner">
            <Icon name="lock" size={16} />
            <span class="grow">
              {lockedCount === 1
                ? t("1 Konto ist gesperrt oder abgemeldet.")
                : t("{n} Konten sind gesperrt oder abgemeldet.", { n: lockedCount })}
            </span>
            <button class="btn btn-secondary btn-sm" onClick={() => app.go({ name: "lock" })}>
              {t("Entsperren")}
            </button>
          </div>
        )}
        <div class="searchrow">
          <div class="search">
            <Icon name="search" size={16} />
            <input
              ref={searchRef}
              type="search"
              placeholder={t("Suche")}
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              aria-label={t("Tresor durchsuchen")}
              data-testid="search"
            />
          </div>
          <button
            class={"icon-btn filter-toggle" + (showFilters || anyFilter ? " active" : "")}
            onClick={() => setShowFilters(!showFilters)}
            title={showFilters ? t("Filter ausblenden") : t("Filter anzeigen")}
            aria-pressed={showFilters}
          >
            <Icon name="sliders" size={20} />
          </button>
        </div>
        {showFilters && (
          <div class="filters" data-testid="filters">
            {multi && (
              <ChipSelect
                class="full"
                icon="users"
                placeholder={t("Konto")}
                value={filters.account}
                options={accountOptions}
                onChange={(v) => setF("account", v)}
                testid="filter-account"
              />
            )}
            <ChipSelect
              icon="vault"
              placeholder={t("Tresor")}
              value={filters.vault}
              options={orgOptions}
              onChange={(v) => setF("vault", v)}
              testid="filter-vault"
            />
            <ChipSelect
              icon="collection"
              placeholder={t("Sammlung")}
              value={filters.collection}
              options={collectionOptions}
              onChange={(v) => setF("collection", v)}
              testid="filter-collection"
            />
            <ChipSelect
              icon="folder"
              placeholder={t("Ordner")}
              value={filters.folder}
              options={folderOptions}
              onChange={(v) => setF("folder", v)}
              testid="filter-folder"
            />
            <ChipSelect
              icon="list"
              placeholder={t("Typ")}
              value={filters.type}
              options={typeOptions}
              onChange={(v) => setF("type", v)}
              testid="filter-type"
            />
          </div>
        )}

        {app.vaultLoading && vault.items.length === 0 ? (
          <div class="empty">
            <Spinner />
          </div>
        ) : (
          <>
            {showSections && (suggestions.length > 0 || !!app.page.host) && (
              <section class="section" data-testid="suggestions">
                <div class="section-head">
                  <h2>
                    {t("Autofill-Vorschläge")}
                    {app.page.host && (
                      <span class="muted small" style={{ fontWeight: 500, marginLeft: 6 }}>
                        {app.page.host}
                      </span>
                    )}
                  </h2>
                  <span class="count">{suggestions.length}</span>
                </div>
                <div class="card">
                  {app.page.host && loginSuggestions === 0 && (
                    <div
                      class="row"
                      data-testid="add-login-for-page"
                      onClick={() =>
                        app.go({
                          name: "edit",
                          newType: CipherType.Login,
                          prefill: {
                            login: { uris: [{ uri: app.page.url.split("?")[0] }], passkeys: 0 } as any,
                            name: app.page.host.replace(/^www\./, ""),
                          },
                        })
                      }
                    >
                      <span class="item-icon">
                        <Icon name="plus" size={18} />
                      </span>
                      <div class="text">
                        <div class="title">{t("Keine passenden Logins")}</div>
                        <div class="subtitle">{t("Login für {host} hinzufügen", { host: app.page.host })}</div>
                      </div>
                    </div>
                  )}
                  {suggestions.map((i) => (
                    <ItemRow item={i} key={itemKey(i)} suggestion multi={multi} />
                  ))}
                </div>
              </section>
            )}
            {showSections && favorites.length > 0 && (
              <ItemSection title={t("Favoriten")} items={favorites} multi={multi} testid="favorites" />
            )}
            {results.length > 0 ? (
              <ItemSection
                title={showSections ? t("Alle Einträge") : t("Ergebnisse")}
                items={results.slice(0, limit)}
                total={results.length}
                multi={multi}
                testid="all-items"
              />
            ) : (
              <div class="empty" data-testid="no-results">
                <Icon name={search ? "search" : "vault"} size={32} />
                {search || anyFilter ? t("Keine passenden Einträge gefunden.") : t("Dein Tresor ist leer.")}
                {anyFilter && (
                  <div style={{ marginTop: 10 }}>
                    <button
                      class="btn btn-ghost btn-sm"
                      onClick={() => setFilters({ account: null, vault: null, collection: null, folder: null, type: null })}
                    >
                      {t("Filter zurücksetzen")}
                    </button>
                  </div>
                )}
              </div>
            )}
            {results.length > limit && <div ref={sentinel} style={{ height: 20 }} />}
          </>
        )}
      </main>
    </>
  );
}

function ItemSection({
  title,
  items,
  total,
  suggestion,
  multi,
  testid,
  sub,
}: {
  title: string;
  items: ItemView[];
  total?: number;
  suggestion?: boolean;
  multi: boolean;
  testid?: string;
  sub?: string;
}) {
  return (
    <section class="section" data-testid={testid}>
      <div class="section-head">
        <h2>
          {title}
          {sub && (
            <span class="muted small" style={{ fontWeight: 500, marginLeft: 6 }}>
              {sub}
            </span>
          )}
        </h2>
        <span class="count">{total ?? items.length}</span>
      </div>
      <div class="card">
        {items.map((i) => (
          <ItemRow item={i} key={itemKey(i)} suggestion={suggestion} multi={multi} />
        ))}
      </div>
    </section>
  );
}

export function ItemRow({ item, suggestion, multi }: { item: ItemView; suggestion?: boolean; multi: boolean }) {
  const app = useApp();
  const acc = app.accountMap.get(item.accountKey);
  const actions = useItemActions(item);
  const [copyOpen, setCopyOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const copyOptions = actions.copyOptions();
  const settings = app.state.settings;
  // suggestions only have room for the quick-copy buttons next to "Ausfüllen" in the wide layouts
  const showQuickCopy = settings.quickCopy && (!suggestion || settings.popupWidth === "wide" || settings.popupWidth === "extraWide");
  // quick copy only for fields with their own symbol (username, password, TOTP) – a row of identical copy
  // buttons (identities, cards …) does not tell which field it copies
  const quickCopies = copyOptions.filter((o) => o.icon).slice(0, 3);
  // the "more" menu always starts with copying username, password and TOTP (logins)
  const menuCopies =
    item.type === CipherType.Login
      ? [
          { label: t("Benutzername kopieren"), opt: copyOptions.find((o) => o.icon === "user"), id: "username" },
          { label: t("Passwort kopieren"), opt: copyOptions.find((o) => o.icon === "key"), id: "password" },
          { label: t("TOTP kopieren"), opt: copyOptions.find((o) => o.icon === "clock"), id: "totp" },
        ].filter((c) => c.opt)
      : [];
  return (
    <div
      class="row"
      onClick={() => app.go({ name: "item", key: itemKey(item) })}
      data-testid="item-row"
      data-type={item.type}
      data-name={item.name}
      data-account={acc?.email}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) app.go({ name: "item", key: itemKey(item) });
      }}
    >
      <ItemIcon item={item} acc={acc} favicons={app.state.settings.showFavicons} />
      <div class="text">
        <div class="title">
          <span class="t">{item.name || t("(ohne Namen)")}</span>
          {item.favorite && <Icon name="star" size={12} class="fav" filled />}
          {item.organizationId && <Icon name="building" size={12} class="muted" />}
        </div>
        <div class="subtitle">
          {multi && <AccountBadge acc={acc} />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle(item)}</span>
        </div>
      </div>
      <div class="actions" onClick={(e) => e.stopPropagation()}>
        {showQuickCopy &&
          quickCopies.map((o) => (
            <button
              key={o.label}
              class="icon-btn sm"
              title={t("{label} kopieren", { label: o.label })}
              aria-label={t("{label} kopieren", { label: o.label })}
              onClick={() => o.run()}
              data-testid="quick-copy"
            >
              <Icon name={o.icon ?? "copy"} size={15} />
            </button>
          ))}
        {copyOptions.length > 0 && !suggestion && !settings.quickCopy && (
          <button
            class="icon-btn sm"
            ref={copyRef}
            title={t("Kopieren")}
            aria-label={t("Kopieren")}
            onClick={() => (copyOptions.length === 1 ? copyOptions[0].run() : setCopyOpen(true))}
          >
            <Icon name="copy" size={16} />
          </button>
        )}
        {suggestion && actions.canFill && (
          <button class="btn btn-secondary btn-sm" onClick={() => actions.fill()} data-testid="fill">
            {t("Ausfüllen")}
          </button>
        )}
        <button
          class="icon-btn sm"
          ref={moreRef}
          title={t("Weitere Optionen")}
          aria-label={t("Weitere Optionen")}
          onClick={() => setMoreOpen(true)}
        >
          <Icon name="more" size={16} />
        </button>
      </div>
      {/* menus live inside the row: keep their clicks (and the backdrop) from opening the item */}
      <div style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
        {copyOpen && (
          <Popover anchor={copyRef.current} onClose={() => setCopyOpen(false)} align="end">
            {copyOptions.map((o) => (
              <MenuItem
                key={o.label}
                icon="copy"
                onClick={() => {
                  setCopyOpen(false);
                  o.run();
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          </Popover>
        )}
        {moreOpen && (
          <Popover anchor={moreRef.current} onClose={() => setMoreOpen(false)} align="end">
            {menuCopies.map((c) => (
              <MenuItem
                key={c.id}
                icon="copy"
                onClick={() => {
                  setMoreOpen(false);
                  c.opt!.run();
                }}
              >
                <span data-testid={"menu-copy-" + c.id}>{c.label}</span>
              </MenuItem>
            ))}
            {menuCopies.length > 0 && <div class="menu-sep" />}
            {actions.canFill && (
              <MenuItem
                icon="fill"
                onClick={() => {
                  setMoreOpen(false);
                  actions.fill();
                }}
              >
                {t("Ausfüllen")}
              </MenuItem>
            )}
            {actions.launch && (
              <MenuItem
                icon="external"
                onClick={() => {
                  setMoreOpen(false);
                  actions.launch!();
                }}
              >
                {t("Website öffnen")}
              </MenuItem>
            )}
            <MenuItem
              icon="eye"
              onClick={() => {
                setMoreOpen(false);
                app.go({ name: "item", key: itemKey(item) });
              }}
            >
              {t("Ansehen")}
            </MenuItem>
            {item.edit && (
              <MenuItem
                icon="pencil"
                onClick={() => {
                  setMoreOpen(false);
                  app.go({ name: "edit", key: itemKey(item) });
                }}
              >
                {t("Bearbeiten")}
              </MenuItem>
            )}
            <MenuItem
              icon="star"
              onClick={() => {
                setMoreOpen(false);
                actions.toggleFavorite();
              }}
            >
              {item.favorite ? t("Aus Favoriten entfernen") : t("Zu Favoriten hinzufügen")}
            </MenuItem>
            {multi && acc && (
              <>
                <div class="menu-sep" />
                <div class="menu-head" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 600 }}>
                  {t("Konto:")} {acc.label} · {acc.serverLabel}
                </div>
              </>
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}

function AccountsPopover({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" width={300}>
      <div class="menu-head">{t("Konten")}</div>
      {app.accounts.map((a: AccountPublic) => (
        <MenuItem
          key={a.key}
          lead={<Avatar acc={a} size="sm" showState />}
          meta={a.status === "unlocked" ? undefined : a.status === "locked" ? t("gesperrt") : t("abgemeldet")}
          onClick={() => {
            onClose();
            if (a.status === "unlocked")
              app.setFilters({ ...app.filters, account: app.filters.account === a.key ? null : a.key, collection: null });
            else app.go({ name: "lock", only: [a.key] });
          }}
          checked={app.filters.account === a.key}
        >
          <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{a.label}</div>
          <div class="meta" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {a.serverLabel}
          </div>
        </MenuItem>
      ))}
      <div class="menu-sep" />
      <MenuItem
        icon="plus"
        onClick={() => {
          onClose();
          app.go({ name: "addAccount" });
        }}
      >
        {t("Konto hinzufügen")}
      </MenuItem>
      <MenuItem
        icon="refresh"
        onClick={async () => {
          onClose();
          toast.show(t("Synchronisiere …"));
          const r = await call("sync", {});
          toast.show(r.ok ? t("Alle Konten synchronisiert") : t("Synchronisierung teilweise fehlgeschlagen"), r.ok ? "ok" : "error");
        }}
      >
        {t("Jetzt synchronisieren")}
      </MenuItem>
      <MenuItem
        icon="users"
        onClick={() => {
          onClose();
          app.go({ name: "accounts" });
        }}
      >
        {t("Konten verwalten")}
      </MenuItem>
      <MenuItem
        icon="lock"
        onClick={async () => {
          onClose();
          await call("lock", {});
        }}
      >
        {t("Alle sperren")}
      </MenuItem>
    </Popover>
  );
}
