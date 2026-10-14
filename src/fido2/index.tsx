// Passkey dialog: choose a passkey to sign in, or where to save a new one.
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Fido2AccountView, Fido2SessionData, Fido2Verify } from "../shared/messages";
import { PasswordInput, Spinner } from "../popup/components";
import { Icon, Logo } from "../popup/icons";
import { call } from "../popup/rpc";
import "../popup/styles.css";
import "./fido2.css";
import "../shared/select.css";

import { initLanguage, t } from "../shared/i18n";
import { initAppearance } from "../shared/appearance";
const token = decodeURIComponent(location.hash.slice(1));

function Badge({ color, initials, label }: { color: string; initials: string; label: string }) {
  return (
    <span class="avatar sm" style={{ background: color }} title={label}>
      <span class="ini">{initials}</span>
    </span>
  );
}

/** Master password / PIN input for user verification. */
function VerifyInput({
  verify,
  secret,
  setSecret,
  mode,
  setMode,
}: {
  verify: Fido2Verify;
  secret: string;
  setSecret: (s: string) => void;
  mode: "mp" | "pin";
  setMode: (m: "mp" | "pin") => void;
}) {
  if (verify.missing)
    return (
      <div class="banner warn">
        {t("Dieses Konto hat kein Master-Passwort. Richte in den Einstellungen eine PIN ein, um Passkeys zu bestätigen.")}
      </div>
    );
  if (!verify.modes.length) return null;
  const m = verify.modes.includes(mode) ? mode : verify.modes[0];
  return (
    <div class="verify">
      <label class="field">
        <span class="lbl">{m === "pin" ? t("PIN zur Bestätigung") : t("Master-Passwort zur Bestätigung")}</span>
        <PasswordInput key={m} value={secret} onValue={setSecret} autoFocus name={m === "pin" ? "pin" : "master-password"} />
      </label>
      {verify.modes.length > 1 && (
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode(m === "pin" ? "mp" : "pin")}>
          {m === "pin" ? t("Stattdessen Master-Passwort verwenden") : "Stattdessen PIN verwenden"}
        </button>
      )}
    </div>
  );
}

function UnlockBox({ accounts, pinEnabled, onDone }: { accounts: Fido2AccountView[]; pinEnabled: boolean; onDone: () => void }) {
  const locked = accounts.filter((a) => !a.unlocked);
  const mpLocked = locked.filter((a) => a.hasMasterPassword);
  const pinLocked = locked.filter((a) => a.pinUnlock);
  const [mode, setMode] = useState<"pin" | "mp">(pinLocked.length ? "pin" : "mp");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = mode === "pin" && !pinLocked.length ? "mp" : mode;
  const canForm = m === "pin" ? pinLocked.length > 0 : mpLocked.length > 0;
  const unlock = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r =
        m === "pin"
          ? await call("unlockPin", { pin: secret })
          : await call("unlock", { password: secret, accountKeys: mpLocked.map((a) => a.key) });
      if (r.results.some((x) => x.ok)) {
        setSecret("");
        onDone();
      } else setErr((r as any).error ?? (m === "pin" ? "Falsche PIN" : t("Falsches Master-Passwort")));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!locked.length) return null;
  return (
    <div class="card unlock-box">
      <div class="acct-mini">
        {locked.map((a) => (
          <span class="chip" key={a.key}>
            <Badge color={a.color} initials={a.initials} label={a.label} />
            {a.label}
          </span>
        ))}
      </div>
      {canForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (secret) unlock();
          }}
        >
          <label class="field">
            <span class="lbl">{m === "pin" ? "PIN" : t("Master-Passwort")}</span>
            <PasswordInput key={m} value={secret} onValue={setSecret} autoFocus name={m === "pin" ? "pin" : "master-password"} />
          </label>
          {err && <div class="error-text">{err}</div>}
          <button class="btn btn-primary btn-block" type="submit" disabled={busy || !secret} data-testid="fido2-unlock">
            {busy ? <Spinner /> : <Icon name="unlock" size={16} />}
            {t("Entsperren")}
          </button>
        </form>
      )}
      {pinEnabled && pinLocked.length > 0 && mpLocked.length > 0 && (
        <button class="btn btn-ghost btn-sm btn-block" onClick={() => setMode(m === "pin" ? "mp" : "pin")}>
          {m === "pin" ? t("Mit Master-Passwort entsperren") : t("Mit PIN entsperren")}
        </button>
      )}
      {locked.some((a) => !a.hasMasterPassword && !a.pinUnlock) && (
        <button class="btn btn-secondary btn-sm btn-block" style={{ marginTop: 6 }} onClick={() => call("openPopup", {})}>
          <Icon name="building" size={14} />
          {t("Konten mit SSO im Popup entsperren")}
        </button>
      )}
    </div>
  );
}

