import { useMemo } from "preact/hooks";
import { useApp } from "../app-state";
import { AccountBadge, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";

import { t } from "../../shared/i18n";

/** Folders of all unlocked accounts: create, rename, delete. */
export function FoldersView() {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const byAccount = useMemo(
    () =>
      unlocked.map((a) => ({
        acc: a,
        folders: app.vault.folders.filter((f) => f.accountKey === a.key).sort((x, y) => x.name.localeCompare(y.name, "de")),
      })),
    [app.vault, app.accounts],
  );
  const count = (accountKey: string, folderId: string) =>
    app.vault.items.filter((i) => i.accountKey === accountKey && i.folderId === folderId && !i.deletedDate).length;

  async function add(accountKey: string) {
    const name = await dialogs.prompt({ title: t("Neuer Ordner"), label: t("Name"), okLabel: t("Erstellen") });
    if (!name?.trim()) return;
    const r = await call("createFolder", { accountKey, name: name.trim() });
    if (r.ok) await app.reloadVault();
    toast.show(r.ok ? t("Ordner erstellt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  }

  async function rename(accountKey: string, folderId: string, old: string) {
    const name = await dialogs.prompt({ title: t("Ordner umbenennen"), label: t("Name"), initial: old, okLabel: t("Speichern") });
    if (!name?.trim() || name.trim() === old) return;
    const r = await call("renameFolder", { accountKey, folderId, name: name.trim() });
    if (r.ok) await app.reloadVault();
    toast.show(r.ok ? t("Ordner umbenannt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  }

  async function remove(accountKey: string, folderId: string, name: string) {
    const n = count(accountKey, folderId);
    const ok = await dialogs.confirm({
      title: t("Ordner löschen?"),
      message:
        n > 0
          ? t("„{name}“ wird gelöscht. Die {n} Einträge darin bleiben erhalten und sind danach ohne Ordner.", { name, n })
          : t("„{name}“ wird gelöscht.", { name }),
      okLabel: t("Löschen"),
      danger: true,
    });
    if (!ok) return;
    const r = await call("deleteFolder", { accountKey, folderId });
    if (r.ok) await app.reloadVault();
    toast.show(r.ok ? t("Ordner gelöscht") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  }

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Ordner")}</h1>
      </div>
      <main>
        {byAccount.map(({ acc, folders }) => (
          <section class="section" key={acc.key} data-testid="folder-account">
            <div class="section-head">
              <h2 class="row-gap" style={{ gap: 6 }}>
                {app.accounts.length > 1 && <AccountBadge acc={acc} />}
                {acc.label}
              </h2>
              <button class="btn btn-ghost btn-sm" onClick={() => add(acc.key)} data-testid="folder-add">
                <Icon name="plus" size={14} />
                {t("Neuer Ordner")}
              </button>
            </div>
            <div class="card">
              {folders.length === 0 && <div class="row muted small">{t("Keine Ordner")}</div>}
              {folders.map((f) => (
                <div class="row" key={f.id} style={{ cursor: "default" }} data-testid="folder-row" data-name={f.name}>
                  <span class="item-icon">
                    <Icon name="folder" size={18} />
                  </span>
                  <div class="text">
                    <div class="title">
                      <span class="t">{f.name}</span>
                    </div>
                    <div class="subtitle">{t("{n} Einträge", { n: count(acc.key, f.id) })}</div>
                  </div>
                  <div class="actions">
                    <button
                      class="icon-btn sm"
                      title={t("Umbenennen")}
                      aria-label={t("Umbenennen")}
                      onClick={() => rename(acc.key, f.id, f.name)}
                      data-testid="folder-rename"
                    >
                      <Icon name="pencil" size={15} />
                    </button>
                    <button
                      class="icon-btn sm"
                      title={t("Löschen")}
                      aria-label={t("Löschen")}
                      style={{ color: "var(--danger)" }}
                      onClick={() => remove(acc.key, f.id, f.name)}
                      data-testid="folder-delete"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </main>
    </>
  );
}
