// Vault export (Bitwarden formats + zip with attachments) and import (Bitwarden, browsers, other managers).
import { strToU8, zipSync } from "fflate";
import { useEffect, useRef, useState } from "preact/hooks";
import { decryptFileData, deserializeKey } from "../../crypto/bw";
import { useApp } from "../app-state";
import { Field, PasswordInput, Spinner, useToast } from "../components";
import { Icon } from "../icons";
import { IMPORT_FORMATS, ImportItem, ParsedImport, fromBitwardenDoc, parseImport } from "../import-formats";
import { call } from "../rpc";
import { TYPE_LABEL } from "../util";

import { t, tk } from "../../shared/i18n";

function saveFile(data: BlobPart, fileName: string, type: string) {
  const href = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

function AccountSelect({ value, onChange, testid }: { value: string; onChange: (v: string) => void; testid?: string }) {
  const app = useApp();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  if (unlocked.length < 2) return null;
  return (
    <Field label={t("Konto")}>
      <div class="input-wrap">
        <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} data-testid={testid}>
          {unlocked.map((a) => (
            <option value={a.key} key={a.key}>
              {a.label} ({a.serverLabel})
            </option>
          ))}
        </select>
      </div>
    </Field>
  );
}

const EXPORT_FORMATS: [string, string][] = [
  ["json", ".json"],
  ["csv", ".csv"],
  ["encrypted_json", tk(".json (verschlüsselt)")],
  ["zip", tk(".zip (mit Anhängen)")],
];

