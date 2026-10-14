// "Login speichern?" bar, rendered in an extension-origin iframe at the top right of the page.
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { NotificationData } from "../shared/messages";
import { Icon, Logo } from "../popup/icons";
import "./notification.css";

import { initLanguage, t } from "../shared/i18n";
import { initAppearance } from "../shared/appearance";
const token = decodeURIComponent(location.hash.slice(1));

async function rpc(name: string, args: any) {
  const r = await chrome.runtime.sendMessage({ rpc: name, args });
  if (!r?.ok) throw new Error(r?.error ?? t("Fehler"));
  return r.data;
}

function post(msg: any) {
  window.parent.postMessage({ mwNotify: token, ...msg }, "*");
}

function Bar() {
  const [d, setD] = useState<NotificationData | null>(null);
  const [account, setAccount] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState("all");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** while saving / after success, vault broadcasts must not replace the bar's content */
  const acting = useRef(false);

  const load = async () => {
    if (acting.current) return;
    try {
      const data: NotificationData = await rpc("notifyData", { token });
      if (acting.current) return;
      setD(data);
      setAccount((a) => (a && data.accounts.some((x) => x.key === a) ? a : (data.defaultAccount ?? data.accounts[0]?.key ?? "")));
      if (data.kind === "none") post({ close: true });
    } catch {
      post({ close: true });
    }
  };

  useEffect(() => {
    load();
    const l = (msg: any) => {
      if (msg?.event === "stateChanged" || msg?.event === "vaultChanged") load();
    };
    chrome.runtime.onMessage.addListener(l);
    return () => chrome.runtime.onMessage.removeListener(l);
  }, []);

  useEffect(() => {
    if (!root.current) return;
    const ro = new ResizeObserver(() => post({ height: Math.ceil(root.current!.getBoundingClientRect().height) + 2 }));
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [root.current]);

  useEffect(() => setFolder(""), [account]);

  if (!d) return <div ref={root} />;

  const close = async () => {
    await rpc("notifyClose", { token }).catch(() => {});
    post({ close: true });
  };
  const finish = (msg: string) => {
    setDone(msg);
    setTimeout(() => post({ close: true }), 1600);
  };
  const act = async (fn: () => Promise<any>, msg: string) => {
    setBusy(true);
    setErr(null);
    acting.current = true;
    try {
      const r = await fn();
      if (r && r.ok === false) {
        acting.current = false;
        setErr(r.error ?? t("Fehlgeschlagen"));
      } else finish(msg);
    } catch (e: any) {
      acting.current = false;
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const folders = d.folders.filter((f) => f.accountKey === account);
  const title = d.locked ? t("Login speichern?") : d.kind === "update" ? t("Passwort aktualisieren?") : t("Login speichern?");

  return (
    <div ref={root} class="bar" role="dialog" aria-label={title}>
      <div class="head">
        <Logo size={22} />
        <div class="t">
          <b>{done ?? title}</b>
          {!done && (
            <small>
              {d.host}
              {d.username ? " · " + d.username : ""}
            </small>
          )}
        </div>
        <button class="x" onClick={close} aria-label={t("Schließen")} title={t("Schließen")}>
          <Icon name="x" size={16} />
        </button>
      </div>
      {!done && (
        <>
          {d.locked ? (
            <div class="row">
              <span class="grow muted">{t("Entsperre MultiWarden, um den Login zu speichern.")}</span>
              <button class="btn primary" onClick={() => rpc("openPopup", {})} data-testid="notify-unlock">
                <Icon name="unlock" size={14} />
                {t("Entsperren")}
              </button>
            </div>
          ) : d.kind === "update" ? (
            <>
              {d.targets.length > 1 && (
                <select value={target} onChange={(e) => setTarget((e.target as HTMLSelectElement).value)} aria-label={t("Eintrag")}>
                  <option value="all">
                    {t("Alle")} {d.targets.length} {t("Einträge")}
                  </option>
                  {d.targets.map((tx) => (
                    <option value={tx.accountKey + "::" + tx.itemId} key={tx.accountKey + tx.itemId}>
                      {tx.name} · {tx.accountLabel}
                    </option>
                  ))}
                </select>
              )}
              {d.targets.length === 1 && (
                <div class="muted small target">
                  <span class="dot" style={{ background: d.targets[0].accountColor }} />
                  {d.targets[0].name} · {d.targets[0].accountLabel}
                </div>
              )}
              <div class="row">
                <button class="btn ghost" onClick={close}>
                  {t("Nicht jetzt")}
                </button>
                <span class="grow" />
                <button
                  class="btn primary"
                  disabled={busy}
                  data-testid="notify-update"
                  onClick={() =>
                    act(
                      () =>
                        rpc("notifyUpdate", {
                          token,
                          targets:
                            target === "all"
                              ? d.targets.map((tx) => ({ accountKey: tx.accountKey, itemId: tx.itemId }))
                              : [{ accountKey: target.split("::")[0], itemId: target.split("::")[1] }],
                        }),
                      t("Passwort aktualisiert"),
                    )
                  }
                >
                  {t("Aktualisieren")}
                </button>
              </div>
            </>
          ) : (
            <>
              <div class="selects">
                {d.accounts.length > 1 && (
                  <select
                    value={account}
                    onChange={(e) => setAccount((e.target as HTMLSelectElement).value)}
                    aria-label={t("Konto")}
                    data-testid="notify-account"
                  >
                    {d.accounts.map((a) => (
                      <option value={a.key} key={a.key} title={a.serverLabel}>
                        {d.accounts.filter((x) => x.label === a.label).length > 1 ? `${a.label} · ${a.serverLabel}` : a.label}
                      </option>
                    ))}
                  </select>
                )}
                {folders.length > 0 && (
                  <select value={folder} onChange={(e) => setFolder((e.target as HTMLSelectElement).value)} aria-label={t("Ordner")}>
                    <option value="">{t("Kein Ordner")}</option>
                    {folders.map((f) => (
                      <option value={f.id} key={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div class="row">
                <button
                  class="btn ghost"
                  disabled={busy}
                  onClick={() => act(() => rpc("notifyNever", { token }), t("Für diese Website wird nicht mehr gefragt"))}
                  data-testid="notify-never"
                >
                  {t("Nie für diese Website")}
                </button>
                <span class="grow" />
                <button
                  class="btn primary"
                  disabled={busy || !account}
                  data-testid="notify-save"
                  onClick={() =>
                    act(() => rpc("notifySave", { token, accountKey: account, folderId: folder || undefined }), t("Login gespeichert"))
                  }
                >
                  {t("Speichern")}
                </button>
              </div>
            </>
          )}
          {err && <div class="err">{err}</div>}
        </>
      )}
    </div>
  );
}

Promise.all([initLanguage(() => rerender()), initAppearance({ surfaceAsBg: true })]).finally(() => rerender());
function rerender() {
  render(<Bar />, document.getElementById("root")!);
}
