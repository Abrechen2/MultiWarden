import { useEffect, useState } from "preact/hooks";
import { passwordStrength } from "../../shared/generator";
import { MpPolicy, policyRequirements, policyViolations, pwStats } from "../../shared/mp-policy";
import { useApp } from "../app-state";
import { Field, PasswordInput, Spinner, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { exposedCount } from "./ItemDetail";

import { locale, t } from "../../shared/i18n";

/** Change the master password of an account (also the forced change after login). */
export function ChangePasswordView({ accountKey: initial }: { accountKey?: string }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const candidates = app.accounts.filter((a) => a.status === "unlocked" && (a.hasMasterPassword || a.forcePasswordChange === "temp"));
  const [accountKey, setAccountKey] = useState(initial ?? candidates[0]?.key ?? "");
  const acc = app.accountMap.get(accountKey);
  const temp = acc?.forcePasswordChange === "temp";
  const [policy, setPolicy] = useState<MpPolicy | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [hint, setHint] = useState("");
  const [checkBreach, setCheckBreach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setPolicy(null);
    if (accountKey)
      call("masterPasswordPolicy", { accountKey })
        .then((r) => setPolicy(r.policy))
        .catch(() => {});
  }, [accountKey]);

  const strength = passwordStrength(next);
  const strengthColor = ["transparent", "var(--danger)", "var(--warning)", "#4b9fe8", "var(--success)"][strength.score];
  const violations = policyViolations(pwStats(next), policy);

  async function save() {
    setError("");
    if (!temp && !current) return setError(t("Bitte das aktuelle Master-Passwort eingeben."));
    if (next.length < 12) return setError(t("Das Master-Passwort muss mindestens 12 Zeichen lang sein."));
    if (next !== next2) return setError(t("Die Master-Passwörter stimmen nicht überein."));
    if (violations.length) return setError(t("Das Passwort erfüllt die Richtlinie deiner Organisation nicht."));
    if (hint && hint.trim() === next) return setError(t("Der Hinweis darf nicht das Passwort selbst sein."));
    setBusy(true);
    try {
      if (checkBreach) {
        const n = await exposedCount(next).catch(() => 0);
        if (n > 0) {
          const ok = await dialogs.confirm({
            title: t("Passwort in Datenlecks gefunden"),
            message: t("Dieses Passwort kam {n}-mal in Datenlecks vor. Trotzdem verwenden?", { n: n.toLocaleString(locale()) }),
            okLabel: t("Trotzdem verwenden"),
            danger: true,
          });
          if (!ok) return;
        }
      }
      if (strength.score < 3) {
        const ok = await dialogs.confirm({
          title: t("Schwaches Master-Passwort"),
          message: t("Das Passwort ist eher schwach. Ein langer Satz aus mehreren Wörtern ist sicherer. Trotzdem verwenden?"),
          okLabel: t("Trotzdem verwenden"),
        });
        if (!ok) return;
      }
      const r = temp
        ? await call("updateTempPassword", { accountKey, next, hint })
        : await call("changeMasterPassword", { accountKey, current, next, hint });
      setCurrent("");
      setNext("");
      setNext2("");
      await app.reload();
      toast.show(r.relogin ? t("Master-Passwort geändert – bitte neu anmelden") : t("Master-Passwort geändert"));
      app.back();
    } catch (e: any) {
      setError(t(e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  const reqs = policyRequirements(policy);
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Master-Passwort ändern")}</h1>
      </div>
      <main>
        {acc?.forcePasswordChange && (
          <div class="banner warn" data-testid="forced-change">
            {temp
              ? t("Ein Administrator hat dein Master-Passwort zurückgesetzt. Lege jetzt ein neues fest.")
              : t("Dein Master-Passwort erfüllt die Richtlinie deiner Organisation nicht mehr. Bitte ändere es jetzt.")}
          </div>
        )}
        <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
          {candidates.length > 1 && (
            <Field label={t("Konto")}>
              <div class="input-wrap">
                <select value={accountKey} onChange={(e) => setAccountKey((e.target as HTMLSelectElement).value)} data-testid="cp-account">
                  {candidates.map((a) => (
                    <option value={a.key} key={a.key}>
                      {a.label} ({a.serverLabel})
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          )}
          {!temp && (
            <Field label={t("Aktuelles Master-Passwort")}>
              <PasswordInput value={current} onValue={setCurrent} name="cp-current" />
            </Field>
          )}
          <Field label={t("Neues Master-Passwort")} hint={t("Mindestens 12 Zeichen")}>
            <PasswordInput value={next} onValue={setNext} autocomplete="new-password" name="cp-new" />
          </Field>
          {next && (
            <div style={{ margin: "-6px 2px 10px" }}>
              <div class="strength">
                <div style={{ width: strength.score * 25 + "%", background: strengthColor }} />
              </div>
              <div class="hint">{strength.label}</div>
            </div>
          )}
          {reqs.length > 0 && (
            <div class="hint" style={{ margin: "0 2px 10px" }} data-testid="cp-policy">
              {t("Anforderungen deiner Organisation:")}
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {reqs.map((r) => {
                  const bad = violations.some((v) => v.text === r.text);
                  return (
                    <li key={r.text} style={{ color: next ? (bad ? "var(--danger)" : "var(--success)") : undefined }}>
                      {t(r.text, { n: r.n })}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <Field label={t("Neues Master-Passwort bestätigen")}>
            <PasswordInput value={next2} onValue={setNext2} autocomplete="new-password" name="cp-new2" onEnter={save} />
          </Field>
          <Field label={t("Hinweis zum Master-Passwort (optional)")}>
            <div class="input-wrap">
              <input value={hint} onInput={(e) => setHint((e.target as HTMLInputElement).value)} name="cp-hint" />
            </div>
          </Field>
          <label class="checkbox" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={checkBreach} onChange={(e) => setCheckBreach((e.target as HTMLInputElement).checked)} />
            {t("Prüfen, ob das Passwort in Datenlecks vorkommt")}
          </label>
          {error && <div class="banner error">{error}</div>}
        </div>
        <p class="hint">
          {t(
            "Der Tresorinhalt bleibt unverändert, nur der Schlüssel zum Entsperren wird neu verschlüsselt. Andere Geräte und Browser werden abgemeldet.",
          )}
        </p>
      </main>
      <div class="footer-bar">
        <button class="btn btn-primary" onClick={save} disabled={busy || !accountKey} data-testid="cp-save">
          {busy && <Spinner />}
          {t("Master-Passwort ändern")}
        </button>
      </div>
    </>
  );
}

/** Key Connector migration: remove the master password or leave the organization (like the official clients). */
export function RemovePasswordView({ accountKey }: { accountKey: string }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const acc = app.accountMap.get(accountKey);
  const m = acc?.kcMigration;
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"remove" | "leave" | null>(null);
  const [error, setError] = useState("");
  let host = m?.url ?? "";
  try {
    host = new URL(host).host;
  } catch {
    /* keep */
  }

  async function remove() {
    setError("");
    if (!password) return setError(t("Bitte das aktuelle Master-Passwort eingeben."));
    setBusy("remove");
    try {
      await call("removeMasterPassword", { accountKey, password });
      await app.reload();
      toast.show(t("Master-Passwort entfernt"));
      app.back();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  async function leave() {
    if (!m) return;
    const ok = await dialogs.confirm({
      title: t("Organisation verlassen?"),
      message: t("Du verlierst den Zugriff auf alle Einträge und Sammlungen von {org}.", { org: m.orgName }),
      okLabel: t("Verlassen"),
      danger: true,
    });
    if (!ok) return;
    setBusy("leave");
    try {
      await call("leaveOrganization", { accountKey, orgId: m.orgId });
      await app.reload();
      toast.show(t("Organisation verlassen"));
      app.back();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Master-Passwort entfernen")}</h1>
      </div>
      <main>
        {!m ? (
          <div class="empty">{t("Für dieses Konto ist das nicht nötig")}</div>
        ) : (
          <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
            <p style={{ marginTop: 0 }}>
              {t(
                "{org} verwendet SSO mit einem eigenen Schlüsselserver. Mitglieder dieser Organisation brauchen zum Anmelden kein Master-Passwort mehr.",
                { org: m.orgName },
              )}
            </p>
            <Field label={t("Konto")}>
              <div class="mono small">{acc?.label}</div>
            </Field>
            <Field label={t("Schlüsselserver (Key Connector)")}>
              <div class="mono small" data-testid="kc-host">
                {host}
              </div>
            </Field>
            <Field label={t("Aktuelles Master-Passwort")}>
              <PasswordInput value={password} onValue={setPassword} name="kc-password" onEnter={remove} />
            </Field>
            <p class="hint">{t("Danach entsperrst du dieses Konto über die SSO-Anmeldung deiner Organisation, mit PIN oder Biometrie.")}</p>
            {error && <div class="banner error">{error}</div>}
          </div>
        )}
      </main>
      {m && (
        <div class="footer-bar">
          <button class="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={leave} disabled={!!busy} data-testid="kc-leave">
            {busy === "leave" && <Spinner />}
            {t("Organisation verlassen")}
          </button>
          <button class="btn btn-primary" onClick={remove} disabled={!!busy} data-testid="kc-remove">
            {busy === "remove" && <Spinner />}
            {t("Master-Passwort entfernen")}
          </button>
        </div>
      )}
    </>
  );
}
