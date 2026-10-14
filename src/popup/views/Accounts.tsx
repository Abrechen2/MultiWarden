import { useState } from "preact/hooks";
import { ACCOUNT_COLORS, AccountPublic } from "../../shared/types";
import { useApp } from "../app-state";
import { Avatar, MenuItem, Popover, Spinner, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { relTime } from "../util";

import { t } from "../../shared/i18n";
function AccountCard({ a, first, last }: { a: AccountPublic; first: boolean; last: boolean }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [menu, setMenu] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [colors, setColors] = useState(false);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  async function logout() {
    const ok = await dialogs.confirm({
      title: t("Konto abmelden?"),
      message: t("{email} ({server}) wird aus der Erweiterung entfernt. Die Daten auf dem Server bleiben unverändert.", {
        email: a.email,
        server: a.serverLabel,
      }),
      okLabel: t("Abmelden"),
      danger: true,
    });
    if (ok) {
      await call("logout", { accountKey: a.key });
      toast.show(t("Abgemeldet"));
    }
  }

  return (
    <div class="detail-card" data-testid="account-card" data-email={a.email}>
      <div class="acct-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px" }}>
        <Avatar acc={a} size="lg" showState />
        <div class="meta" style={{ flex: 1, minWidth: 0 }}>
          <div class="email" style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {a.label}
          </div>
          <div class="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {a.label !== a.email && a.email + " · "}
            {a.serverLabel}
          </div>
          {(a.sso || a.decryption !== "masterPassword") && (
            <div class="small muted" data-testid="account-decryption">
              {a.sso ? "SSO" : t("Anmeldung")} ·{" "}
              {a.decryption === "tde"
                ? a.hasMasterPassword
                  ? t("Vertrauenswürdiges Gerät + Master-Passwort")
                  : t("Vertrauenswürdiges Gerät")
                : a.decryption === "keyConnector"
                  ? "Key Connector"
                  : t("Master-Passwort")}
              {a.pinUnlock ? " · PIN" : ""}
            </div>
          )}
          <div class="small muted" style={{ marginTop: 2, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span class={"status " + (a.syncError ? "error" : a.status)}>
              {a.syncError
                ? t("Fehler")
                : a.status === "unlocked"
                  ? t("Entsperrt")
                  : a.status === "locked"
                    ? t("Gesperrt")
                    : t("Abgemeldet")}
            </span>
            <span>
              {a.status === "unlocked" && a.itemCount != null ? t("{n} Einträge", { n: a.itemCount }) + " · " : ""}
              {t("Sync")} {relTime(a.lastSync)}
            </span>
            {a.syncing && <Spinner />}
          </div>
          {a.syncError && <div class="error-text">{a.syncError}</div>}
        </div>
        <button
          class="icon-btn"
          aria-label={t("Kontooptionen")}
          onClick={(e) => {
            setAnchor(e.currentTarget as HTMLElement);
            setMenu(true);
          }}
        >
          <Icon name="more" size={18} />
        </button>
      </div>
      {colors && (
        <div style={{ padding: "0 12px 12px" }}>
          <div class="color-dots">
            {ACCOUNT_COLORS.map((c) => (
              <button
                key={c}
                class={c === a.color ? "on" : ""}
                style={{ background: c }}
                aria-label={t("Farbe {c}", { c })}
                onClick={async () => {
                  await call("updateAccount", { accountKey: a.key, color: c });
                  setColors(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
      {fingerprint && (
        <div class="settings-sub" data-testid="account-fingerprint">
          <div class="k small muted" style={{ fontWeight: 600 }}>
            {t("Fingerabdruck-Phrase")}
          </div>
          <div class="mono" style={{ color: "var(--danger)" }}>
            {fingerprint}
          </div>
          <div class="hint">
            {t("Damit prüfen andere (z. B. beim Teilen in Organisationen), dass sie wirklich dieses Konto vor sich haben.")}
          </div>
        </div>
      )}
      {menu && (
        <Popover anchor={anchor} onClose={() => setMenu(false)} align="end">
          {a.status === "loggedOut" && (
            <MenuItem
              icon="unlock"
              onClick={async () => {
                setMenu(false);
                if (a.sso && !a.hasMasterPassword) {
                  try {
                    const f = await call("loginSsoStart", { accountKey: a.key });
                    if (f.step === "error") {
                      toast.show(f.error ?? t("SSO fehlgeschlagen"), "error");
                      await call("loginAck", {});
                    } else app.go({ name: "addAccount" });
                  } catch (e: any) {
                    toast.show(e.message, "error");
                  }
                  return;
                }
                app.go({
                  name: "addAccount",
                  email: a.email,
                  server: a.server,
                  baseUrl: a.server === "selfhosted" ? a.webVault : undefined,
                });
              }}
            >
              {t("Neu anmelden")}
            </MenuItem>
          )}
          {a.status === "locked" && (
            <MenuItem
              icon="unlock"
              onClick={() => {
                setMenu(false);
                app.go({ name: "lock", only: [a.key] });
              }}
            >
              {t("Entsperren")}
            </MenuItem>
          )}
          {a.status === "unlocked" && (
            <MenuItem
              icon="lock"
              onClick={async () => {
                setMenu(false);
                await call("lock", { accountKey: a.key });
              }}
            >
              {t("Sperren")}
            </MenuItem>
          )}
          {a.status !== "loggedOut" && (
            <MenuItem
              icon="refresh"
              onClick={async () => {
                setMenu(false);
                const r = await call("sync", { accountKey: a.key });
                toast.show(r.ok ? t("Synchronisiert") : (Object.values(r.errors)[0] ?? t("Fehler")), r.ok ? "ok" : "error");
              }}
            >
              {t("Synchronisieren")}
            </MenuItem>
          )}
          <MenuItem
            icon="pencil"
            onClick={async () => {
              setMenu(false);
              const label = await dialogs.prompt({
                title: t("Anzeigename"),
                label: t("Name für dieses Konto (z. B. Privat, Firma)"),
                initial: a.label === a.email ? "" : a.label,
                okLabel: t("Speichern"),
              });
              if (label !== null) await call("updateAccount", { accountKey: a.key, label });
            }}
          >
            {t("Anzeigename ändern")}
          </MenuItem>
          <MenuItem
            icon="identity"
            onClick={() => {
              setMenu(false);
              setColors(true);
            }}
          >
            {t("Farbe ändern")}
          </MenuItem>
          {a.status === "unlocked" && a.hasMasterPassword && (
            <MenuItem
              icon="key"
              onClick={() => {
                setMenu(false);
                app.go({ name: "changePassword", accountKey: a.key });
              }}
            >
              {t("Master-Passwort ändern")}
            </MenuItem>
          )}
          {a.status === "unlocked" && (
            <MenuItem
              icon="info"
              onClick={async () => {
                setMenu(false);
                try {
                  setFingerprint(fingerprint ? null : (await call("fingerprint", { accountKey: a.key })).phrase);
                } catch (e: any) {
                  toast.show(e?.message ?? String(e), "error");
                }
              }}
            >
              <span data-testid="menu-fingerprint">{t("Fingerabdruck-Phrase")}</span>
            </MenuItem>
          )}
          {a.status === "unlocked" && (
            <MenuItem
              icon="server"
              onClick={() => {
                setMenu(false);
                app.go({ name: "devices" });
              }}
            >
              {t("Geräte")}
            </MenuItem>
          )}
          <MenuItem
            icon="shield"
            onClick={() => {
              setMenu(false);
              chrome.tabs.create({ url: a.webVault.replace(/\/+$/, "") + "/#/settings/security/two-factor" });
            }}
          >
            {t("Zweistufige Anmeldung (Web-Tresor)")}
          </MenuItem>
          <MenuItem
            icon="external"
            onClick={() => {
              setMenu(false);
              chrome.tabs.create({ url: a.webVault });
            }}
          >
            {t("Web-Tresor öffnen")}
          </MenuItem>
          {!first && (
            <MenuItem
              icon="arrowUp"
              onClick={async () => {
                setMenu(false);
                await call("moveAccount", { accountKey: a.key, direction: -1 });
              }}
            >
              {t("Nach oben")}
            </MenuItem>
          )}
          {!last && (
            <MenuItem
              icon="arrowDown"
              onClick={async () => {
                setMenu(false);
                await call("moveAccount", { accountKey: a.key, direction: 1 });
              }}
            >
              {t("Nach unten")}
            </MenuItem>
          )}
          <div class="menu-sep" />
          <MenuItem
            icon="logout"
            danger
            onClick={() => {
              setMenu(false);
              logout();
            }}
          >
            {t("Abmelden")}
          </MenuItem>
        </Popover>
      )}
    </div>
  );
}

export function AccountsView() {
  const app = useApp();
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Konten")}</h1>
        <button class="btn btn-primary btn-sm" onClick={() => app.go({ name: "addAccount" })} data-testid="add-account">
          <Icon name="plus" size={16} />
          {t("Hinzufügen")}
        </button>
      </div>
      <main>
        <p class="hint" style={{ margin: "0 2px 10px" }}>
          {t(
            "Alle entsperrten Konten werden gemeinsam im Tresor angezeigt und für Autofill genutzt. Mit dem Filter „Konto“ kannst du dich auf eines beschränken.",
          )}
        </p>
        {app.accounts.map((a, i) => (
          <AccountCard a={a} key={a.key} first={i === 0} last={i === app.accounts.length - 1} />
        ))}
      </main>
    </>
  );
}
