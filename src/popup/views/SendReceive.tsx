// Open a Send link inside the extension (instead of the web vault).
import { useState } from "preact/hooks";
import { decryptFileData, deserializeKey } from "../../crypto/bw";
import { t } from "../../shared/i18n";
import { ReceiveAuth, ReceivedSend, SendType } from "../../shared/sends";
import { useApp } from "../app-state";
import { Field, PasswordInput, Spinner, TextInput, useToast } from "../components";
import { Icon } from "../icons";
import { call } from "../rpc";
import { copyToClipboard, formatDate } from "../util";

const LINK_RE = /^https?:\/\/[^#\s]+#\/?(send\/)?[\w-]+\/[\w-]+\/?$/i;
export const isSendLink = (u?: string) => !!u && LINK_RE.test(u.trim()) && (/#\/send\//.test(u) || /^https:\/\/send\.bitwarden/i.test(u));

function formatSize(n?: number) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

type Step = "link" | "password" | "email" | "otp";

export function SendReceiveTool() {
  const app = useApp();
  const toast = useToast();
  const fromPage = isSendLink(app.page.url) ? app.page.url : "";
  const [link, setLink] = useState(fromPage);
  const [step, setStep] = useState<Step>("link");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ send: ReceivedSend; auth: ReceiveAuth } | null>(null);
  const [showText, setShowText] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const reset = () => {
    setResult(null);
    setStep("link");
    setPassword("");
    setEmail("");
    setOtp("");
    setError("");
    setShowText(false);
  };

  const open = async () => {
    setError("");
    if (!isSendLink(link)) {
      setError(t("Das ist kein gültiger Send-Link"));
      return;
    }
    setBusy(true);
    try {
      const r = await call("receiveSend", {
        link: link.trim(),
        password: step === "password" ? password : undefined,
        email: step === "email" || step === "otp" ? email : undefined,
        otp: step === "otp" ? otp : undefined,
      });
      switch (r.status) {
        case "ok":
          setResult({ send: r.send, auth: r.auth });
          setShowText(!r.send.hidden);
          break;
        case "password":
          setStep("password");
          break;
        case "wrongPassword":
          setStep("password");
          setError(t("Das Passwort ist falsch."));
          break;
        case "email":
          setStep("email");
          break;
        case "otp":
          setStep("otp");
          break;
        case "wrongCode":
          setError(t("Der Code ist ungültig oder abgelaufen."));
          break;
        case "unavailable":
          setError(t("Dieses Send existiert nicht oder ist nicht mehr verfügbar."));
          break;
        default:
          setError(r.error);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!result?.send.file) return;
    setDownloading(true);
    try {
      const d = await call("receiveSendFile", {
        link: link.trim(),
        sendId: result.send.id,
        fileId: result.send.file.id,
        auth: result.auth,
      });
      const res = await fetch(d.url, { credentials: "omit", cache: "no-store" });
      if (!res.ok) throw new Error(t("Download fehlgeschlagen (HTTP {status})", { status: res.status }));
      let plain: Uint8Array;
      try {
        plain = await decryptFileData(new Uint8Array(await res.arrayBuffer()), deserializeKey(d.key));
      } catch {
        throw new Error(t("Die Datei konnte nicht entschlüsselt werden"));
      }
      const href = URL.createObjectURL(new Blob([plain.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = result.send.file.fileName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      toast.show(t("„{name}“ heruntergeladen", { name: result.send.file.fileName }));
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    } finally {
      setDownloading(false);
    }
  };

  if (result) {
    const s = result.send;
    return (
      <div data-testid="receive-result">
        <div class="detail-card" style={{ padding: "12px" }}>
          <div class="receive-title">
            <Icon name={s.type === SendType.File ? "file" : "fileText"} size={18} />
            <span data-testid="receive-name">{s.name || t("(ohne Namen)")}</span>
          </div>
          <div class="muted small">
            {[
              s.creatorIdentifier ? t("Gesendet von {who}", { who: s.creatorIdentifier }) : "",
              s.expirationDate ? t("läuft ab am {date}", { date: formatDate(s.expirationDate) }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
          {s.type === SendType.Text && (
            <div class="receive-text">
              {showText ? (
                <pre data-testid="receive-text">{s.text}</pre>
              ) : (
                <div class="muted small">{t("Der Absender hat den Text zunächst ausgeblendet.")}</div>
              )}
              <div class="row-gap">
                <button class="btn btn-secondary btn-sm" onClick={() => setShowText(!showText)} data-testid="receive-toggle">
                  <Icon name={showText ? "eyeOff" : "eye"} size={15} />
                  {showText ? t("Text ausblenden") : t("Text anzeigen")}
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  onClick={async () => {
                    try {
                      await copyToClipboard(s.text ?? "", 0);
                      toast.show(t("Text kopiert"));
                    } catch {
                      toast.show(t("Kopieren fehlgeschlagen"), "error");
                    }
                  }}
                  data-testid="receive-copy"
                >
                  <Icon name="copy" size={15} />
                  {t("Kopieren")}
                </button>
              </div>
            </div>
          )}
          {s.type === SendType.File && s.file && (
            <div class="receive-file">
              <span data-testid="receive-file">
                {s.file.fileName} <span class="muted small">· {s.file.sizeName || formatSize(s.file.size)}</span>
              </span>
              <button class="btn btn-primary btn-sm" onClick={download} disabled={downloading} data-testid="receive-download">
                {downloading ? <Spinner /> : <Icon name="download" size={15} />}
                {t("Herunterladen")}
              </button>
            </div>
          )}
          {s.type === SendType.Item && (
            <div class="muted small">{t("Sends mit Tresor-Einträgen kann MultiWarden noch nicht anzeigen.")}</div>
          )}
        </div>
        <button class="btn btn-ghost btn-sm" onClick={reset} data-testid="receive-again">
          {t("Anderes Send öffnen")}
        </button>
      </div>
    );
  }

  return (
    <form
      data-testid="receive-form"
      onSubmit={(e) => {
        e.preventDefault();
        open();
      }}
    >
      <div class="tool-intro muted small">
        {t("Öffne einen Send-Link direkt hier – der Inhalt wird auf deinem Gerät entschlüsselt. Jedes Öffnen zählt als Zugriff.")}
      </div>
      <Field label={t("Send-Link")} hint={fromPage && link === fromPage ? t("Aus dem aktuellen Tab übernommen") : undefined}>
        <TextInput
          value={link}
          onValue={(v) => {
            setLink(v);
            if (step !== "link") reset();
          }}
          placeholder="https://vault.bitwarden.eu/#/send/…"
          data-testid="receive-link"
        />
      </Field>
      {step === "password" && (
        <Field label={t("Passwort")} hint={t("Dieses Send ist mit einem Passwort geschützt.")}>
          <PasswordInput value={password} onValue={setPassword} autoFocus autocomplete="off" name="receive-password" />
        </Field>
      )}
      {(step === "email" || step === "otp") && (
        <Field
          label={t("E-Mail-Adresse")}
          hint={
            step === "email"
              ? t("Dieses Send ist nur für bestimmte E-Mail-Adressen freigegeben. Du bekommst einen Code per E-Mail.")
              : undefined
          }
        >
          <TextInput value={email} onValue={setEmail} type="email" autoFocus={step === "email"} data-testid="receive-email" />
        </Field>
      )}
      {step === "otp" && (
        <Field label={t("Bestätigungscode")} hint={t("Der Code wurde an {email} gesendet.", { email })}>
          <TextInput value={otp} onValue={setOtp} inputMode="numeric" autoFocus data-testid="receive-otp" />
        </Field>
      )}
      {error && (
        <div class="banner error" data-testid="receive-error">
          {error}
        </div>
      )}
      <button class="btn btn-primary" type="submit" disabled={busy || !link.trim()} data-testid="receive-open">
        {busy && <Spinner />}
        {step === "email" ? t("Code anfordern") : t("Öffnen")}
      </button>
    </form>
  );
}
