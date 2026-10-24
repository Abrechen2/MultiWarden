import { ComponentChildren } from "preact";
import { ChangePasswordButton } from "./AtRisk";
import { EventType } from "../../shared/events";
import { useEffect, useRef, useState } from "preact/hooks";
import { b64encode, decryptFileData, deserializeKey } from "../../crypto/bw";
import { CipherType, FieldType, ItemView, UriMatch } from "../../shared/types";
import { describeScope } from "../fill-scope";
import { useApp } from "../app-state";
import {
  AccountBadge,
  ColoredPassword,
  formatTotp,
  ItemIcon,
  MenuItem,
  Popover,
  Spinner,
  TotpRing,
  useToast,
  useTotp,
} from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { formatDate, itemKey, launchUrl, TYPE_LABEL } from "../util";
import { useItemActions } from "./item-actions";

import { inSentence, locale, localized, t, tk } from "../../shared/i18n";
import { EXTRA_FIELDS, FieldDef, IDENTITY_FIELDS } from "./item-fields";
function KV({
  label,
  children,
  copy,
  copyLabel,
  extra,
  testid,
}: {
  label: string;
  children: ComponentChildren;
  copy?: () => void;
  copyLabel?: string;
  extra?: ComponentChildren;
  testid?: string;
}) {
  return (
    <div class="kv" data-testid={testid}>
      <div class="grow">
        <div class="k">{label}</div>
        <div class="v">{children}</div>
      </div>
      {extra}
      {copy && (
        <button
          class="icon-btn sm"
          onClick={copy}
          title={copyLabel ?? t("{label} kopieren", { label })}
          aria-label={copyLabel ?? t("{label} kopieren", { label })}
        >
          <Icon name="copy" size={16} />
        </button>
      )}
    </div>
  );
}

function Secret({
  value,
  item,
  label,
  copyAs,
  showEvent,
  copyEvent,
}: {
  value: string;
  item: ItemView;
  label: string;
  copyAs?: string;
  /** event log entries (organizations) for revealing / copying */
  showEvent?: number;
  copyEvent?: number;
}) {
  const [show, setShow] = useState(false);
  const actions = useItemActions(item);
  return (
    <KV
      label={label}
      copy={() => actions.copy(value, copyAs ?? label, true, copyEvent)}
      extra={
        <button
          class="icon-btn sm"
          title={show ? t("Verbergen") : t("Anzeigen")}
          aria-label={show ? t("Verbergen") : t("Anzeigen")}
          onClick={async () => {
            if (!show && !(await actions.guard())) return;
            if (!show && showEvent) actions.logEvent(showEvent);
            setShow(!show);
          }}
        >
          <Icon name={show ? "eyeOff" : "eye"} size={16} />
        </button>
      }
    >
      {show ? <ColoredPassword value={value} /> : <span class="mono">{"•".repeat(Math.min(Math.max(value.length, 8), 20))}</span>}
    </KV>
  );
}

