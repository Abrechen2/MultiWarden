// Send (Bitwarden): share texts and files end-to-end encrypted via a link. List in the tools tab,
// editor as its own view.
import { useEffect, useRef, useState } from "preact/hooks";
import { b64encode } from "../../crypto/utils";
import { t, tk } from "../../shared/i18n";
import { SendAuthType, SendEdit, SendListResponse, SendType, SendView, sendStatus } from "../../shared/sends";
import { Route, useApp } from "../app-state";
import { Field, MenuItem, PasswordInput, Popover, Spinner, Switch, TextInput, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call, onBroadcast } from "../rpc";
import { copyToClipboard, formatDate, formatDay } from "../util";
import { AccountSelect, useToolAccount } from "./tool-account";
import { Select } from "./ItemEdit";

function useSends(accountKey: string): [SendListResponse | null, string, () => Promise<void>] {
  const [data, setData] = useState<SendListResponse | null>(null);
  const [error, setError] = useState("");
  const load = async () => {
    if (!accountKey) return;
    try {
      setData(await call("listSends", { accountKey }));
      setError("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };
  useEffect(() => {
    setData(null);
    load();
    return onBroadcast((ev) => {
      if (ev === "sendsChanged" || ev === "vaultChanged") load();
    });
  }, [accountKey]);
  return [data, error, load];
}

const STATUS_LABEL = {
  disabled: tk("Deaktiviert"),
  expired: tk("Abgelaufen"),
  maxed: tk("Maximale Zugriffe erreicht"),
  pendingDelete: tk("Wird gelöscht"),
} as const;

export function SendTool() {
  const app = useApp();
  const [accountKey, setAccountKey, accounts] = useToolAccount();
  const [data, error] = useSends(accountKey);
  if (!accounts.length) return <div class="empty">{t("Keine entsperrten Konten.")}</div>;
  const blocked = !!data?.disableSend;
  return (
    <div data-testid="send-tool">
      <div class="tool-intro muted small">
        {t("Mit Send teilst du Texte oder Dateien Ende-zu-Ende-verschlüsselt über einen Link – auch mit Personen ohne Bitwarden.")}
      </div>
      <div class="tool-controls">
        {accounts.length > 1 && <AccountSelect value={accountKey} onChange={setAccountKey} accounts={accounts} />}
      </div>
      {blocked && (
        <div class="banner" data-testid="send-policy">
          <Icon name="building" size={16} />
          <span class="grow">
            {t("Send ist durch eine Richtlinie deiner Organisation deaktiviert. Vorhandene Sends kannst du nur löschen.")}
          </span>
        </div>
      )}
      {!blocked && (
        <div class="send-new">
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => app.go({ name: "sendEdit", accountKey, type: SendType.Text })}
            data-testid="send-new-text"
          >
            <Icon name="fileText" size={15} />
            {t("Neues Text-Send")}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => app.go({ name: "sendEdit", accountKey, type: SendType.File })}
            data-testid="send-new-file"
          >
            <Icon name="file" size={15} />
            {t("Neues Datei-Send")}
          </button>
        </div>
      )}
      {error && <div class="banner error">{error}</div>}
      {!data ? (
        !error && (
          <div class="empty">
            <Spinner />
          </div>
        )
      ) : data.sends.length === 0 ? (
        <div class="empty" data-testid="send-empty">
          <Icon name="send" size={32} />
          {t("Noch keine Sends in diesem Konto.")}
        </div>
      ) : (
        <div class="card" data-testid="send-list">
          {data.sends.map((s) => (
            <SendRow send={s} key={s.id} blocked={blocked} />
          ))}
        </div>
      )}
    </div>
  );
}

function SendRow({ send: s, blocked }: { send: SendView; blocked: boolean }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [menu, setMenu] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const status = sendStatus(s);
  const copyLink = async () => {
    try {
      await copyToClipboard(s.link, 0);
      toast.show(t("Link kopiert"));
    } catch {
      toast.show(t("Kopieren fehlgeschlagen"), "error");
    }
  };
  const remove = async () => {
    const ok = await dialogs.confirm({
      title: t("Send löschen?"),
      message: t("„{name}“ wird endgültig gelöscht; der Link funktioniert danach nicht mehr.", { name: s.name }),
      okLabel: t("Löschen"),
      danger: true,
    });
    if (!ok) return;
    const r = await call("deleteSend", { accountKey: s.accountKey, id: s.id });
    toast.show(r.ok ? t("Send gelöscht") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  };
  const access =
    s.maxAccessCount != null
      ? t("{n} von {max} Zugriffen", { n: s.accessCount, max: s.maxAccessCount })
      : t("{n} Zugriffe", { n: s.accessCount });
  const editable = !blocked && s.type !== SendType.Item && !s.decryptError;
  return (
    <div
      class="row"
      role="button"
      tabIndex={0}
      onClick={() => editable && app.go({ name: "sendEdit", accountKey: s.accountKey, id: s.id })}
      data-testid="send-row"
      data-name={s.name}
    >
      <span class="item-icon">
        <Icon name={s.type === SendType.File ? "file" : "fileText"} size={18} />
      </span>
      <div class="text">
        <div class="title">
          <span class="t">{s.decryptError ? t("(nicht entschlüsselbar)") : s.name || t("(ohne Namen)")}</span>
          {s.hasPassword && <Icon name="lock" size={12} class="muted" />}
          {status !== "active" && <span class="pill warn">{t(STATUS_LABEL[status])}</span>}
        </div>
        <div class="subtitle">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {t("bis {date}", { date: formatDay(s.deletionDate) })} · {access}
          </span>
        </div>
      </div>
      <div class="actions" onClick={(e) => e.stopPropagation()}>
        {s.link && (
          <button
            class="icon-btn sm"
            title={t("Link kopieren")}
            aria-label={t("Link kopieren")}
            onClick={copyLink}
            data-testid="send-copy-link"
          >
            <Icon name="link" size={16} />
          </button>
        )}
        <button
          class="icon-btn sm"
          ref={moreRef}
          title={t("Weitere Optionen")}
          aria-label={t("Weitere Optionen")}
          onClick={() => setMenu(true)}
          data-testid="send-more"
        >
          <Icon name="more" size={16} />
        </button>
      </div>
      <div style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
        {menu && (
          <Popover anchor={moreRef.current} onClose={() => setMenu(false)} align="end">
            {editable && (
              <MenuItem
                icon="pencil"
                onClick={() => {
                  setMenu(false);
                  app.go({ name: "sendEdit", accountKey: s.accountKey, id: s.id });
                }}
              >
                {t("Bearbeiten")}
              </MenuItem>
            )}
            {s.link && (
              <MenuItem
                icon="link"
                onClick={() => {
                  setMenu(false);
                  copyLink();
                }}
              >
                {t("Link kopieren")}
              </MenuItem>
            )}
            {s.hasPassword && !blocked && (
              <MenuItem
                icon="unlock"
                onClick={async () => {
                  setMenu(false);
                  const r = await call("removeSendPassword", { accountKey: s.accountKey, id: s.id });
                  toast.show(r.ok ? t("Passwort entfernt") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
                }}
              >
                {t("Passwort entfernen")}
              </MenuItem>
            )}
            <MenuItem
              icon="trash"
              danger
              onClick={() => {
                setMenu(false);
                remove();
              }}
            >
              <span data-testid="send-delete">{t("Löschen")}</span>
            </MenuItem>
          </Popover>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// editor

const PRESETS: [string, string, number][] = [
  ["1h", tk("1 Stunde"), 3600_000],
  ["1d", tk("1 Tag"), 86400_000],
  ["2d", tk("2 Tage"), 2 * 86400_000],
  ["3d", tk("3 Tage"), 3 * 86400_000],
  ["7d", tk("7 Tage"), 7 * 86400_000],
  ["14d", tk("14 Tage"), 14 * 86400_000],
  ["30d", tk("30 Tage"), 30 * 86400_000],
];
const MAX_DELETION_MS = 31 * 86400_000;
const CHUNK = 4 * 1024 * 1024;

/** local "YYYY-MM-DDTHH:MM" for <input type="datetime-local"> */
function localInputValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatSize(n?: number) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/** The file goes to the background in base64 chunks and is encrypted there. */
async function uploadSendFile(accountKey: string, file: File, onProgress: (p: number) => void): Promise<string> {
  const { id } = await call("sendUploadStart", { accountKey, fileName: file.name, size: file.size });
  for (let off = 0; off < file.size; off += CHUNK) {
    const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    await call("attachmentUploadChunk", { id, data: b64encode(bytes) });
    onProgress(Math.min(1, (off + CHUNK) / file.size));
  }
  return id;
}

export function SendEditView({ route }: { route: Extract<Route, { name: "sendEdit" }> }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [data] = useSends(route.accountKey);
  const existing = route.id ? data?.sends.find((s) => s.id === route.id) : undefined;
  const isNew = !route.id;
  const type: SendType.Text | SendType.File =
    (existing?.type ?? route.type ?? SendType.Text) === SendType.File ? SendType.File : SendType.Text;

  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [hidden, setHidden] = useState(false);
  const [notes, setNotes] = useState("");
  const [password, setPassword] = useState("");
  const [maxAccess, setMaxAccess] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [hideEmail, setHideEmail] = useState(false);
  const [deletion, setDeletion] = useState(isNew ? "7d" : "keep");
  const [customDate, setCustomDate] = useState(localInputValue(new Date(Date.now() + 7 * 86400_000)));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<SendView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (!existing || loaded.current) return;
    loaded.current = true;
    setName(existing.name);
    setText(existing.text ?? "");
    setHidden(!!existing.hidden);
    setNotes(existing.notes ?? "");
    setMaxAccess(existing.maxAccessCount != null ? String(existing.maxAccessCount) : "");
    setDisabled(existing.disabled);
    setHideEmail(existing.hideEmail);
    setCustomDate(localInputValue(new Date(existing.deletionDate)));
  }, [existing]);

  const needsPopout = navigator.userAgent.includes("Firefox") && !app.popout;
  const blocked = !!data?.disableSend;

  const deletionDate = (): string => {
    if (deletion === "keep" && existing) return existing.deletionDate;
    const preset = PRESETS.find(([k]) => k === deletion);
    if (preset) return new Date(Date.now() + preset[2]).toISOString();
    const d = new Date(customDate);
    if (isNaN(d.getTime())) throw new Error(t("Bitte ein gültiges Löschdatum angeben"));
    if (d.getTime() <= Date.now()) throw new Error(t("Das Löschdatum muss in der Zukunft liegen"));
    if (d.getTime() - Date.now() > MAX_DELETION_MS) throw new Error(t("Das Löschdatum darf höchstens 31 Tage in der Zukunft liegen"));
    return d.toISOString();
  };

  const save = async () => {
    setError("");
    try {
      if (!name.trim()) throw new Error(t("Bitte einen Namen eingeben"));
      if (type === SendType.Text && !text) throw new Error(t("Bitte einen Text eingeben"));
      if (type === SendType.File && isNew && !file) throw new Error(t("Bitte eine Datei auswählen"));
      const max = maxAccess.trim() ? Number(maxAccess) : null;
      if (max != null && (!Number.isInteger(max) || max < 1))
        throw new Error(t("Die maximale Anzahl an Zugriffen muss eine ganze Zahl ab 1 sein"));
      const edit: SendEdit = {
        id: existing?.id,
        type,
        name: name.trim(),
        notes: notes || undefined,
        text: type === SendType.Text ? text : undefined,
        hidden,
        newPassword: password || undefined,
        maxAccessCount: max,
        disabled,
        hideEmail: !data?.disableHideEmail && hideEmail,
        deletionDate: deletionDate(),
        expirationDate: existing?.expirationDate ?? null,
      };
      setBusy(true);
      if (type === SendType.File && isNew && file) {
        setProgress(0);
        edit.uploadId = await uploadSendFile(route.accountKey, file, setProgress);
      }
      const r = await call("saveSend", { accountKey: route.accountKey, send: edit });
      if (!r.ok || !r.send) throw new Error(r.error ?? t("Speichern fehlgeschlagen"));
      if (isNew) {
        setCreated(r.send);
        try {
          await copyToClipboard(r.send.link, 0);
        } catch {
          /* copy button below */
        }
      } else {
        toast.show(t("Send gespeichert"));
        app.back();
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const title = isNew ? (type === SendType.File ? t("Neues Datei-Send") : t("Neues Text-Send")) : t("Send bearbeiten");

  if (created)
    return (
      <>
        <div class="topbar">
          <h1>{t("Send erstellt")}</h1>
        </div>
        <main>
          <div class="send-created" data-testid="send-created">
            <span class="row-icon big">
              <Icon name="send" size={26} />
            </span>
            <p>
              {t("Der Link ist kopiert. Jeder, der ihn hat, kann „{name}“ bis {date} öffnen.", {
                name: created.name,
                date: formatDate(created.deletionDate),
              })}
            </p>
            <div class="send-link mono" data-testid="send-link">
              {created.link}
            </div>
            <div class="row-gap">
              <button
                class="btn btn-primary"
                onClick={async () => {
                  await copyToClipboard(created.link, 0);
                  toast.show(t("Link kopiert"));
                }}
                data-testid="send-created-copy"
              >
                <Icon name="link" size={16} />
                {t("Link kopieren")}
              </button>
              <button class="btn btn-ghost" onClick={app.back} data-testid="send-created-done">
                {t("Fertig")}
              </button>
            </div>
          </div>
        </main>
      </>
    );

  if (!isNew && !existing)
    return (
      <>
        <div class="topbar">
          <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
            <Icon name="chevronLeft" size={20} />
          </button>
          <h1>{title}</h1>
        </div>
        <main>
          <div class="empty">{data ? t("Send nicht gefunden – bitte synchronisieren") : <Spinner />}</div>
        </main>
      </>
    );

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Abbrechen")}>
          <Icon name="x" size={20} />
        </button>
        <h1>{title}</h1>
      </div>
      <main>
        <form
          id="send-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {blocked && (
            <div class="banner">
              <Icon name="building" size={16} />
              <span class="grow">
                {t("Send ist durch eine Richtlinie deiner Organisation deaktiviert. Vorhandene Sends kannst du nur löschen.")}
              </span>
            </div>
          )}
          {type === SendType.File && isNew && data && !data.premium && (
            <div class="banner warn">{t("Datei-Sends erfordern bei Bitwarden ein Premium-Konto.")}</div>
          )}
          <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
            <Field label={t("Name")}>
              <TextInput value={name} onValue={setName} autoFocus={isNew} data-testid="send-name" />
            </Field>
            {type === SendType.Text ? (
              <>
                <Field label={t("Text")}>
                  <div class="input-wrap">
                    <textarea
                      rows={5}
                      value={text}
                      onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
                      data-testid="send-text"
                    />
                  </div>
                </Field>
                <div class="switch-row">
                  <span class="grow">{t("Text beim Öffnen zunächst ausblenden")}</span>
                  <Switch checked={hidden} onChange={setHidden} label={t("Text ausblenden")} testid="send-hidden" />
                </div>
              </>
            ) : isNew ? (
              <Field label={t("Datei")} group hint={t("Höchstens 500 MB. Die Datei wird vor dem Hochladen im Browser verschlüsselt.")}>
                <input
                  type="file"
                  ref={fileRef}
                  hidden
                  onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)}
                  data-testid="send-file"
                />
                <div class="row-gap">
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    onClick={() => {
                      if (needsPopout) {
                        chrome.windows.create({
                          url: chrome.runtime.getURL(`popup.html?popout=1&route=sendFile&account=${encodeURIComponent(route.accountKey)}`),
                          type: "popup",
                          width: 420,
                          height: 680,
                        });
                        window.close();
                      } else fileRef.current?.click();
                    }}
                  >
                    <Icon name="upload" size={15} />
                    {needsPopout ? t("Datei auswählen (im eigenen Fenster)") : t("Datei auswählen")}
                  </button>
                  {file && (
                    <span class="small" data-testid="send-file-name">
                      {file.name} · {formatSize(file.size)}
                    </span>
                  )}
                </div>
              </Field>
            ) : (
              <Field label={t("Datei")} group>
                <span>
                  {existing?.file?.fileName}{" "}
                  {existing?.file?.size != null && <span class="muted small">· {formatSize(existing.file.size)}</span>}
                </span>
              </Field>
            )}
          </div>

          <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
            <Field label={t("Löschdatum")} hint={t("Danach wird das Send endgültig gelöscht (höchstens 31 Tage).")}>
              <Select value={deletion} onChange={setDeletion} testid="send-deletion">
                {!isNew && existing && (
                  <option value="keep">{t("Unverändert ({date})", { date: formatDate(existing.deletionDate) })}</option>
                )}
                {PRESETS.map(([k, l]) => (
                  <option value={k} key={k}>
                    {t(l)}
                  </option>
                ))}
                <option value="custom">{t("Eigenes Datum")}</option>
              </Select>
            </Field>
            {deletion === "custom" && (
              <Field label={t("Löschen am")}>
                <div class="input-wrap">
                  <input
                    type="datetime-local"
                    value={customDate}
                    onInput={(e) => setCustomDate((e.target as HTMLInputElement).value)}
                    data-testid="send-deletion-custom"
                  />
                </div>
              </Field>
            )}
            <Field
              label={t("Maximale Anzahl an Zugriffen")}
              hint={!isNew && existing ? t("Bisher {n} Zugriffe", { n: existing.accessCount }) : t("Leer lassen für unbegrenzt")}
            >
              <TextInput value={maxAccess} onValue={setMaxAccess} inputMode="numeric" data-testid="send-max-access" />
            </Field>
            <Field
              label={existing?.hasPassword ? t("Neues Passwort") : t("Passwort (optional)")}
              hint={
                existing?.hasPassword
                  ? t("Das Send ist mit einem Passwort geschützt. Leer lassen, um es beizubehalten.")
                  : t("Empfänger brauchen dieses Passwort, um das Send zu öffnen.")
              }
            >
              <PasswordInput value={password} onValue={setPassword} autocomplete="new-password" name="send-password" />
            </Field>
            {existing?.authType === SendAuthType.Email && (
              <div class="hint" style={{ marginBottom: 10 }}>
                {t("Geschützt per E-Mail-Bestätigung für: {emails}", { emails: (existing.emails ?? []).join(", ") })}
              </div>
            )}
            <Field label={t("Private Notizen")} hint={t("Nur für dich sichtbar, nicht für Empfänger.")}>
              <div class="input-wrap">
                <textarea
                  rows={2}
                  value={notes}
                  onInput={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
                  data-testid="send-notes"
                />
              </div>
            </Field>
            {!data?.disableHideEmail && (
              <div class="switch-row">
                <span class="grow">{t("Meine E-Mail-Adresse vor Empfängern verbergen")}</span>
                <Switch checked={hideEmail} onChange={setHideEmail} label={t("E-Mail-Adresse verbergen")} testid="send-hide-email" />
              </div>
            )}
            <div class="switch-row">
              <span class="grow">{t("Send deaktivieren (niemand kann es öffnen)")}</span>
              <Switch checked={disabled} onChange={setDisabled} label={t("Send deaktivieren")} testid="send-disabled" />
            </div>
          </div>
          {progress !== null && (
            <div class="row-gap small muted">
              <Spinner /> {t("Wird verschlüsselt und hochgeladen … {p} %", { p: Math.round(progress * 100) })}
            </div>
          )}
          {error && (
            <div class="banner error" data-testid="send-error">
              {error}
            </div>
          )}
        </form>
      </main>
      <div class="footer-bar">
        {!blocked && (
          <button class="btn btn-primary" type="submit" form="send-form" disabled={busy || !data} data-testid="send-save">
            {busy && <Spinner />}
            {isNew ? t("Erstellen") : t("Speichern")}
          </button>
        )}
        <button class="btn btn-ghost" onClick={app.back}>
          {t("Abbrechen")}
        </button>
        {existing && (
          <button
            class="icon-btn"
            style={{ marginLeft: "auto", color: "var(--danger)" }}
            title={t("Löschen")}
            aria-label={t("Löschen")}
            data-testid="send-edit-delete"
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: t("Send löschen?"),
                message: t("„{name}“ wird endgültig gelöscht; der Link funktioniert danach nicht mehr.", { name: existing.name }),
                okLabel: t("Löschen"),
                danger: true,
              });
              if (!ok) return;
              const r = await call("deleteSend", { accountKey: existing.accountKey, id: existing.id });
              if (r.ok) {
                toast.show(t("Send gelöscht"));
                app.back();
              } else toast.show(r.error ?? t("Fehler"), "error");
            }}
          >
            <Icon name="trash" size={18} />
          </button>
        )}
      </div>
    </>
  );
}
