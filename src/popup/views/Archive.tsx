import { useApp } from "../app-state";
import { AccountBadge, ItemIcon, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";
import { compareItems, formatDate, itemKey, subtitle } from "../util";

import { t } from "../../shared/i18n";

/** Archived items: hidden from the vault list and autofill, but not deleted. */
export function ArchiveView() {
  const app = useApp();
  const toast = useToast();
  const items = app.vault.items.filter((i) => i.archivedDate && !i.deletedDate).sort(compareItems);
  const multi = app.accounts.length > 1;
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Archiv")}</h1>
      </div>
      <main>
        {items.length === 0 ? (
          <div class="empty">
            <Icon name="archive" size={32} />
            {t("Das Archiv ist leer.")}
            <div class="hint" style={{ maxWidth: 280, textAlign: "center" }}>
              {t("Archivierte Einträge erscheinen nicht in der Liste und beim Ausfüllen, bleiben aber erhalten.")}
            </div>
          </div>
        ) : (
          <div class="card" data-testid="archive-list">
            {items.map((i) => {
              const acc = app.accountMap.get(i.accountKey);
              return (
                <div class="row" key={itemKey(i)} onClick={() => app.go({ name: "item", key: itemKey(i) })} data-testid="archive-row">
                  <ItemIcon item={i} acc={acc} favicons={app.state.settings.showFavicons} />
                  <div class="text">
                    <div class="title">
                      <span class="t">{i.name}</span>
                    </div>
                    <div class="subtitle">
                      {multi && <AccountBadge acc={acc} />}
                      <span>{subtitle(i) || t("archiviert am {date}", { date: formatDate(i.archivedDate) })}</span>
                    </div>
                  </div>
                  <div class="actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      class="icon-btn sm"
                      title={t("Aus dem Archiv holen")}
                      aria-label={t("Aus dem Archiv holen")}
                      data-testid="unarchive"
                      onClick={async () => {
                        const r = await call("archiveItem", { accountKey: i.accountKey, itemId: i.id, archive: false });
                        if (r.ok) await app.reloadVault();
                        toast.show(r.ok ? t("Aus dem Archiv geholt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
                      }}
                    >
                      <Icon name="history" size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