/** Passkey(s) of a login: summary, details on request (the private key always stays in the background). */
function PasskeyInfo({ item }: { item: ItemView }) {
  const actions = useItemActions(item);
  const [open, setOpen] = useState(false);
  const list = item.login?.fido2 ?? [];
  const first = list[0];
  return (
    <>
      <KV
        label={list.length > 1 ? t("Passkeys ({n})", { n: list.length }) : t("Passkey")}
        testid="detail-passkey"
        extra={
          list.length > 0 ? (
            <button
              class="icon-btn sm"
              title={open ? t("Details ausblenden") : t("Details anzeigen")}
              aria-label={open ? t("Details ausblenden") : t("Details anzeigen")}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              data-testid="passkey-details-toggle"
            >
              <Icon name={open ? "eyeOff" : "eye"} size={16} />
            </button>
          ) : undefined
        }
      >
        <span class="row-gap" style={{ gap: 6, flexWrap: "wrap" }}>
          <Icon name="passkey" size={16} />
          {first ? (
            <>
              {first.userName || first.userDisplayName || "Passkey"} · {first.rpId}
              {first.creationDate && <span class="muted small">{t("(erstellt {date})", { date: formatDate(first.creationDate) })}</span>}
            </>
          ) : (
            t("Passkey gespeichert")
          )}
        </span>
      </KV>
      {open &&
        list.map((pk, idx) => {
          const rows: [string, string | undefined, boolean?][] = [
            [t("Website (Relying Party)"), pk.rpId],
            [t("Name der Website"), pk.rpName],
            [t("Benutzername"), pk.userName],
            [t("Anzeigename"), pk.userDisplayName],
            [t("Benutzerkennung"), pk.userHandle, true],
            [t("Credential-ID"), pk.credentialId, true],
            [t("Auffindbar (ohne Benutzernamen anmelden)"), pk.discoverable ? t("Ja") : t("Nein")],
            [t("Signaturzähler"), String(pk.counter ?? 0)],
            [t("Erstellt"), pk.creationDate ? formatDate(pk.creationDate) : undefined],
          ];
          return (
            <div class="passkey-details" key={pk.credentialId || idx} data-testid="passkey-details">
              {list.length > 1 && <div class="k">{t("Passkey {n}", { n: idx + 1 })}</div>}
              {rows
                .filter(([, v]) => v)
                .map(([k, v, mono]) => (
                  <div class="pk-row" key={k}>
                    <span class="k">{k}</span>
                    <span class={"v" + (mono ? " mono" : "")}>{v}</span>
                    {mono && (
                      <button
                        class="icon-btn sm"
                        title={t("{label} kopieren", { label: k })}
                        aria-label={t("{label} kopieren", { label: k })}
                        onClick={() => actions.copy(v, k)}
                      >
                        <Icon name="copy" size={14} />
                      </button>
                    )}
                  </div>
                ))}
            </div>
          );
        })}
    </>
  );
}

