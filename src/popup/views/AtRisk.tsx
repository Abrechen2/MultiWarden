// "At-risk passwords": items whose password an organization asked the member to change (security tasks).
import { useState } from "preact/hooks";
import type { ItemView } from "../../shared/types";
import { useApp } from "../app-state";
import { AccountBadge, ItemIcon, Spinner, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";
import { itemKey, launchUrl } from "../util";

import { t } from "../../shared/i18n";

/** Items of unlocked accounts with a pending "change at-risk password" task. */
export function useAtRiskItems(): ItemView[] {
  const app = useApp();
  const out: ItemView[] = [];
  for (const a of app.accounts) {
    if (a.status !== "unlocked" || !a.atRisk?.length) continue;
    for (const id of a.atRisk) {
      const it = app.vault.items.find((i) => i.accountKey === a.key && i.id === id && !i.deletedDate);
      if (it) out.push(it);
    }
  }
  return out;
}

/** Open the website's change-password page (/.well-known/change-password when supported). */
export async function openChangePassword(item: ItemView) {
  const uri = item.login?.uris.map((u) => u.uri).find((u) => u && launchUrl(u));
  if (!uri) throw new Error(t("Für diesen Eintrag ist keine Website hinterlegt."));
  const { url } = await call("changePasswordUrl", { uri: launchUrl(uri)! });
  await chrome.tabs.create({ url });
}

export function ChangePasswordButton({ item, small }: { item: ItemView; small?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      class={"btn btn-secondary " + (small ? "btn-sm" : "")}
      disabled={busy}
      data-testid="change-at-risk"
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await openChangePassword(item);
        } catch (err: any) {
          toast.show(err?.message ?? String(err), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner /> : <Icon name="external" size={14} />}
      {t("Passwort ändern")}
    </button>
  );
}

export function AtRiskView() {
  const app = useApp();
  const items = useAtRiskItems();
  const multi = app.accounts.length > 1;
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Gefährdete Passwörter")}</h1>
      </div>
      <main>
        <p class="hint" style={{ marginTop: 0 }}>
          {t(
            "Deine Organisation bittet dich, diese Passwörter zu ändern, weil sie schwach, mehrfach verwendet oder in Datenlecks aufgetaucht sind.",
          )}
        </p>
        {items.length === 0 ? (
          <div class="empty">
            <Icon name="shield" size={32} />
            {t("Keine gefährdeten Passwörter.")}
          </div>
        ) : (
          <div class="card" data-testid="at-risk-list">
            {items.map((it) => {
              const acc = app.accountMap.get(it.accountKey);
              return (
                <div class="row" key={itemKey(it)} onClick={() => app.go({ name: "item", key: itemKey(it) })} data-testid="at-risk-row">
                  <ItemIcon item={it} acc={acc} favicons={app.state.settings.showFavicons} />
                  <div class="text">
                    <div class="title">
                      <span class="t">{it.name}</span>
                    </div>
                    <div class="subtitle">
                      {multi && <AccountBadge acc={acc} />}
                      <span>{it.login?.username ?? ""}</span>
                    </div>
                  </div>
                  <div class="actions">
                    <ChangePasswordButton item={it} small />
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