/** Personal attachments as files in a zip next to data.json (like the official zip export). */
async function buildZip(
  json: string,
  accountKey: string,
  items: { id: string; name: string; attachments: { id: string; fileName: string }[] }[],
) {
  const files: Record<string, Uint8Array> = { "data.json": strToU8(json) };
  let skipped = 0;
  const used = new Map<string, number>();
  for (const it of items) {
    if (!it.attachments.length) continue;
    let dir = it.name.replace(/[/\\><:"|?*]/g, "_").replace(/__+/g, "_") || "item";
    const n = used.get(dir) ?? 0;
    used.set(dir, n + 1);
    if (n) dir += "_" + n;
    const names = new Map<string, number>();
    for (const a of it.attachments) {
      try {
        const d = await call("attachmentDownload", { accountKey, itemId: it.id, attachmentId: a.id });
        const res = await fetch(d.url, { credentials: "omit", cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const plain = await decryptFileData(new Uint8Array(await res.arrayBuffer()), deserializeKey(d.key));
        let name = d.fileName.replace(/[/\\><:"|?*]/g, "_");
        const k = names.get(name) ?? 0;
        names.set(name, k + 1);
        if (k) name = name.replace(/(\.[^.]*)?$/, (ext) => `_${k}${ext}`);
        files[`attachments/${dir}/${name}`] = plain;
      } catch {
        skipped++;
      }
    }
  }
  return { zip: zipSync(files, { level: 6 }), skipped };
}

export function ExportView() {
  const app = useApp();
  const toast = useToast();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const [accountKey, setAccountKey] = useState(unlocked[0]?.key ?? "");
  const [format, setFormat] = useState("json");
  const [encType, setEncType] = useState<"account" | "password">("account");
  const [filePw, setFilePw] = useState("");
  const [filePw2, setFilePw2] = useState("");
  const [methods, setMethods] = useState<{ mp: boolean; pin: boolean } | null>(null);
  const [mode, setMode] = useState<"mp" | "pin" | "otp">("mp");
  const [secret, setSecret] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setMethods(null);
    setSecret("");
    setOtpSent(false);
    call("verifyMethods", { accountKey })
      .then((m) => {
        setMethods(m);
        setMode(m.mp ? "mp" : m.pin ? "pin" : "otp");
      })
      .catch(() => setMethods({ mp: true, pin: false }));
  }, [accountKey]);
  const acc = app.accountMap.get(accountKey);

  async function run() {
    setError("");
    if (format === "encrypted_json" && encType === "password") {
      if (filePw.length < 8) return setError(t("Das Dateipasswort muss mindestens 8 Zeichen haben."));
      if (filePw !== filePw2) return setError(t("Die Dateipasswörter stimmen nicht überein."));
    }
    if (!secret) return setError(mode === "otp" ? t("Bitte den Code aus der E-Mail eingeben.") : t("Bitte zur Bestätigung eingeben."));
    setBusy(true);
    try {
      const fmt = format === "zip" ? "json" : format === "encrypted_json" && encType === "password" ? "password_json" : format;
      const r = await call("exportVault", {
        accountKey,
        format: fmt as any,
        mode,
        secret,
        filePassword: fmt === "password_json" ? filePw : undefined,
      });
      if (format === "zip") {
        const personal = app.vault.items.filter((i) => i.accountKey === accountKey && !i.organizationId && !i.deletedDate);
        const { zip, skipped } = await buildZip(r.data, accountKey, personal);
        saveFile(zip.slice().buffer as ArrayBuffer, r.fileName.replace(/\.json$/, ".zip"), "application/zip");
        toast.show(skipped ? t("Exportiert – {n} Anhänge konnten nicht gespeichert werden", { n: skipped }) : t("Tresor exportiert"));
      } else {
        saveFile(r.data, r.fileName, format === "csv" ? "text/csv" : "application/json");
        toast.show(t("Tresor exportiert"));
      }
      setSecret("");
    } catch (e: any) {
      setError(t(e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Tresor exportieren")}</h1>
      </div>
      <main>
        <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
          <AccountSelect value={accountKey} onChange={setAccountKey} testid="export-account" />
          {acc?.policies?.disableExport ? (
            <div class="banner warn" data-testid="export-blocked">
              {t("Eine Richtlinie deiner Organisation verbietet den Export des persönlichen Tresors.")}
            </div>
          ) : (
            <p class="hint" style={{ marginTop: 0 }}>
              {t("Exportiert werden die persönlichen Einträge von {account}, ohne Einträge aus Organisationen.", {
                account: acc?.label ?? "",
              })}
            </p>
          )}
          <Field label={t("Dateiformat")}>
            <div class="input-wrap">
              <select value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value)} data-testid="export-format">
                {EXPORT_FORMATS.map(([v, l]) => (
                  <option value={v} key={v}>
                    {t(l)}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          {format === "encrypted_json" && (
            <Field label={t("Art der Verschlüsselung")} group>
              <label class="checkbox">
                <input type="radio" checked={encType === "account"} onChange={() => setEncType("account")} data-testid="enc-account" />
                {t("Kontobeschränkt – nur in dieses Konto wieder importierbar")}
              </label>
              <label class="checkbox">
                <input type="radio" checked={encType === "password"} onChange={() => setEncType("password")} data-testid="enc-password" />
                {t("Passwortgeschützt – mit eigenem Dateipasswort, überall importierbar")}
              </label>
            </Field>
          )}
          {format === "encrypted_json" && encType === "password" && (
            <>
              <Field label={t("Dateipasswort")}>
                <PasswordInput value={filePw} onValue={setFilePw} autocomplete="new-password" name="file-password" />
              </Field>
              <Field label={t("Dateipasswort bestätigen")}>
                <PasswordInput value={filePw2} onValue={setFilePw2} autocomplete="new-password" name="file-password2" />
              </Field>
            </>
          )}
          {(format === "json" || format === "csv" || format === "zip") && (
            <div class="banner warn">
              {t("Diese Datei enthält deine Daten unverschlüsselt. Bewahre sie sicher auf und lösche sie nach der Verwendung.")}
            </div>
          )}
        </div>
        <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
          {!methods ? (
            <Spinner />
          ) : (
            <>
              {(methods.mp ? 1 : 0) + (methods.pin ? 1 : 0) > 1 && (
                <Field label={t("Bestätigen mit")}>
                  <div class="input-wrap">
                    <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as any)}>
                      <option value="mp">{t("Master-Passwort")}</option>
                      <option value="pin">{t("PIN")}</option>
                    </select>
                  </div>
                </Field>
              )}
              {mode === "otp" ? (
                <Field label={t("Bestätigungscode aus der E-Mail")}>
                  <div class="row-gap">
                    <div style={{ flex: 1 }}>
                      <PasswordInput value={secret} onValue={setSecret} autocomplete="one-time-code" name="export-otp" />
                    </div>
                    <button
                      class="btn btn-secondary btn-sm"
                      onClick={async () => {
                        try {
                          await call("exportRequestOtp", { accountKey });
                          setOtpSent(true);
                          toast.show(t("Code wurde per E-Mail gesendet"));
                        } catch (e: any) {
                          setError(e?.message ?? String(e));
                        }
                      }}
                    >
                      {otpSent ? t("Erneut senden") : t("Code senden")}
                    </button>
                  </div>
                </Field>
              ) : (
                <Field label={mode === "pin" ? t("PIN") : t("Master-Passwort")}>
                  <PasswordInput value={secret} onValue={setSecret} onEnter={run} name="export-secret" />
                </Field>
              )}
            </>
          )}
          {error && <div class="banner error">{error}</div>}
        </div>
      </main>
      <div class="footer-bar">
        <button
          class="btn btn-primary"
          onClick={run}
          disabled={busy || !accountKey || !!acc?.policies?.disableExport}
          data-testid="export-run"
        >
          {busy ? <Spinner /> : <Icon name="download" size={15} />}
          {t("Exportieren")}
        </button>
      </div>
    </>
  );
}

function summary(items: ImportItem[]): string {
  const by = new Map<number, number>();
  for (const i of items) by.set(i.type, (by.get(i.type) ?? 0) + 1);
  return [...by]
    .sort((a, b) => a[0] - b[0])
    .map(([type, n]) => `${n} × ${TYPE_LABEL[type] ?? type}`)
    .join(", ");
}

export function ImportView() {
  const app = useApp();
  const toast = useToast();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const [accountKey, setAccountKey] = useState(unlocked[0]?.key ?? "");
  const [format, setFormat] = useState("auto");
  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [fileName, setFileName] = useState("");
  const [filePw, setFilePw] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef("");
  const needsPopout = navigator.userAgent.includes("Firefox") && !app.popout;

  const parse = (text: string, fmt: string) => {
    setError("");
    try {
      setParsed(parseImport(text, fmt));
    } catch (e: any) {
      setParsed(null);
      setError(t(e?.message ?? String(e)));
    }
  };

  async function run() {
    if (!parsed) return;
    setError("");
    setBusy(true);
    try {
      let items = parsed.items;
      if (parsed.encrypted) {
        const r = await call("importDecrypt", { accountKey, doc: parsed.encrypted.doc, password: filePw || undefined });
        items = fromBitwardenDoc(r.doc);
      }
      if (folder.trim())
        items = items.map((i) => ({ ...i, folderName: i.folderName ? `${folder.trim()}/${i.folderName}` : folder.trim() }));
      if (!items.length) throw new Error(t("Die Datei enthält keine Einträge"));
      const r = await call("importItems", { accountKey, items });
      await app.reloadVault();
      toast.show(t("{n} Einträge importiert", { n: r.imported }));
      app.back();
    } catch (e: any) {
      setError(t(e?.message ?? String(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Einträge importieren")}</h1>
      </div>
      <main>
        <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
          <AccountSelect value={accountKey} onChange={setAccountKey} testid="import-account" />
          <Field label={t("Dateiformat")}>
            <div class="input-wrap">
              <select
                value={format}
                data-testid="import-format"
                onChange={(e) => {
                  const f = (e.target as HTMLSelectElement).value;
                  setFormat(f);
                  if (textRef.current) parse(textRef.current, f);
                }}
              >
                {IMPORT_FORMATS.map(([v, l]) => (
                  <option value={v} key={v}>
                    {t(l)}
                  </option>
                ))}
              </select>
            </div>
          </Field>
          <Field label={t("Datei")} group>
            <input
              type="file"
              ref={fileRef}
              hidden
              accept=".json,.csv,.xml,.txt"
              data-testid="import-file"
              onChange={async (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (!f) return;
                setFileName(f.name);
                textRef.current = await f.text();
                parse(textRef.current, format);
              }}
            />
            <button
              class="btn btn-secondary btn-sm"
              onClick={() => {
                if (needsPopout) {
                  chrome.windows.create({ url: chrome.runtime.getURL("popup.html?popout=1"), type: "popup", width: 420, height: 680 });
                  window.close();
                } else fileRef.current?.click();
              }}
            >
              <Icon name="paperclip" size={14} />
              {fileName || (needsPopout ? t("Datei wählen (im eigenen Fenster)") : t("Datei wählen"))}
            </button>
          </Field>
          {parsed && (
            <div class="hint" data-testid="import-summary">
              {parsed.encrypted
                ? parsed.encrypted.passwordProtected
                  ? t("Passwortgeschützter Bitwarden-Export")
                  : t("Kontobeschränkter Bitwarden-Export – nur in das Konto importierbar, aus dem er stammt")
                : t("{n} Einträge erkannt: {list}", { n: parsed.items.length, list: summary(parsed.items) })}
            </div>
          )}
          {parsed?.encrypted?.passwordProtected && (
            <Field label={t("Dateipasswort")}>
              <PasswordInput value={filePw} onValue={setFilePw} name="import-file-password" />
            </Field>
          )}
          <Field label={t("In Ordner importieren (optional)")}>
            <div class="input-wrap">
              <input value={folder} onInput={(e) => setFolder((e.target as HTMLInputElement).value)} placeholder={t("Ordnername")} />
            </div>
          </Field>
          {error && <div class="banner error">{error}</div>}
        </div>
        <p class="hint">
          {t(
            "Unterstützt werden Bitwarden-Exporte (auch verschlüsselte), KeePass 2 (XML) und die CSV-Exporte von Browsern und gängigen Passwortmanagern.",
          )}
        </p>
      </main>
      <div class="footer-bar">
        <button class="btn btn-primary" onClick={run} disabled={busy || !parsed} data-testid="import-run">
          {busy && <Spinner />}
          {t("Importieren")}
        </button>
      </div>
    </>
  );
}