function Dialog() {
  const [s, setS] = useState<Fido2SessionData | null>(null);
  const [sel, setSel] = useState<string | null>(null); // accountKey::itemId, or "new::accountKey"
  const [account, setAccount] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState<"mp" | "pin">("mp");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showUnlock, setShowUnlock] = useState(false);

  const load = async () => {
    try {
      const d = await call("fido2Session", { token });
      setS(d);
      if (d.kind === "get" && d.candidates.length === 1) setSel(d.candidates[0].accountKey + "::" + d.candidates[0].itemId);
      if (d.kind === "create") {
        setAccount((cur) => {
          const ok = d.accounts.filter((a) => a.unlocked);
          return cur && ok.some((a) => a.key === cur) ? cur : (ok[0]?.key ?? null);
        });
      }
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    document.body.classList.add("popout");
    load();
    const ping = setInterval(async () => {
      const r = await call("fido2Ping", { token }).catch(() => ({ ok: false }));
      if (!r.ok) window.close();
    }, 4000);
    const l = (msg: any) => {
      if (msg?.event === "stateChanged" || msg?.event === "vaultChanged") load();
    };
    chrome.runtime.onMessage.addListener(l);
    return () => {
      clearInterval(ping);
      chrome.runtime.onMessage.removeListener(l);
    };
  }, []);

  useEffect(() => {
    setSecret("");
    setErr(null);
  }, [sel, account]);

  if (!s)
    return (
      <div class="empty" style={{ paddingTop: 200 }}>
        <Spinner />
      </div>
    );

  const unlockedAccounts = s.accounts.filter((a) => a.unlocked);
  const lockedAccounts = s.accounts.filter((a) => !a.unlocked);
  const fallback = () => call("fido2Fallback", { token }).finally(() => window.close());
  const cancel = () => call("fido2Cancel", { token }).finally(() => window.close());

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      if (r.ok) window.close();
      else setErr(r.error ?? t("Fehlgeschlagen"));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <div class="fido2-head">
      <Logo size={30} />
      <div class="grow">
        <h1>{s.kind === "create" ? t("Passkey speichern") : s.kind === "excluded" ? "Passkey vorhanden" : t("Mit Passkey anmelden")}</h1>
        <div class="site">
          <Icon name="globe" size={13} />
          {s.rpId || "—"}
        </div>
      </div>
    </div>
  );

  let body;
  let primary = null;
  if (s.kind === "gone") {
    body = <div class="banner">{t("Diese Anfrage ist nicht mehr aktiv.")}</div>;
    primary = (
      <button class="btn btn-primary" onClick={() => window.close()}>
        {t("Schließen")}
      </button>
    );
  } else if (s.kind === "excluded") {
    body = (
      <div class="banner warn">
        {t("Für {site} ist bereits ein Passkey in einem deiner Tresore gespeichert. Die Website kann keinen zweiten anlegen.", {
          site: s.rpId,
        })}
      </div>
    );
    primary = (
      <button class="btn btn-primary" onClick={cancel} data-testid="fido2-close">
        {t("Schließen")}
      </button>
    );
  } else if (s.kind === "get") {
    const cand = s.candidates.find((c) => c.accountKey + "::" + c.itemId === sel);
    body = (
      <>
        {s.candidates.length > 0 ? (
          <div class="card list" role="listbox" aria-label={t("Passkeys")}>
            {s.candidates.map((c) => {
              const k = c.accountKey + "::" + c.itemId;
              return (
                <button
                  key={k}
                  class={"row" + (sel === k ? " on" : "")}
                  onClick={() => setSel(k)}
                  role="option"
                  aria-selected={sel === k}
                  data-testid="fido2-candidate"
                >
                  <span class="pk">
                    <Icon name="passkey" size={18} />
                  </span>
                  <span class="txt">
                    <b>{c.userName || c.name}</b>
                    <small>{c.name}</small>
                  </span>
                  <Badge color={c.accountColor} initials={c.accountInitials} label={c.accountLabel} />
                </button>
              );
            })}
          </div>
        ) : (
          !lockedAccounts.length && (
            <div class="banner">{t("Für {site} ist in deinen Tresoren kein Passkey gespeichert.", { site: s.rpId })}</div>
          )
        )}
        {cand && <VerifyInput verify={cand.verify} secret={secret} setSecret={setSecret} mode={mode} setMode={setMode} />}
        {lockedAccounts.length > 0 &&
          (s.candidates.length === 0 || showUnlock ? (
            <>
              <p class="hint">
                {s.candidates.length === 0 ? t("Entsperre deine Konten, um ihre Passkeys zu verwenden.") : t("Weitere Konten entsperren:")}
              </p>
              <UnlockBox accounts={s.accounts} pinEnabled={s.pinEnabled} onDone={load} />
            </>
          ) : (
            <button class="btn btn-ghost btn-sm" onClick={() => setShowUnlock(true)}>
              <Icon name="lock" size={14} />
              {lockedAccounts.length === 1
                ? t("1 gesperrtes Konto entsperren")
                : t("{n} gesperrte Konten entsperren", { n: lockedAccounts.length })}
            </button>
          ))}
      </>
    );
    primary = (
      <button
        class="btn btn-primary"
        disabled={busy || !cand || !!cand.verify.missing || (cand.verify.modes.length > 0 && !secret)}
        data-testid="fido2-signin"
        onClick={() =>
          cand &&
          run(() =>
            call("fido2Pick", {
              token,
              accountKey: cand.accountKey,
              itemId: cand.itemId,
              secret: secret || undefined,
              mode: cand.verify.modes.includes(mode) ? mode : cand.verify.modes[0],
            }),
          )
        }
      >
        {busy ? <Spinner /> : <Icon name="passkey" size={16} />}
        {t("Anmelden")}
      </button>
    );
  } else {
    // create
    const acc = unlockedAccounts.find((a) => a.key === account);
    const logins = s.existingLogins.filter((l) => l.accountKey === account);
    const target = sel?.startsWith("item::") ? logins.find((l) => "item::" + l.accountKey + "::" + l.itemId === sel) : undefined;
    const verify: Fido2Verify | undefined = target ? target.verify : account ? s.newItemVerify[account] : undefined;
    body = (
      <>
        <div class="card who">
          <Icon name="user" size={16} />
          <span class="grow">{s.userName || "—"}</span>
          {s.rpName && <span class="muted small">{s.rpName}</span>}
        </div>
        {unlockedAccounts.length > 1 && (
          <label class="field">
            <span class="lbl">{t("In Konto speichern")}</span>
            <select
              value={account ?? ""}
              onChange={(e) => {
                setAccount((e.target as HTMLSelectElement).value);
                setSel(null);
              }}
              data-testid="fido2-account"
            >
              {unlockedAccounts.map((a) => (
                <option value={a.key} key={a.key}>
                  {a.label} · {a.serverLabel}
                </option>
              ))}
            </select>
          </label>
        )}
        {unlockedAccounts.length === 1 && acc && (
          <p class="hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Badge color={acc.color} initials={acc.initials} label={acc.label} />
            {t("Wird in {account} ({server}) gespeichert.", { account: acc.label, server: acc.serverLabel })}
          </p>
        )}
        {acc && (
          <div class="card list" role="listbox" aria-label={t("Speicherort")}>
            <button class={"row" + (!target ? " on" : "")} onClick={() => setSel(null)} data-testid="fido2-new-item">
              <span class="pk">
                <Icon name="plus" size={18} />
              </span>
              <span class="txt">
                <b>{t("Als neuen Login speichern")}</b>
                <small>{s.rpName || s.rpId}</small>
              </span>
            </button>
            {logins.map((l) => {
              const k = "item::" + l.accountKey + "::" + l.itemId;
              return (
                <button key={k} class={"row" + (sel === k ? " on" : "")} onClick={() => setSel(k)} data-testid="fido2-existing">
                  <span class="pk">
                    <Icon name="globe" size={18} />
                  </span>
                  <span class="txt">
                    <b>{l.name}</b>
                    <small>
                      {l.userName || "—"}
                      {l.hasPasskey ? t(" · vorhandener Passkey wird ersetzt") : ""}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {verify && <VerifyInput verify={verify} secret={secret} setSecret={setSecret} mode={mode} setMode={setMode} />}
        {lockedAccounts.length > 0 &&
          (unlockedAccounts.length === 0 || showUnlock ? (
            <>
              <p class="hint">
                {unlockedAccounts.length === 0 ? t("Entsperre ein Konto, um den Passkey zu speichern.") : t("Weitere Konten entsperren:")}
              </p>
              <UnlockBox accounts={s.accounts} pinEnabled={s.pinEnabled} onDone={load} />
            </>
          ) : (
            <button class="btn btn-ghost btn-sm" onClick={() => setShowUnlock(true)}>
              <Icon name="lock" size={14} />
              {lockedAccounts.length === 1
                ? t("1 gesperrtes Konto entsperren")
                : t("{n} gesperrte Konten entsperren", { n: lockedAccounts.length })}
            </button>
          ))}
      </>
    );
    primary = (
      <button
        class="btn btn-primary"
        disabled={busy || !acc || !verify || !!verify.missing || (verify.modes.length > 0 && !secret)}
        data-testid="fido2-save"
        onClick={() =>
          acc &&
          verify &&
          run(() =>
            call("fido2Save", {
              token,
              accountKey: acc.key,
              itemId: target?.itemId,
              secret: secret || undefined,
              mode: verify.modes.includes(mode) ? mode : verify.modes[0],
            }),
          )
        }
      >
        {busy ? <Spinner /> : <Icon name="passkey" size={16} />}
        {t("Passkey speichern")}
      </button>
    );
  }

  return (
    <div class="app fido2">
      <main>
        {header}
        <div class="origin muted small">{t("Anfrage von {origin}", { origin: s.origin })}</div>
        {body}
        {err && (
          <div class="banner error" role="alert">
            {err}
          </div>
        )}
        {s.kind !== "gone" && s.kind !== "excluded" && s.fallbackSupported && (
          <button class="btn btn-ghost btn-sm alt" onClick={fallback} data-testid="fido2-fallback">
            {s.kind === "create"
              ? t("Im Browser oder auf einem anderen Gerät speichern")
              : t("Passkey des Browsers oder eines anderen Geräts verwenden")}
          </button>
        )}
      </main>
      <div class="footer-bar">
        {s.kind !== "gone" && s.kind !== "excluded" && (
          <button class="btn btn-secondary" onClick={cancel} data-testid="fido2-cancel">
            {t("Abbrechen")}
          </button>
        )}
        {primary}
      </div>
    </div>
  );
}

Promise.all([initLanguage(() => rerender()), initAppearance()]).finally(() => rerender());
function rerender() {
  render(<Dialog />, document.getElementById("root")!);
}
