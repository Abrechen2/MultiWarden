import { ComponentChildren, createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AppCtx } from "./app-state";
import { AccountBadge, PasswordInput, Spinner } from "./components";
import { Icon } from "./icons";
import { call } from "./rpc";
import { personalItemAllowed } from "../shared/policies";
import type { ItemView } from "../shared/types";

import { t } from "../shared/i18n";
/** Result of "copy into another account" (the copy exists; failed attachments are listed by name). */
export interface CopyResult {
  targetAccountKey: string;
  id: string;
  attachmentsFailed: string[];
}
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
  /** choose target account and folder, then copy (resolves null when cancelled) */
  copyToAccount: (item: ItemView) => Promise<CopyResult | null>;
}

const Ctx = createContext<DialogApi>({
  confirm: async () => false,
  reprompt: async () => false,
  prompt: async () => null,
  copyToAccount: async () => null,
});
export const useDialogs = () => useContext(Ctx);

type Dlg =
  | { kind: "confirm"; o: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "reprompt"; accountKey: string; resolve: (v: boolean) => void }
  | { kind: "prompt"; o: { title: string; label: string; okLabel?: string; initial?: string }; resolve: (v: string | null) => void }
  | { kind: "copyToAccount"; item: ItemView; resolve: (v: CopyResult | null) => void };

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
    copyToAccount: (item) => new Promise((resolve) => setDlg({ kind: "copyToAccount", item, resolve })),
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
            {dlg.kind === "copyToAccount" && (
              <CopyToAccountBox
                item={dlg.item}
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
      <p class="muted" style={{ margin: "0 0 16px", whiteSpace: "pre-line" }}>
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

function CopyToAccountBox({ item, done }: { item: ItemView; done: (v: CopyResult | null) => void }) {
  const app = useContext(AppCtx);
  const targets = (app?.accounts ?? []).filter((a) => a.status === "unlocked" && a.key !== item.accountKey);
  // "remove individual vault" / restricted item types: the copy goes into the personal vault
  const allowed = (key: string) => personalItemAllowed(app?.accountMap.get(key)?.policies, item.type);
  const [target, setTarget] = useState(() => targets.find((a) => allowed(a.key))?.key ?? "");
  const srcFolder = app?.vault.folders.find((f) => f.accountKey === item.accountKey && f.id === item.folderId)?.name;
  const folders = useMemo(
    () => (app?.vault.folders ?? []).filter((f) => f.accountKey === target).sort((a, b) => a.name.localeCompare(b.name, "de")),
    [app?.vault, target],
  );
  const [folderId, setFolderId] = useState("");
  // preselect the folder with the same name as the item's current one
  useEffect(() => setFolderId(folders.find((f) => f.name === srcFolder)?.id ?? ""), [target, folders.length]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = item.attachments.length;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const r = await call("copyItemToAccount", {
      accountKey: item.accountKey,
      itemId: item.id,
      targetAccountKey: target,
      folderId: folderId || null,
    }).catch((e: any) => ({ ok: false, error: e?.message ?? String(e), id: undefined, attachmentsFailed: undefined }));
    setBusy(false);
    if (r.ok && r.id) done({ targetAccountKey: target, id: r.id, attachmentsFailed: r.attachmentsFailed ?? [] });
    else setErr(r.error ?? t("Kopieren fehlgeschlagen"));
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (target && !busy) submit();
      }}
      data-testid="copy-account-dialog"
    >
      <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>{t("In anderes Konto kopieren")}</h3>
      <p class="muted" style={{ margin: "0 0 12px" }}>
        {t("Die Kopie landet im persönlichen Tresor des gewählten Kontos. Das Original bleibt unverändert.")}
      </p>
      <div class="card" style={{ padding: "4px 10px", marginBottom: 12 }} role="radiogroup" aria-label={t("Zielkonto")}>
        {targets.map((a) => (
          <label class="checkbox" key={a.key} title={allowed(a.key) ? undefined : t("Eine Richtlinie verbietet Einträge im persönlichen Tresor dieses Kontos.")}>
            <input
              type="radio"
              name="copy-target"
              checked={target === a.key}
              disabled={busy || !allowed(a.key)}
              onChange={() => setTarget(a.key)}
              data-testid="copy-target"
            />
            <AccountBadge acc={a} />
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{a.label}</span>
            {!allowed(a.key) && <span class="small muted">{t("(Richtlinie)")}</span>}
          </label>
        ))}
      </div>
      <label class="field">
        <span class="lbl">{t("Ordner")}</span>
        <div class="input-wrap">
          <select
            value={folderId}
            disabled={busy || !target}
            onChange={(e) => setFolderId((e.target as HTMLSelectElement).value)}
            data-testid="copy-folder"
          >
            <option value="">{t("Kein Ordner")}</option>
            {folders.map((f) => (
              <option value={f.id} key={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </label>
      {n > 0 && (
        <p class="small muted" style={{ margin: "0 0 8px" }}>
          {n === 1 ? t("1 Anhang wird mitkopiert") : t("{n} Anhänge werden mitkopiert", { n })}
        </p>
      )}
      {!target && <div class="error-text">{t("Kein anderes Konto erlaubt Einträge im persönlichen Tresor.")}</div>}
      {err && (
        <div class="error-text" data-testid="copy-error">
          {err}
        </div>
      )}
      <div class="row-gap" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button type="button" class="btn btn-ghost" disabled={busy} onClick={() => done(null)}>
          {t("Abbrechen")}
        </button>
        <button class="btn btn-primary" type="submit" disabled={busy || !target} data-testid="copy-ok">
          {busy && <Spinner />}
          {t("Kopieren")}
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