/** Fetch, decrypt and save an attachment (decryption happens locally in the extension). */
export async function downloadAttachment(accountKey: string, itemId: string, attachmentId: string): Promise<string> {
  const d = await call("attachmentDownload", { accountKey, itemId, attachmentId });
  const res = await fetch(d.url, { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(t("Download fehlgeschlagen (HTTP {status})", { status: res.status }));
  const enc = new Uint8Array(await res.arrayBuffer());
  let plain: Uint8Array;
  try {
    plain = await decryptFileData(enc, deserializeKey(d.key));
  } catch {
    throw new Error(t("Der Anhang konnte nicht entschlüsselt werden"));
  }
  const blob = new Blob([plain.slice().buffer as ArrayBuffer], { type: "application/octet-stream" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = d.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return d.fileName;
}

const CHUNK = 4 * 1024 * 1024;

/** Upload a file as attachment: sent to the background in base64 chunks, encrypted there. */
export async function uploadAttachment(accountKey: string, itemId: string, file: File, onProgress?: (p: number) => void) {
  const { id } = await call("attachmentUploadStart", { accountKey, itemId, fileName: file.name, size: file.size });
  for (let off = 0; off < file.size; off += CHUNK) {
    const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
    await call("attachmentUploadChunk", { id, data: b64encode(bytes) });
    onProgress?.(Math.min(1, (off + CHUNK) / file.size));
  }
  const r = await call("attachmentUploadFinish", { id });
  if (!r.ok) throw new Error(r.error ?? t("Upload fehlgeschlagen"));
}

function AttachmentUpload({ item }: { item: ItemView }) {
  const app = useApp();
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  // Firefox closes the toolbar popup while the file dialog is open
  const needsPopout = navigator.userAgent.includes("Firefox") && !app.popout;
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProgress(0);
    try {
      await uploadAttachment(item.accountKey, item.id, file, setProgress);
      await app.reloadVault();
      toast.show(t("„{name}“ angehängt", { name: file.name }));
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    } finally {
      setProgress(null);
      if (ref.current) ref.current.value = "";
    }
  };
  return (
    <div class="kv" style={{ minHeight: 0 }}>
      <input type="file" ref={ref} hidden onChange={(e) => pick((e.target as HTMLInputElement).files?.[0])} data-testid="attachment-file" />
      {progress !== null ? (
        <span class="row-gap small muted">
          <Spinner /> {t("Wird verschlüsselt und hochgeladen … {p} %", { p: Math.round(progress * 100) })}
        </span>
      ) : (
        <button
          class="btn btn-ghost btn-sm"
          style={{ padding: 0 }}
          data-testid="attachment-add"
          onClick={() => {
            if (needsPopout) {
              chrome.windows.create({ url: chrome.runtime.getURL("popup.html?popout=1"), type: "popup", width: 420, height: 680 });
              window.close();
            } else ref.current?.click();
          }}
        >
          <Icon name="plus" size={14} />
          {needsPopout ? t("Datei anhängen (im eigenen Fenster)") : t("Datei anhängen")}
        </button>
      )}
    </div>
  );
}

function Attachment({ item, att }: { item: ItemView; att: ItemView["attachments"][number] }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const actions = useItemActions(item);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!(await actions.guard())) return;
    setBusy(true);
    try {
      const name = await downloadAttachment(item.accountKey, item.id, att.id);
      toast.show(t("„{name}“ heruntergeladen", { name }));
    } catch (e: any) {
      toast.show(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await dialogs.confirm({
      title: t("Anhang löschen?"),
      message: t("„{name}“ wird endgültig gelöscht.", { name: att.fileName }),
      okLabel: t("Löschen"),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const r = await call("attachmentDelete", { accountKey: item.accountKey, itemId: item.id, attachmentId: att.id });
    setBusy(false);
    if (r.ok) await app.reloadVault();
    toast.show(r.ok ? t("Anhang gelöscht") : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  };
  return (
    <KV
      label={att.sizeName ?? ""}
      testid="attachment"
      extra={
        <>
          <button
            class="icon-btn sm"
            onClick={download}
            disabled={busy}
            title={t("Herunterladen")}
            aria-label={t("{name} herunterladen", { name: att.fileName })}
            data-testid="attachment-download"
          >
            {busy ? <Spinner /> : <Icon name="download" size={16} />}
          </button>
          {item.edit && (
            <button
              class="icon-btn sm"
              onClick={remove}
              disabled={busy}
              title={t("Löschen")}
              aria-label={t("{name} löschen", { name: att.fileName })}
              data-testid="attachment-delete"
              style={{ color: "var(--danger)" }}
            >
              <Icon name="trash" size={15} />
            </button>
          )}
        </>
      }
    >
      <span class="row-gap" style={{ gap: 6, wordBreak: "break-all" }}>
        <Icon name="paperclip" size={14} />
        {att.fileName}
      </span>
    </KV>
  );
}

function Totp({ item }: { item: ItemView }) {
  const code = useTotp(item.login?.totp);
  const actions = useItemActions(item);
  if (!item.login?.totp) return null;
  return (
    <KV label={t("Bestätigungscode (TOTP)")} copy={code ? () => actions.copy(code.code, t("Bestätigungscode")) : undefined} testid="totp">
      {code ? (
        <span class="totp">
          <span class="code">{formatTotp(code.code)}</span>
          <TotpRing remaining={code.remaining} period={code.period} />
        </span>
      ) : (
        <span class="muted">{t("Ungültiger Schlüssel")}</span>
      )}
    </KV>
  );
}

function Card({ title, children }: { title?: string; children: ComponentChildren }) {
  return (
    <div class="detail-card">
      {title && <h3>{title}</h3>}
      {children}
    </div>
  );
}

const LINKED_LABEL: Record<number, string> = localized({ 100: tk("Benutzername"), 101: tk("Passwort") });

export function ItemDetailView({ itemKeyStr }: { itemKeyStr: string }) {
  const app = useApp();
  const item = app.itemByKey(itemKeyStr);
  if (!item)
    return (
      <>
        <div class="topbar">
          <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
            <Icon name="chevronLeft" size={20} />
          </button>
          <h1>{t("Eintrag")}</h1>
        </div>
        <main>
          <div class="empty">{t("Eintrag nicht gefunden.")}</div>
        </main>
      </>
    );
  return <ItemDetailInner item={item} itemKeyStr={itemKeyStr} />;
}

function ItemDetailInner({ item, itemKeyStr }: { item: ItemView; itemKeyStr: string }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [showHistory, setShowHistory] = useState(false);
  const acc = app.accountMap.get(item.accountKey);
  const actions = useItemActions(item);
  useEffect(() => actions.logEvent(EventType.CipherClientViewed), [item.accountKey, item.id]);
  const folder = item.folderId ? app.vault.folders.find((f) => f.accountKey === item.accountKey && f.id === item.folderId) : undefined;
  const org = item.organizationId ? app.vault.organizations.find((o) => o.id === item.organizationId) : undefined;
  const cols = app.vault.collections.filter((c) => item.collectionIds.includes(c.id) && c.accountKey === item.accountKey);
  const l = item.login;
  const defaultMatch = (app.accountMap.get(item.accountKey)?.policies?.uriMatch ?? app.state.settings.defaultUriMatch) as UriMatch;

  async function remove() {
    const ok = await dialogs.confirm({
      title: t("Eintrag löschen?"),
      message: acc?.label
        ? t("„{name}“ wird in den Papierkorb von {account} verschoben.", { name: item!.name, account: acc.label })
        : t("„{name}“ wird in den Papierkorb verschoben.", { name: item!.name }),
      okLabel: t("In den Papierkorb"),
      danger: true,
    });
    if (!ok) return;
    const r = await call("deleteItem", { accountKey: item!.accountKey, itemId: item!.id });
    if (r.ok) {
      toast.show(t("In den Papierkorb verschoben"));
      app.back();
    } else toast.show(r.error ?? t("Löschen fehlgeschlagen"), "error");
  }

  const idEntries = IDENTITY_FIELDS.filter((f) => item.identity?.[f.key]);
  const extraDefs = EXTRA_FIELDS[item.type];
  const extraEntries = extraDefs ? extraDefs.filter((f) => item.extra?.[f.key]) : [];
  // unknown fields of item types this version does not know yet
  const extraUnknown = Object.entries(item.extra ?? {}).filter(([k, v]) => v && !extraDefs?.some((f) => f.key === k));

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("{type} ansehen", { type: inSentence(TYPE_LABEL[item.type] ?? t("Eintrag")) })}</h1>
        <button
          class="icon-btn"
          title={item.favorite ? t("Aus Favoriten entfernen") : t("Zu Favoriten hinzufügen")}
          onClick={actions.toggleFavorite}
        >
          <Icon name="star" size={18} filled={item.favorite} class={item.favorite ? "fav" : ""} />
        </button>
      </div>
      <main>
        {acc?.atRisk?.includes(item.id) && item.login && (
          <div class="banner warn" data-testid="detail-at-risk">
            <Icon name="alert" size={16} />
            <span class="grow">{t("Deine Organisation bittet dich, dieses Passwort zu ändern.")}</span>
            <ChangePasswordButton item={item} small />
          </div>
        )}
        <div class="detail-card">
          <div class="detail-head">
            <ItemIcon item={item} acc={acc} favicons={app.state.settings.showFavicons} />
            <div style={{ minWidth: 0 }}>
              <div class="name" data-testid="detail-name">
                {item.name}
              </div>
              {item.decryptError && <div class="error-text">{t("Teile dieses Eintrags konnten nicht entschlüsselt werden.")}</div>}
              {item.archivedDate && (
                <div class="muted small row-gap" style={{ gap: 4 }} data-testid="detail-archived">
                  <Icon name="archive" size={13} />
                  {t("Archiviert am {date}", { date: formatDate(item.archivedDate) })}
                </div>
              )}
            </div>
          </div>
          <div class="kv" data-testid="detail-account">
            <div class="grow">
              <div class="k">{t("Konto")}</div>
              <div class="v row-gap" style={{ gap: 6 }}>
                <AccountBadge acc={acc} />
                <span>{acc?.label}</span>
                <span class="muted small">· {acc?.serverLabel}</span>
              </div>
            </div>
          </div>
          {(org || folder || cols.length > 0) && (
            <div class="kv">
              <div class="grow">
                {org && (
                  <div class="row-gap small" style={{ gap: 6 }}>
                    <Icon name="building" size={14} /> {org.name}
                  </div>
                )}
                {cols.map((c) => (
                  <div class="row-gap small" style={{ gap: 6 }} key={c.id}>
                    <Icon name="collection" size={14} /> {c.name}
                  </div>
                ))}
                {folder && (
                  <div class="row-gap small" style={{ gap: 6 }}>
                    <Icon name="folder" size={14} /> {folder.name}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {item.type === CipherType.Login && l && (l.username || l.password || l.totp || l.passkeys > 0) && (
          <Card title={t("Anmeldedaten")}>
            {l.username && (
              <KV label={t("Benutzername")} copy={() => actions.copy(l.username, t("Benutzername"))} testid="detail-username">
                {l.username}
              </KV>
            )}
            {l.password && item.viewPassword && (
              <Secret
                value={l.password}
                item={item}
                label={t("Passwort")}
                showEvent={EventType.CipherClientToggledPasswordVisible}
                copyEvent={EventType.CipherClientCopiedPassword}
              />
            )}
            {l.password && item.viewPassword && <ExposedCheck item={item} />}
            {l.password && !item.viewPassword && (
              <KV label={t("Passwort")}>
                <span class="muted">{t("verborgen (keine Berechtigung)")}</span>
              </KV>
            )}
            {l.passkeys > 0 && <PasskeyInfo item={item} />}
            <Totp item={item} />
          </Card>
        )}

        {item.type === CipherType.Login && l && l.uris.length > 0 && (
          <Card title={t("Autofill-Optionen")}>
            {l.uris.map((u, idx) => {
              const href = launchUrl(u.uri);
              return (
                <KV
                  key={idx}
                  label={l.uris.length > 1 ? t("Website {n}", { n: idx + 1 }) : t("Website")}
                  copy={() => actions.copy(u.uri, "URL")}
                  copyLabel={t("URL kopieren")}
                  extra={
                    href ? (
                      <button
                        class="icon-btn sm"
                        title={t("Website öffnen")}
                        onClick={() => {
                          chrome.tabs.create({ url: href });
                          if (!app.popout) window.close();
                        }}
                      >
                        <Icon name="external" size={16} />
                      </button>
                    ) : undefined
                  }
                >
                  {u.uri}
                </KV>
              );
            })}
            {describeScope(l.uris, defaultMatch) && (
              <KV label={t("Ausfüllen auf")}>
                <span data-testid="fill-scope-info">{describeScope(l.uris, defaultMatch)}</span>
              </KV>
            )}
          </Card>
        )}

        {item.type === CipherType.Card && item.card && (
          <Card title={t("Kartendaten")}>
            {item.card.cardholderName && (
              <KV label={t("Karteninhaber")} copy={() => actions.copy(item.card!.cardholderName, "Karteninhaber")}>
                {item.card.cardholderName}
              </KV>
            )}
            {item.card.brand && <KV label={t("Marke")}>{item.card.brand}</KV>}
            {item.card.number && (
              <Secret
                value={item.card.number}
                item={item}
                label={t("Kartennummer")}
                showEvent={EventType.CipherClientToggledCardNumberVisible}
              />
            )}
            {(item.card.expMonth || item.card.expYear) && (
              <KV label={t("Gültig bis")}>
                {(item.card.expMonth ?? "").padStart(2, "0")}/{item.card.expYear}
              </KV>
            )}
            {item.card.code && (
              <Secret
                value={item.card.code}
                item={item}
                label={t("Prüfnummer")}
                showEvent={EventType.CipherClientToggledCardCodeVisible}
                copyEvent={EventType.CipherClientCopiedCardCode}
              />
            )}
          </Card>
        )}

        {item.type === CipherType.Identity && idEntries.length > 0 && (
          <Card title={t("Identität")}>
            {idEntries.map((f) => (
              <FieldView key={f.key} def={f} value={item.identity![f.key]!} item={item} />
            ))}
          </Card>
        )}

        {item.type === CipherType.SshKey && item.sshKey && (
          <Card title={t("SSH-Schlüssel")}>
            {item.sshKey.privateKey && <Secret value={item.sshKey.privateKey} item={item} label={t("Privater Schlüssel")} />}
            {item.sshKey.publicKey && (
              <KV label={t("Öffentlicher Schlüssel")} copy={() => actions.copy(item.sshKey!.publicKey, t("Öffentlicher Schlüssel"))}>
                <span class="mono small">{item.sshKey.publicKey}</span>
              </KV>
            )}
            {item.sshKey.keyFingerprint && (
              <KV label={t("Fingerabdruck")} copy={() => actions.copy(item.sshKey!.keyFingerprint, t("Fingerabdruck"))}>
                <span class="mono small">{item.sshKey.keyFingerprint}</span>
              </KV>
            )}
          </Card>
        )}

        {(extraEntries.length > 0 || extraUnknown.length > 0) && (
          <Card title={TYPE_LABEL[item.type] ?? t("Details")}>
            {extraEntries.map((f) => (
              <FieldView key={f.key} def={f} value={item.extra![f.key]!} item={item} />
            ))}
            {extraUnknown.map(([k, v]) => (
              <Secret key={k} value={v!} item={item} label={k} />
            ))}
          </Card>
        )}

        {item.notes && (
          <Card title={t("Notizen")}>
            <KV label="" copy={() => actions.copy(item.notes, t("Notiz"), item.type === CipherType.SecureNote)}>
              <span style={{ whiteSpace: "pre-wrap" }}>{item.notes}</span>
            </KV>
          </Card>
        )}

        {item.fields.length > 0 && (
          <Card title={t("Benutzerdefinierte Felder")}>
            {item.fields.map((f, i) =>
              f.type === FieldType.Hidden ? (
                <Secret
                  key={i}
                  value={f.value}
                  item={item}
                  label={f.name}
                  showEvent={EventType.CipherClientToggledHiddenFieldVisible}
                  copyEvent={EventType.CipherClientCopiedHiddenField}
                />
              ) : f.type === FieldType.Boolean ? (
                <KV key={i} label={f.name}>
                  <input type="checkbox" checked={f.value === "true"} disabled />
                </KV>
              ) : f.type === FieldType.Linked ? (
                <KV key={i} label={f.name}>
                  <span class="muted">
                    {t("verknüpft mit")} {LINKED_LABEL[f.linkedId ?? 0] ?? t("Feld {n}", { n: f.linkedId ?? "" })}
                  </span>
                </KV>
              ) : (
                <KV key={i} label={f.name} copy={() => actions.copy(f.value, f.name)}>
                  {f.value}
                </KV>
              ),
            )}
          </Card>
        )}

        {(item.attachments.length > 0 || item.edit) && (
          <Card title={t("Anhänge")}>
            {item.attachments.map((a) => (
              <Attachment key={a.id} item={item} att={a} />
            ))}
            {item.edit && <AttachmentUpload item={item} />}
          </Card>
        )}

        <Card title={t("Verlauf")}>
          <div class="kv" style={{ minHeight: 0 }}>
            <div class="grow small muted">
              {item.revisionDate && (
                <div>
                  {t("Zuletzt bearbeitet:")} {formatDate(item.revisionDate)}
                </div>
              )}
              {item.creationDate && (
                <div>
                  {t("Erstellt:")} {formatDate(item.creationDate)}
                </div>
              )}
              {l?.passwordRevisionDate && (
                <div>
                  {t("Passwort aktualisiert:")} {formatDate(l.passwordRevisionDate)}
                </div>
              )}
              {item.passwordHistory.length > 0 && (
                <button class="btn btn-ghost btn-sm" style={{ padding: 0, marginTop: 4 }} onClick={() => setShowHistory(!showHistory)}>
                  {t("Passwortverlauf ({n})", { n: item.passwordHistory.length })}
                </button>
              )}
            </div>
          </div>
          {showHistory &&
            item.passwordHistory.map((p, i) => (
              <KV key={i} label={formatDate(p.lastUsedDate)} copy={() => actions.copy(p.password, t("Altes Passwort"), true)}>
                <ColoredPassword value={p.password} />
              </KV>
            ))}
        </Card>
      </main>
      <div class="footer-bar">
        {item.edit && (
          <button class="btn btn-primary" onClick={() => app.go({ name: "edit", key: itemKeyStr })} data-testid="edit">
            <Icon name="pencil" size={15} />
            {t("Bearbeiten")}
          </button>
        )}
        {actions.canFill && (
          <button class="btn btn-secondary" onClick={actions.fill} data-testid="detail-fill">
            {t("Ausfüllen")}
          </button>
        )}
        <span class="grow" />
        <ItemMoreMenu item={item} />
        {item.edit && (
          <button class="icon-btn" title={t("Löschen")} onClick={remove} style={{ color: "var(--danger)" }} data-testid="delete">
            <Icon name="trash" size={18} />
          </button>
        )}
      </div>
    </>
  );
}

/** Clone, copy into another account, archive, move to an organization / collections. */
function ItemMoreMenu({ item }: { item: ItemView }) {
  const app = useApp();
  const toast = useToast();
  const actions = useItemActions(item);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const key = itemKey(item);
  const orgs = app.vault.organizations.filter((o) => o.accountKey === item.accountKey);
  const canMove = !item.organizationId && item.edit && orgs.length > 0;
  const canAssign = !!item.organizationId && item.edit;
  const archive = async (v: boolean) => {
    setOpen(false);
    const r = await call("archiveItem", { accountKey: item.accountKey, itemId: item.id, archive: v });
    if (r.ok) await app.reloadVault();
    toast.show(r.ok ? (v ? t("Archiviert") : t("Aus dem Archiv geholt")) : (r.error ?? t("Fehler")), r.ok ? "ok" : "error");
  };
  const clone = () => {
    setOpen(false);
    const copy: Partial<ItemView> = structuredClone({
      ...item,
      id: "",
      name: t("{name} – Kopie", { name: item.name }),
      attachments: [],
      passwordHistory: [],
      archivedDate: null,
      creationDate: undefined,
      revisionDate: undefined,
    });
    if (copy.login) copy.login = { ...copy.login, passkeys: 0, fido2: undefined };
    app.go({ name: "edit", newType: item.type, accountKey: item.accountKey, prefill: copy });
  };
  return (
    <>
      <button
        class="icon-btn"
        ref={ref}
        title={t("Weitere Optionen")}
        aria-label={t("Weitere Optionen")}
        onClick={() => setOpen(true)}
        data-testid="detail-more"
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <Popover anchor={ref.current} onClose={() => setOpen(false)} align="end">
          <MenuItem icon="copy" onClick={clone}>
            <span data-testid="menu-clone">{t("Klonen")}</span>
          </MenuItem>
          {actions.canCopyToAccount && (
            <MenuItem
              icon="copy"
              onClick={() => {
                setOpen(false);
                actions.copyToAccount();
              }}
            >
              <span data-testid="menu-copy-account">{t("In anderes Konto kopieren")}</span>
            </MenuItem>
          )}
          {actions.canMoveToPersonal && (
            <MenuItem
              icon="copy"
              onClick={() => {
                setOpen(false);
                actions.moveToPersonal();
              }}
            >
              <span data-testid="menu-move-personal">{t("In persönlichen Tresor verschieben")}</span>
            </MenuItem>
          )}
          {item.edit && !item.deletedDate && (
            <MenuItem icon="archive" onClick={() => archive(!item.archivedDate)}>
              <span data-testid="menu-archive">{item.archivedDate ? t("Aus dem Archiv holen") : t("Archivieren")}</span>
            </MenuItem>
          )}
          {canMove && (
            <MenuItem
              icon="building"
              onClick={() => {
                setOpen(false);
                app.go({ name: "assign", key });
              }}
            >
              <span data-testid="menu-move-org">{t("In Organisation verschieben")}</span>
            </MenuItem>
          )}
          {canAssign && (
            <MenuItem
              icon="collection"
              onClick={() => {
                setOpen(false);
                app.go({ name: "assign", key });
              }}
            >
              <span data-testid="menu-collections">{t("Sammlungen zuweisen")}</span>
            </MenuItem>
          )}
        </Popover>
      )}
    </>
  );
}

/** Have I Been Pwned (k-anonymity): only the first 5 hex chars of the SHA-1 hash leave the device. */
export async function exposedCount(password: string): Promise<number> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const res = await fetch("https://api.pwnedpasswords.com/range/" + hash.slice(0, 5), {
    headers: { "Add-Padding": "true" },
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(t("Prüfung fehlgeschlagen (HTTP {status})", { status: res.status }));
  const suffix = hash.slice(5);
  for (const line of (await res.text()).split("\n")) {
    const [h, n] = line.trim().split(":");
    if (h === suffix) return Number(n) || 0;
  }
  return 0;
}

function ExposedCheck({ item }: { item: ItemView }) {
  const [state, setState] = useState<"idle" | "busy" | number | string>("idle");
  const actions = useItemActions(item);
  const run = async () => {
    if (!(await actions.guard())) return;
    setState("busy");
    try {
      setState(await exposedCount(item.login!.password!));
    } catch (e: any) {
      setState(e?.message ?? String(e));
    }
  };
  return (
    <div class="kv" style={{ minHeight: 0, paddingTop: 0 }} data-testid="exposed-check">
      {state === "idle" ? (
        <button class="btn btn-ghost btn-sm" style={{ padding: 0 }} onClick={run} data-testid="exposed-run">
          <Icon name="shield" size={14} />
          {t("Prüfen, ob das Passwort in Datenlecks vorkommt")}
        </button>
      ) : state === "busy" ? (
        <span class="small muted row-gap">
          <Spinner /> {t("Wird geprüft …")}
        </span>
      ) : typeof state === "number" ? (
        <span class={"small " + (state > 0 ? "error-text" : "ok-text")} data-testid="exposed-result">
          {state > 0
            ? t("Dieses Passwort kam {n}-mal in Datenlecks vor. Du solltest es ändern.", { n: state.toLocaleString(locale()) })
            : t("In keinem bekannten Datenleck gefunden.")}
        </span>
      ) : (
        <span class="small error-text">{state}</span>
      )}
    </div>
  );
}

function FieldView({ def, value, item }: { def: FieldDef; value: string; item: ItemView }) {
  const actions = useItemActions(item);
  const label = t(def.label);
  if (def.secret) return <Secret value={value} item={item} label={label} />;
  let shown = value;
  if (def.input === "select") shown = t(def.options?.find(([v]) => v === value)?.[1] ?? value);
  else if (def.input === "date" && /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    shown = new Date(y, m - 1, d).toLocaleDateString(locale());
  }
  return (
    <KV label={label} copy={() => actions.copy(value, label)}>
      <span class={def.mono ? "mono" : ""}>{shown}</span>
    </KV>
  );
}
