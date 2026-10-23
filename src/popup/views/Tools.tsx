// "Tools" tab: several tools side by side (like the generator modes).
import { useEffect, useMemo, useState } from "preact/hooks";
import { compareGroup, findDuplicates, DuplicateMode } from "../../shared/duplicates";
import { Evidence, assessGroup, GroupAssessment } from "../../shared/dup-evidence";
import { t } from "../../shared/i18n";
import { CipherType, ItemView } from "../../shared/types";
import { useApp } from "../app-state";
import { AccountBadge, ItemIcon, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { formatDate, itemKey, TYPE_LABEL } from "../util";
import { DupCompareSummary, DupEvidenceLine, DupItemDiffs, fieldLabel } from "./dup-compare";
import { SendTool } from "./Send";
import { PasswordReportTool } from "./PasswordReport";
import { isSendLink, SendReceiveTool } from "./SendReceive";
import { ALL_ACCOUNTS, AccountSelect, useToolAccount } from "./tool-account";

type Tab = "duplicates" | "report" | "send" | "receive";
const TABS: Tab[] = ["duplicates", "report", "send", "receive"];
const TAB_KEY = "mwToolsTab";

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY) as Tab;
    return TABS.includes(v) ? v : "duplicates";
  } catch {
    return "duplicates";
  }
}

export function ToolsView() {
  const app = useApp();
  // a Send link in the current tab opens "Empfangen" right away
  const [tab, setTab] = useState<Tab>(() => (isSendLink(app.page.url) ? "receive" : loadTab()));
  const choose = (v: Tab) => {
    setTab(v);
    try {
      localStorage.setItem(TAB_KEY, v);
    } catch {
      /* ignore */
    }
  };
  return (
    <>
      <div class="topbar">
        <h1>{t("Tools")}</h1>
      </div>
      <main>
        <div class="segmented" role="tablist">
          {(
            [
              ["duplicates", t("Duplikate")],
              ["report", t("Bericht")],
              ["send", t("Send")],
              ["receive", t("Empfangen")],
            ] as [Tab, string][]
          ).map(([v, l]) => (
            <button
              key={v}
              class={tab === v ? "on" : ""}
              role="tab"
              aria-selected={tab === v}
              onClick={() => choose(v)}
              data-testid={"tool-" + v}
            >
              {l}
            </button>
          ))}
        </div>
        {tab === "duplicates" ? (
          <DuplicatesTool />
        ) : tab === "report" ? (
          <PasswordReportTool />
        ) : tab === "send" ? (
          <SendTool />
        ) : (
          <SendReceiveTool />
        )}
      </main>
    </>
  );
}

