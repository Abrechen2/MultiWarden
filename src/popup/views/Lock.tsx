import { useEffect, useState } from "preact/hooks";
import type { UnlockResult } from "../../shared/messages";
import type { AccountPublic } from "../../shared/types";
import { useApp } from "../app-state";
import { Avatar, PasswordInput, Spinner, useToast } from "../components";
import { Icon, Logo } from "../icons";
import { call } from "../rpc";
import { bioGet, bioSupported, inActionPopup, openBioWindow, takePendingBio } from "../biometric";

import { t } from "../../shared/i18n";
export function LockView({ only }: { only?: string[] }) {
  const app = useApp();
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, UnlockResult>>({});
  const anyUnlocked = app.accounts.some((a) => a.status === "unlocked");
  const relevant = app.accounts.filter((a) => !only || only.includes(a.key));
  const locked = relevant.filter((a) => a.status === "locked");
  const loggedOut = relevant.filter((a) => a.status === "loggedOut");
  const mpLocked = locked.filter((a) => a.hasMasterPassword);
  const pinLocked = locked.filter((a) => a.pinUnlock);
  const bio = app.state.settings.biometric;
  const bioLocked = bio && bioSupported() ? locked.filter((a) => a.bioUnlock) : [];
  const [bioBusy, setBioBusy] = useState(false);
  const [mode, setMode] = useState<"pin" | "mp">(pinLocked.length ? "pin" : "mp");
  const effMode = mode === "pin" && !pinLocked.length ? "mp" : mode;
  // accounts the current form can unlock
  const formTargets = effMode === "pin" ? pinLocked : mpLocked;
  // accounts without master password (SSO with trusted device / Key Connector) and without PIN
  const ssoOnly = locked.filter((a) => !a.hasMasterPassword && !(effMode === "pin" && a.pinUnlock));

  async function unlock() {
    if (!password) return;
    setBusy(true);
    try {
      let r: { results: UnlockResult[]; error?: string };
      if (effMode === "pin") r = await call("unlockPin", { pin: password });
      else r = await call("unlock", { password, accountKeys: mpLocked.map((a) => a.key) });
      await handle(r, effMode);
    } catch (e: any) {
      toast.show(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function unlockBio() {
    if (!bio) return;
    if (inActionPopup()) return openBioWindow("unlock");
    setBioBusy(true);
    try {
      const prf = await bioGet(bio.credentialId, bio.salt);
      await handle(await call("unlockBiometric", { prf }), "bio");
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    } finally {
      setBioBusy(false);
    }
  }

  useEffect(() => {
    if (bioLocked.length && takePendingBio("unlock")) unlockBio();
  }, []);

  async function handle(r: { results: UnlockResult[]; error?: string }, how: "pin" | "mp" | "bio") {
    const map: Record<string, UnlockResult> = {};
    r.results.forEach((x) => (map[x.accountKey] = x));
    setResults(map);
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.length - ok;
    await app.reload();
    const stillLocked = locked.filter((a) => !map[a.key]?.ok);
    if (ok && !failed && !stillLocked.length) {
      app.go({ name: "vault" }, true);
      return;
    }
    if (ok) {
      toast.show(
        failed && how !== "bio"
          ? how === "pin"
            ? t("{ok} entsperrt – für {failed} andere PIN eingeben", { ok, failed })
            : t("{ok} entsperrt – für {failed} anderes Passwort eingeben", { ok, failed })
          : stillLocked.length === 1
            ? t("{ok} entsperrt – 1 weiteres Konto gesperrt", { ok })
            : t("{ok} entsperrt – {n} weitere Konten gesperrt", { ok, n: stillLocked.length }),
      );
      setPassword("");
    } else {
      toast.show(
        r.error ?? (how === "pin" ? t("Falsche PIN") : how === "bio" ? t("Entsperren fehlgeschlagen") : t("Falsches Master-Passwort")),
        "error",
      );
    }
  }

  async function unlockSso(a: AccountPublic) {
    setSsoBusy(a.key);
    try {
      const f = await call("loginSsoStart", { accountKey: a.key });
      if (f.step === "error") {
        toast.show(f.error ?? t("SSO fehlgeschlagen"), "error");
        await call("loginAck", {});
      } else app.go({ name: "addAccount" });
    } catch (e: any) {
      toast.show(e.message, "error");
    } finally {
      setSsoBusy(null);
    }
  }

  const relogin = (a: AccountPublic) => {
    if (a.sso && !a.hasMasterPassword) return unlockSso(a);
    app.go({ name: "addAccount", email: a.email, server: a.server, baseUrl: a.server === "selfhosted" ? a.webVault : undefined });
  };

  return (
    <>
      <div class="topbar">
        {anyUnlocked && (
          <button class="icon-btn back" onClick={() => app.back()} aria-label={t("Zurück")}>
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <h1>{anyUnlocked ? t("Konten entsperren") : t("Tresor gesperrt")}</h1>
        <button class="icon-btn" title={t("Konten verwalten")} onClick={() => app.go({ name: "accounts" })}>
          <Icon name="users" size={18} />
        </button>
      </div>
      <main>
        {!anyUnlocked && (
          <div class="auth" style={{ padding: "0 0 4px", minHeight: 0 }}>
            <div class="brand" style={{ margin: "4px 0 14px" }}>
              <Logo size={44} />
              <p>
                {effMode === "pin"
                  ? t("Gib deine PIN ein, um die Konten zu entsperren.")
                  : mpLocked.length
                    ? t("Gib dein Master-Passwort ein. Konten mit demselben Passwort werden gemeinsam entsperrt.")
                    : t("Entsperre deine Konten über die Anmeldung deiner Organisation.")}
              </p>
            </div>
          </div>
        )}
        <div class="card acct-list" style={{ marginBottom: 14 }}>
          {relevant.map((a) => {
            const r = results[a.key];
            const viaSso = a.status === "locked" && ssoOnly.includes(a);
            return (
              <div class="acct-row" key={a.key} data-account={a.email}>
                <Avatar acc={a} showState />
                <div class="meta">
                  <div class="email">{a.label}</div>
                  <div class="server">
                    {a.label !== a.email ? a.email + " · " : ""}
                    {a.serverLabel}
                    {a.sso ? " · SSO" : ""}
                  </div>
                </div>
                {a.status === "unlocked" ? (
                  <span class="status unlocked">{t("Entsperrt")}</span>
                ) : a.status === "loggedOut" ? (
                  <button class="btn btn-secondary btn-sm" onClick={() => relogin(a)} disabled={ssoBusy === a.key}>
                    {ssoBusy === a.key ? <Spinner /> : null}
                    {t("Anmelden")}
                  </button>
                ) : viaSso ? (
                  <button class="btn btn-secondary btn-sm" onClick={() => unlockSso(a)} disabled={!!ssoBusy} data-testid="unlock-sso">
                    {ssoBusy === a.key ? <Spinner /> : <Icon name="building" size={14} />}
                    {t("SSO")}
                  </button>
                ) : r && !r.ok ? (
                  <span class="status error">{effMode === "pin" ? t("Falsche PIN") : t("Falsches Passwort")}</span>
                ) : (
                  <span class="status locked">{t("Gesperrt")}</span>
                )}
              </div>
            );
          })}
        </div>
        {formTargets.length > 0 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              unlock();
            }}
          >
            <label class="field">
              <span class="lbl">{effMode === "pin" ? "PIN" : t("Master-Passwort")}</span>
              <PasswordInput
                key={effMode}
                value={password}
                onValue={setPassword}
                autoFocus
                name={effMode === "pin" ? "pin" : "master-password"}
                inputMode={effMode === "pin" ? "numeric" : undefined}
              />
            </label>
            <button class="btn btn-primary btn-block" type="submit" disabled={busy || !password}>
              {busy ? <Spinner /> : <Icon name="unlock" size={16} />}
              {formTargets.length > 1 ? t("{n} Konten entsperren", { n: formTargets.length }) : t("Entsperren")}
            </button>
          </form>
        )}
        {bioLocked.length > 0 && (
          <button
            class={"btn btn-block " + (formTargets.length ? "btn-secondary" : "btn-primary")}
            style={{ marginTop: 6 }}
            onClick={unlockBio}
            disabled={bioBusy}
            data-testid="unlock-bio"
          >
            {bioBusy ? <Spinner /> : <Icon name="fingerprint" size={16} />}
            {t("Mit Biometrie entsperren")}
          </button>
        )}
        {pinLocked.length > 0 && mpLocked.length > 0 && (
          <button
            class="btn btn-ghost btn-block"
            style={{ marginTop: 6 }}
            data-testid="toggle-pin"
            onClick={() => {
              setMode(effMode === "pin" ? "mp" : "pin");
              setPassword("");
              setResults({});
            }}
          >
            <Icon name={effMode === "pin" ? "key" : "lock"} size={16} />
            {effMode === "pin" ? t("Mit Master-Passwort entsperren") : t("Mit PIN entsperren")}
          </button>
        )}
        {ssoOnly.length > 0 && (
          <p class="hint" style={{ marginTop: 10 }}>
            {ssoOnly.length === 1
              ? t("Ein Konto hat kein Master-Passwort und wird über die SSO-Anmeldung der Organisation entsperrt.")
              : t("{n} Konten haben kein Master-Passwort und werden über die SSO-Anmeldung der Organisation entsperrt.", {
                  n: ssoOnly.length,
                })}
            {app.state.settings.pinEnabled ? "" : " " + t("Alternativ kannst du in den Einstellungen eine PIN einrichten.")}
          </p>
        )}
        {locked.length === 0 && loggedOut.length > 0 && (
          <div class="banner warn">{t("Die Sitzung ist abgelaufen. Bitte melde dich bei diesen Konten neu an.")}</div>
        )}
        {anyUnlocked && locked.length === 0 && (
          <button class="btn btn-secondary btn-block" style={{ marginTop: 10 }} onClick={() => app.go({ name: "vault" }, true)}>
            {t("Zum Tresor")}
          </button>
        )}
        {!anyUnlocked && (
          <button class="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={() => app.go({ name: "addAccount" })}>
            <Icon name="plus" size={16} />
            {t("Weiteres Konto hinzufügen")}
          </button>
        )}
      </main>
    </>
  );
}
