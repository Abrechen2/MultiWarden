// Account security views: login requests of other devices, devices of an account.
import { useEffect, useState } from "preact/hooks";
import { useApp } from "../app-state";
import { AccountBadge, Spinner, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { formatDate, relTime } from "../util";

import { t } from "../../shared/i18n";

type Req = { accountKey: string; id: string; device: string; ip: string; created: number; fingerprint: string };

/** Pending "login with device" requests of all unlocked accounts. */
export function AuthRequestsView() {
  const app = useApp();
  const toast = useToast();
  const [reqs, setReqs] = useState<Req[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    call("authRequests", {})
      .then((r) => setReqs(r.requests))
      .catch(() => setReqs([]));
  useEffect(() => {
    load();
    const tx = window.setInterval(load, 5000);
    return () => window.clearInterval(tx);
  }, []);
  const respond = async (r: Req, approve: boolean) => {
    setBusy(r.id);
    try {
      await call("authRequestRespond", { accountKey: r.accountKey, id: r.id, approve });
      toast.show(approve ? t("Anmeldung bestätigt") : t("Anmeldung abgelehnt"));
      await load();
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Anmeldeanfragen")}</h1>
      </div>
      <main>
        {!reqs ? (
          <div class="empty">
            <Spinner />
          </div>
        ) : reqs.length === 0 ? (
          <div class="empty">
            <Icon name="shield" size={32} />
            {t("Keine offenen Anmeldeanfragen.")}
          </div>
        ) : (
          reqs.map((r) => {
            const acc = app.accountMap.get(r.accountKey);
            return (
              <div class="detail-card" key={r.id} data-testid="auth-request" style={{ padding: 12 }}>
                <div class="row-gap" style={{ gap: 6, marginBottom: 6 }}>
                  <AccountBadge acc={acc} />
                  <b>{acc?.label}</b>
                </div>
                <div class="small">
                  {t("Gerät: {device}", { device: r.device || "?" })}
                  <br />
                  {t("IP-Adresse: {ip}", { ip: r.ip || "?" })}
                  <br />
                  {relTime(r.created)}
                </div>
                <div class="k small muted" style={{ fontWeight: 600, marginTop: 8 }}>
                  {t("Fingerabdruck-Phrase")}
                </div>
                <div class="mono" style={{ color: "var(--danger)" }} data-testid="auth-request-fingerprint">
                  {r.fingerprint}
                </div>
                <div class="hint">{t("Bestätige nur, wenn auf dem anderen Gerät genau diese Phrase angezeigt wird.")}</div>
                <div class="row-gap" style={{ marginTop: 10 }}>
                  <button
                    class="btn btn-primary btn-sm"
                    disabled={busy === r.id}
                    onClick={() => respond(r, true)}
                    data-testid="auth-approve"
                  >
                    {t("Anmeldung bestätigen")}
                  </button>
                  <button class="btn btn-ghost btn-sm" disabled={busy === r.id} onClick={() => respond(r, false)} data-testid="auth-deny">
                    {t("Ablehnen")}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </main>
    </>
  );
}

const DEVICE_TYPES: Record<number, string> = {
  0: "Android",
  1: "iOS",
  2: "Chrome",
  3: "Firefox",
  4: "Opera",
  5: "Edge",
  6: "Windows",
  7: "macOS",
  8: "Linux",
  9: "Chrome",
  10: "Firefox",
  11: "Opera",
  12: "Edge",
  13: "Internet Explorer",
  14: "Browser",
  15: "Android (Amazon)",
  16: "UWP",
  17: "Safari",
  18: "Vivaldi",
  19: "Vivaldi",
  20: "Safari",
  21: "SDK",
  22: "Server",
  23: "Windows CLI",
  24: "macOS CLI",
  25: "Linux CLI",
};

/** Devices that are logged in to an account. */
export function DevicesView() {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const [accountKey, setAccountKey] = useState(unlocked[0]?.key ?? "");
  const [devices, setDevices] = useState<
    { id: string; name: string; type: number; identifier: string; created: string; current: boolean; trusted: boolean }[] | null
  >(null);
  const [error, setError] = useState("");
  const load = () => {
    setDevices(null);
    setError("");
    call("devices", { accountKey })
      .then((r) => setDevices(r.devices))
      .catch((e) => {
        setDevices([]);
        setError(e?.message ?? String(e));
      });
  };
  useEffect(load, [accountKey]);
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Geräte")}</h1>
      </div>
      <main>
        {unlocked.length > 1 && (
          <div class="input-wrap" style={{ marginBottom: 10 }}>
            <select value={accountKey} onChange={(e) => setAccountKey((e.target as HTMLSelectElement).value)} data-testid="devices-account">
              {unlocked.map((a) => (
                <option value={a.key} key={a.key}>
                  {a.label} ({a.serverLabel})
                </option>
              ))}
            </select>
          </div>
        )}
        {error && <div class="banner error">{error}</div>}
        {!devices ? (
          <div class="empty">
            <Spinner />
          </div>
        ) : (
          <div class="card" data-testid="devices-list">
            {devices.map((d) => (
              <div class="row" key={d.id} style={{ cursor: "default" }} data-testid="device-row">
                <span class="item-icon">
                  <Icon name="server" size={18} />
                </span>
                <div class="text">
                  <div class="title">
                    <span class="t">{DEVICE_TYPES[d.type] ?? d.name}</span>
                    {d.current && <span class="pill">{t("Dieses Gerät")}</span>}
                    {d.trusted && <span class="pill">{t("Vertrauenswürdig")}</span>}
                  </div>
                  <div class="subtitle">{t("Angemeldet seit {date}", { date: formatDate(d.created) })}</div>
                </div>
                {!d.current && (
                  <div class="actions">
                    <button
                      class="icon-btn sm"
                      title={t("Gerät entfernen")}
                      aria-label={t("Gerät entfernen")}
                      style={{ color: "var(--danger)" }}
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: t("Gerät entfernen?"),
                          message: t("Das Gerät wird abgemeldet und muss sich neu anmelden."),
                          okLabel: t("Entfernen"),
                          danger: true,
                        });
                        if (!ok) return;
                        const r = await call("deviceRemove", { accountKey, id: d.id });
                        toast.show(r.ok ? t("Gerät entfernt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
                        if (r.ok) load();
                      }}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
