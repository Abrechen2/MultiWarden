import { useApp } from "../app-state";
import { AccountBadge, ItemIcon, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { compareItems, formatDate, itemKey } from "../util";

import { t } from "../../shared/i18n";
export function TrashView() {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const items = app.vault.items.filter((i) => i.deletedDate).sort(compareItems);
  const multi = app.accounts.length > 1;
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Papierkorb")}</h1>
      </div>
      <main>
        {items.length === 0 ? (
          <div class="empty">
            <Icon name="trash" size={32} />
            {t("Der Papierkorb ist leer.")}
          </div>
        ) : (
          <div class="card">
            {items.map((i) => {
              const acc = app.accountMap.get(i.accountKey);
              return (
                <div class="row" key={itemKey(i)} style={{ cursor: "default" }}>
                  <ItemIcon item={i} acc={acc} favicons={app.state.settings.showFavicons} />
                  <div class="text">
                    <div class="title">
                      <span class="t">{i.name}</span>
                    </div>
                    <div class="subtitle">
                      {multi && <AccountBadge acc={acc} />}
                      {t("gelöscht am {date}", { date: formatDate(i.deletedDate) })}
                    </div>
                  </div>
                  <div class="actions">
                    <button
                      class="icon-btn sm"
                      title={t("Wiederherstellen")}
                      onClick={async () => {
                        const r = await call("restoreItem", { accountKey: i.accountKey, itemId: i.id });
                        toast.show(r.ok ? t("Wiederhergestellt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
                      }}
                    >
                      <Icon name="history" size={16} />
                    </button>
                    <button
                      class="icon-btn sm"
                      title={t("Endgültig löschen")}
                      style={{ color: "var(--danger)" }}
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: t("Endgültig löschen?"),
                          message: t("„{name}“ kann danach nicht wiederhergestellt werden.", { name: i.name }),
                          okLabel: t("Löschen"),
                          danger: true,
                        });
                        if (!ok) return;
                        const r = await call("deleteItem", { accountKey: i.accountKey, itemId: i.id, permanent: true });
                        toast.show(r.ok ? t("Gelöscht") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
                      }}
                    >
                      <Icon name="trash" size={16} />
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
