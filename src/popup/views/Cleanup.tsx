// "Aufräumen" tool: read-only checks for logins that look neglected. No bulk actions; every entry
// opens the item so the user decides.
import { useEffect, useMemo, useState } from "preact/hooks";
import { portlessLocalUris, reusedAcrossAccounts, staleOnThisDevice, withoutWebsite } from "../../shared/cleanup";
import { Evidence } from "../../shared/dup-evidence";
import { t } from "../../shared/i18n";
import { ItemView } from "../../shared/types";
import { useApp } from "../app-state";
import { AccountBadge, ItemIcon, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";
import { formatDay, itemKey } from "../util";
import { ALL_ACCOUNTS, AccountSelect, useToolAccount } from "./tool-account";

type SectionId = "nosite" | "noport" | "stale" | "reuse";

export function CleanupTool() {
  const app = useApp();
  const toast = useToast();
  const [accountKey, setAccountKey, accounts] = useToolAccount(true);
  const [open, setOpen] = useState<Record<string, boolean>>({ nosite: true, noport: true, stale: true, reuse: true });
  // null while loading or after a failure: "not used for long" is then unavailable, not "everything unused"
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  useEffect(() => {
    call("usageEvidence", {})
      .then(setEvidence)
      .catch(() => {
        setEvidence(null);
        toast.show(t("Nutzungsdaten konnten nicht geladen werden"), "error");
      });
  }, []);

  // the cross-account reuse check always looks at every unlocked account, whatever the selector says
  const all = app.vault.items;
  const scoped = useMemo(() => all.filter((i) => accountKey === ALL_ACCOUNTS || i.accountKey === accountKey), [all, accountKey]);
  const nosite = useMemo(() => withoutWebsite(scoped), [scoped]);
  const noport = useMemo(() => portlessLocalUris(scoped), [scoped]);
  const stale = useMemo(() => (evidence ? staleOnThisDevice(scoped, evidence.lastUsed, Date.now()) : null), [scoped, evidence]);
  const reuse = useMemo(
    () => reusedAcrossAccounts(all).filter((g) => accountKey === ALL_ACCOUNTS || g.some((i) => i.accountKey === accountKey)),
    [all, accountKey],
  );
  const spanning = accountKey === ALL_ACCOUNTS;

  if (!accounts.length) return <div class="empty">{t("Keine entsperrten Konten.")}</div>;

  const Row = ({ i, info }: { i: ItemView; info?: string }) => (
    <div class="row" role="button" tabIndex={0} onClick={() => app.go({ name: "item", key: itemKey(i) })} data-testid="cleanup-item">
      <ItemIcon item={i} acc={app.accountMap.get(i.accountKey)} favicons={app.state.settings.showFavicons} />
      <div class="text">
        <div class="title">
          <span class="t">{i.name}</span>
          {(spanning || accountKey !== i.accountKey) && <AccountBadge acc={app.accountMap.get(i.accountKey)} />}
        </div>
        <div class="subtitle">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{[i.login?.username, info].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
    </div>
  );

  const Section = ({ id, title, count, desc, children }: { id: SectionId; title: string; count: number | null; desc: string; children?: any }) => (
    <section class="report-section" data-testid={"cleanup-" + id}>
      <button class="report-head" onClick={() => setOpen({ ...open, [id]: !open[id] })} aria-expanded={open[id]}>
        <span class="grow">{title}</span>
        {count != null && (
          <span class={"count" + (count > 0 ? " bad" : " ok")} data-testid={"cleanup-count-" + id}>
            {count}
          </span>
        )}
        <Icon name={open[id] ? "chevronDown" : "chevronRight"} size={16} />
      </button>
      {open[id] && (
        <>
          <div class="muted small report-desc">{desc}</div>
          {children}
        </>
      )}
    </section>
  );

  return (
    <div data-testid="cleanup">
      <div class="tool-intro muted small">
        {t("Zeigt Logins, die aufgeräumt werden könnten. Es wird nichts verändert; die Auswertung läuft auf deinem Gerät.")}
      </div>
      <div class="tool-controls">
        {accounts.length > 1 && <AccountSelect value={accountKey} onChange={setAccountKey} accounts={accounts} allowAll />}
      </div>

      <Section
        id="nosite"
        title={t("Ohne gültige Website")}
        count={nosite.length}
        desc={t("Logins ohne Website, mit einer nicht lesbaren Adresse oder einem Schema, das weder Web noch App ist. Sie werden nie automatisch angeboten.")}
      >
        {nosite.length > 0 && (
          <div class="card">
            {nosite.map((i) => (
              <Row key={itemKey(i)} i={i} />
            ))}
          </div>
        )}
      </Section>

      <Section
        id="noport"
        title={t("IP-Adressen ohne Port")}
        count={noport.length}
        desc={t("Gilt nur für Port 80/443. Läuft der Dienst auf einem anderen Port, die Adresse ergänzen.")}
      >
        {noport.length > 0 && (
          <div class="card">
            {noport.map((x) => (
              <Row key={itemKey(x.item)} i={x.item} info={x.uri} />
            ))}
          </div>
        )}
      </Section>

      <Section
        id="stale"
        title={t("Auf diesem Gerät lange nicht genutzt")}
        count={stale ? stale.length : null}
        desc={t("Nicht innerhalb der letzten 12 Monate auf diesem Gerät ausgefüllt. Nur eine Information: Auf anderen Geräten können sie in Gebrauch sein.")}
      >
        {!stale ? (
          <div class="muted small report-action" data-testid="cleanup-stale-unavailable">
            {t("Nutzungsdaten konnten nicht geladen werden")}
          </div>
        ) : (
          stale.length > 0 && (
            <div class="card">
              {stale.map((x) => (
                <Row
                  key={itemKey(x.item)}
                  i={x.item}
                  info={
                    x.lastUsed === undefined
                      ? t("Auf diesem Gerät nie genutzt")
                      : t("Auf diesem Gerät seit {date} nicht genutzt", { date: formatDay(new Date(x.lastUsed).toISOString()) })
                  }
                />
              ))}
            </div>
          )
        )}
      </Section>

      <Section
        id="reuse"
        title={t("In mehreren Konten gleiches Passwort")}
        count={reuse.reduce((n, g) => n + g.length, 0)}
        desc={t("Dasselbe Passwort in verschiedenen Konten. Der Vergleich geschieht nur im Speicher.")}
      >
        {reuse.map((g, idx) => (
          <div class="card report-group" key={idx}>
            {g.map((i) => (
              <Row key={itemKey(i)} i={i} />
            ))}
          </div>
        ))}
      </Section>
    </div>
  );
}
