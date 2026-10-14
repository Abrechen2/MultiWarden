import { useState } from "preact/hooks";
import { useApp } from "../app-state";
import { Field, Spinner, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";

import { t } from "../../shared/i18n";

/**
 * Personal item → move into an organization (choose organization + collections).
 * Organization item → change its collections.
 */
export function AssignView({ itemKeyStr }: { itemKeyStr: string }) {
  const app = useApp();
  const toast = useToast();
  const item = app.itemByKey(itemKeyStr);
  const orgs = app.vault.organizations.filter((o) => o.accountKey === item?.accountKey);
  const [orgId, setOrgId] = useState<string>(item?.organizationId ?? orgs[0]?.id ?? "");
  const [selected, setSelected] = useState<string[]>(item?.organizationId ? item.collectionIds : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!item) {
    app.back();
    return null;
  }
  const moving = !item.organizationId;
  const collections = app.vault.collections
    .filter((c) => c.accountKey === item.accountKey && c.organizationId === orgId && (!c.readOnly || c.manage || selected.includes(c.id)))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));

  async function save() {
    setError(null);
    if (!selected.length) {
      setError(t("Bitte mindestens eine Sammlung auswählen."));
      return;
    }
    setBusy(true);
    try {
      const r = moving
        ? await call("shareItem", { accountKey: item!.accountKey, item: item!, organizationId: orgId, collectionIds: selected })
        : await call("setItemCollections", { accountKey: item!.accountKey, itemId: item!.id, collectionIds: selected });
      if (!r.ok) {
        setError(r.error ?? t("Speichern fehlgeschlagen"));
        return;
      }
      await app.reloadVault();
      toast.show(moving ? t("In die Organisation verschoben") : t("Sammlungen gespeichert"));
      app.back();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Abbrechen")}>
          <Icon name="x" size={20} />
        </button>
        <h1>{moving ? t("In Organisation verschieben") : t("Sammlungen zuweisen")}</h1>
      </div>
      <main>
        <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
          <p class="hint" style={{ marginTop: 0 }}>
            <b>{item.name}</b>
            {moving && (
              <>
                <br />
                {t("Nach dem Verschieben gehört der Eintrag der Organisation. Das lässt sich nicht rückgängig machen.")}
              </>
            )}
          </p>
          {moving && (
            <Field label={t("Organisation")}>
              <div class="input-wrap">
                <select
                  value={orgId}
                  data-testid="assign-org"
                  onChange={(e) => {
                    setOrgId((e.target as HTMLSelectElement).value);
                    setSelected([]);
                  }}
                >
                  {orgs.map((o) => (
                    <option value={o.id} key={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          )}
          <Field label={t("Sammlungen")} group>
            <div class="card" style={{ padding: "4px 10px" }} data-testid="assign-collections">
              {collections.length === 0 && <div class="muted small">{t("Keine beschreibbaren Sammlungen")}</div>}
              {collections.map((c) => (
                <label class="checkbox" key={c.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    disabled={!!c.readOnly && !c.manage}
                    onChange={(e) =>
                      setSelected((s) => ((e.target as HTMLInputElement).checked ? [...s, c.id] : s.filter((x) => x !== c.id)))
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </Field>
          {error && <div class="banner error">{error}</div>}
        </div>
      </main>
      <div class="footer-bar">
        <button class="btn btn-primary" onClick={save} disabled={busy || !orgId} data-testid="assign-save">
          {busy && <Spinner />}
          {moving ? t("Verschieben") : t("Speichern")}
        </button>
        <button class="btn btn-ghost" onClick={app.back}>
          {t("Abbrechen")}
        </button>
      </div>
    </>
  );
}