function DuplicatesTool() {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [accountKey, setAccountKey, accounts] = useToolAccount(true);
  const [mode, setMode] = useState<DuplicateMode>("site");
  const [busy, setBusy] = useState(false);
  // null until the evidence arrived: a clean-up before that would pick the entry to keep blindly
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  // on failure the evidence stays null: the bulk clean-up stays disabled instead of guessing without it
  const loadEvidence = () =>
    call("usageEvidence", {})
      .then(setEvidence)
      .catch(() => {
        setEvidence(null);
        toast.show(t("Nutzungsdaten konnten nicht geladen werden"), "error");
      });
  useEffect(() => {
    void loadEvidence();
  }, []);
  const groups = useMemo(
    () =>
      findDuplicates(
        app.vault.items.filter((i) => accountKey === ALL_ACCOUNTS || i.accountKey === accountKey),
        mode,
      ),
    [app.vault, accountKey, mode],
  );
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const accountLabel = (key: string) => app.accountMap.get(key)?.label ?? key;
  const placeOf = (i: ItemView) =>
    (i.organizationId
      ? app.vault.organizations.find((o) => o.accountKey === i.accountKey && o.id === i.organizationId)?.name
      : i.folderId
        ? app.vault.folders.find((f) => f.accountKey === i.accountKey && f.id === i.folderId)?.name
        : "") ?? "";

  const trash = async (items: { accountKey: string; id: string; name: string }[]) => {
    setBusy(true);
    let ok = 0;
    let firstError = "";
    for (const it of items) {
      const r = await call("deleteItem", { accountKey: it.accountKey, itemId: it.id });
      if (r.ok) ok++;
      else firstError ||= r.error ?? t("Fehler");
    }
    await app.reloadVault();
    await loadEvidence();
    setBusy(false);
    if (firstError) toast.show(t("{n} in den Papierkorb verschoben, Fehler: {error}", { n: ok, error: firstError }), "error");
    else toast.show(ok === 1 ? t("In den Papierkorb verschoben") : t("{n} Einträge in den Papierkorb verschoben", { n: ok }));
  };

  const clean = async (a: GroupAssessment) => {
    const lines = a.removable.map((i) => {
      const unique = a.uniqueFieldsOf(i).map(fieldLabel);
      return (
        `„${i.name}“ (${accountLabel(i.accountKey)})` +
        (unique.length ? `\n   ${t("Nur in diesem Eintrag: {fields}", { fields: unique.join(", ") })}` : "")
      );
    });
    const ok = await dialogs.confirm({
      title: t("Duplikate entfernen?"),
      message: lines.join("\n"),
      okLabel: t("In den Papierkorb"),
      danger: true,
    });
    if (ok) await trash(a.removable.map((i) => ({ accountKey: i.accountKey, id: i.id, name: i.name })));
  };

  if (!accounts.length) return <div class="empty">{t("Keine entsperrten Konten.")}</div>;

  return (
    <div data-testid="duplicates">
      <div class="tool-intro muted small">{t("Sucht doppelte Einträge in einem oder allen entsperrten Konten.")}</div>
      <div class="tool-controls">
        {accounts.length > 1 && <AccountSelect value={accountKey} onChange={setAccountKey} accounts={accounts} allowAll />}
        <label class="tool-account">
          <span>{t("Logins sind doppelt bei gleicher")}</span>
          <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as DuplicateMode)} data-testid="dup-mode">
            <option value="site">{t("Website + Benutzername")}</option>
            <option value="sitePassword">{t("Website + Benutzername + Passwort")}</option>
          </select>
        </label>
      </div>
      {groups.length === 0 ? (
        <div class="empty" data-testid="dup-none">
          <Icon name="check" size={32} />
          {t("Keine Duplikate gefunden.")}
        </div>
      ) : (
        <>
          <div class="section-head">
            <h2>
              {groups.length === 1
                ? t("1 Gruppe mit {n} Einträgen", { n: total })
                : t("{g} Gruppen mit {n} Einträgen", { g: groups.length, n: total })}
            </h2>
          </div>
          {groups.map((g) => {
            const assessment = assessGroup(g, evidence ?? { lastUsed: {}, outcomes: {} }, placeOf);
            const diff = compareGroup(g.items, placeOf);
            const acrossAccounts = new Set(g.items.map((i) => i.accountKey)).size > 1;
            return (
              <section class="dup-group" key={g.key} data-testid="dup-group">
                <div class="dup-head">
                  <div class="grow">
                    <div class="dup-title">{g.label}</div>
                    <div class="muted small">
                      {TYPE_LABEL[g.type]} · {t("{n} Einträge", { n: g.items.length })}
                      {g.type === CipherType.Login &&
                        (g.samePassword ? " · " + t("gleiches Passwort") : " · " + t("unterschiedliche Passwörter"))}
                      {evidence && assessment.unclear && " · " + t("Unklar – bitte selbst prüfen")}
                    </div>
                  </div>
                  {assessment.removable.length > 0 && (
                    <button
                      class="btn btn-ghost btn-sm"
                      disabled={busy || !evidence}
                      data-testid="dup-clean"
                      onClick={() => clean(assessment)}
                    >
                      {t("Bereinigen")}
                    </button>
                  )}
                </div>
                <DupCompareSummary diff={diff} />
                <div class="card">
                  {g.items.map((i, idx) => {
                    const folder = i.folderId
                      ? app.vault.folders.find((f) => f.accountKey === i.accountKey && f.id === i.folderId)
                      : undefined;
                    const org = i.organizationId
                      ? app.vault.organizations.find((o) => o.accountKey === i.accountKey && o.id === i.organizationId)
                      : undefined;
                    const ev = assessment.evidence.get(i);
                    return (
                      <div
                        class="row"
                        key={itemKey(i)}
                        role="button"
                        tabIndex={0}
                        onClick={() => app.go({ name: "item", key: itemKey(i) })}
                        data-testid="dup-item"
                        data-name={i.name}
                      >
                        <ItemIcon item={i} acc={app.accountMap.get(i.accountKey)} favicons={app.state.settings.showFavicons} />
                        <div class="text">
                          <div class="title">
                            <span class="t">{i.name}</span>
                            {acrossAccounts && <AccountBadge acc={app.accountMap.get(i.accountKey)} />}
                            {evidence && assessment.recommended === i && <span class="pill">{t("vermutlich aktuell")}</span>}
                          </div>
                          <div class="subtitle">
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                              {[
                                org?.name ?? folder?.name,
                                i.archivedDate ? t("archiviert") : "",
                                t("geändert {date}", { date: formatDate(i.revisionDate) }),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </div>
                          {evidence && ev && <DupEvidenceLine ev={ev} />}
                          <DupItemDiffs diff={diff} idx={idx} />
                        </div>
                        <div class="actions" onClick={(e) => e.stopPropagation()}>
                          {i.edit && (
                            <button
                              class="icon-btn sm"
                              title={t("In den Papierkorb")}
                              aria-label={t("In den Papierkorb")}
                              disabled={busy}
                              data-testid="dup-trash"
                              onClick={async () => {
                                const ok = await dialogs.confirm({
                                  title: t("In den Papierkorb verschieben?"),
                                  message: t("„{name}“ kommt in den Papierkorb und kann dort wiederhergestellt werden.", { name: i.name }),
                                  okLabel: t("In den Papierkorb"),
                                  danger: true,
                                });
                                if (ok) await trash([i]);
                              }}
                            >
                              <Icon name="trash" size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
