import { ComponentChildren, createContext } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { AppCtx } from "./app-state";
import { PasswordInput, Spinner } from "./components";
import { Icon } from "./icons";
import { call } from "./rpc";

import { t } from "../shared/i18n";
interface ConfirmOpts {
  title: string;
  message: string;
  okLabel?: string;
  danger?: boolean;
}

interface DialogApi {
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  reprompt: (accountKey: string) => Promise<boolean>;
  prompt: (o: { title: string; label: string; okLabel?: string; initial?: string }) => Promise<string | null>;
}

const Ctx = createContext<DialogApi>({
  confirm: async () => false,
  reprompt: async () => false,
  prompt: async () => null,
});
export const useDialogs = () => useContext(Ctx);

type Dlg =
  | { kind: "confirm"; o: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "reprompt"; accountKey: string; resolve: (v: boolean) => void }
  | { kind: "prompt"; o: { title: string; label: string; okLabel?: string; initial?: string }; resolve: (v: string | null) => void };

const overlay = {
  position: "fixed",
  inset: 0,
  background: "rgba(10,16,28,.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
  padding: 18,
} as const;
const box = {
  background: "var(--bg-elev)",
  borderRadius: 12,
  boxShadow: "var(--shadow-pop)",
  padding: 18,
  width: "100%",
  maxWidth: 340,
  border: "1px solid var(--border-soft)",
} as const;

export function DialogHost({ children }: { children: ComponentChildren }) {
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const verified = useRef(new Map<string, number>());
  const app = useContext(AppCtx);

  const api: DialogApi = {
    confirm: (o) => new Promise((resolve) => setDlg({ kind: "confirm", o, resolve })),
    reprompt: (accountKey) => {
      // re-prompt valid for 5 minutes, like a short grace period
      const tx = verified.current.get(accountKey);
      if (tx && Date.now() - tx < 5 * 60_000) return Promise.resolve(true);
      // accounts without master password (SSO) can only confirm with the PIN – without PIN there is nothing to ask
      const acc = app?.accountMap.get(accountKey);
      if (acc && !acc.hasMasterPassword && !app.state.settings.pinEnabled) return Promise.resolve(true);
      return new Promise((resolve) =>
        setDlg({
          kind: "reprompt",
          accountKey,
          resolve: (v) => {
            if (v) verified.current.set(accountKey, Date.now());
            resolve(v);
          },
        }),
      );
    },
    prompt: (o) => new Promise((resolve) => setDlg({ kind: "prompt", o, resolve })),
  };

  const close = () => setDlg(null);

  return (
    <Ctx.Provider value={api}>
      {children}
      {dlg && (
        <div style={overlay} role="dialog" aria-modal="true">
          <div style={box}>
            {dlg.kind === "confirm" && (
              <ConfirmBox
                o={dlg.o}
                done={(v) => {
                  close();
                  dlg.resolve(v);
                }}
              />
            )}
            {dlg.kind === "reprompt" && (
              <RepromptBox
                accountKey={dlg.accountKey}
                done={(v) => {
                  close();
                  dlg.resolve(v);
                }}
              />
            )}
            {dlg.kind === "prompt" && (
              <PromptBox
                o={dlg.o}
                done={(v) => {
                  close();
                  dlg.resolve(v);
                }}
              />
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}

function ConfirmBox({ o, done }: { o: ConfirmOpts; done: (v: boolean) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{o.title}</h3>
      <p class="muted" style={{ margin: "0 0 16px" }}>
        {o.message}
      </p>
      <div class="row-gap" style={{ justifyContent: "flex-end" }}>
        <button class="btn btn-ghost" onClick={() => done(false)}>
          {t("Abbrechen")}
        </button>
        <button ref={ref} class={"btn " + (o.danger ? "btn-danger" : "btn-primary")} onClick={() => done(true)} data-testid="confirm-ok">
          {o.okLabel ?? "OK"}
        </button>
      </div>
    </>
  );
}

function RepromptBox({ accountKey, done }: { accountKey: string; done: (v: boolean) => void }) {
  const app = useContext(AppCtx);
  const usePin = app?.accountMap.get(accountKey)?.hasMasterPassword === false;
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await call("verifyPassword", { accountKey, password: pw }).catch(() => ({ ok: false }));
    setBusy(false);
    if (r.ok) done(true);
    else setErr(true);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3 style={{ margin: "0 0 8px", fontSize: 16, display: "flex", gap: 8, alignItems: "center" }}>
        <Icon name="lock" size={18} />
        {usePin ? t("PIN bestätigen") : t("Master-Passwort bestätigen")}
      </h3>
      <p class="muted" style={{ margin: "0 0 12px" }}>
        {usePin
          ? t("Dieser Eintrag ist geschützt. Bitte bestätige deine PIN.")
          : t("Dieser Eintrag ist geschützt. Bitte bestätige dein Master-Passwort.")}
      </p>
      <PasswordInput value={pw} onValue={setPw} autoFocus />
      {err && <div class="error-text">{usePin ? "Falsche PIN" : t("Falsches Master-Passwort")}</div>}
      <div class="row-gap" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" class="btn btn-ghost" onClick={() => done(false)}>
          {t("Abbrechen")}
        </button>
        <button class="btn btn-primary" type="submit" disabled={busy || !pw}>
          {busy && <Spinner />}
          {t("Bestätigen")}
        </button>
      </div>
    </form>
  );
}

function PromptBox({
  o,
  done,
}: {
  o: { title: string; label: string; okLabel?: string; initial?: string };
  done: (v: string | null) => void;
}) {
  const [v, setV] = useState(o.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) done(v.trim());
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>{o.title}</h3>
      <label class="field">
        <span class="lbl">{o.label}</span>
        <div class="input-wrap">
          <input ref={ref} value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} />
        </div>
      </label>
      <div class="row-gap" style={{ justifyContent: "flex-end" }}>
        <button type="button" class="btn btn-ghost" onClick={() => done(null)}>
          {t("Abbrechen")}
        </button>
        <button class="btn btn-primary" type="submit" disabled={!v.trim()}>
          {o.okLabel ?? "OK"}
        </button>
      </div>
    </form>
  );
}
