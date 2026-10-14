// Warning page shown in a tab instead of a known phishing link.
import { useState } from "preact/hooks";
import { Icon, Logo } from "../icons";
import { call } from "../rpc";

import { t } from "../../shared/i18n";

export function PhishingWarning({ url }: { url: string }) {
  const [busy, setBusy] = useState(false);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep */
  }
  return (
    <div class="phishing-page" data-testid="phishing-warning">
      <div class="phishing-card">
        <div class="row-gap" style={{ gap: 8, marginBottom: 14 }}>
          <Logo size={28} />
          <b>MultiWarden</b>
        </div>
        <div class="phishing-icon">
          <Icon name="alert" size={40} />
        </div>
        <h1>{t("Bekannte Phishing-Seite")}</h1>
        <p>
          {t(
            "Die Adresse steht auf der Liste bekannter Phishing-Seiten. Solche Seiten imitieren echte Anmeldungen, um Passwörter zu stehlen.",
          )}
        </p>
        <div class="mono phishing-url" data-testid="phishing-url">
          {url}
        </div>
        <button class="btn btn-primary btn-block" disabled={busy} onClick={() => call("phishingLeave", {})} data-testid="phishing-leave">
          {t("Seite verlassen")}
        </button>
        <button
          class="btn btn-ghost btn-block"
          style={{ marginTop: 8, color: "var(--danger)" }}
          disabled={busy}
          data-testid="phishing-continue"
          onClick={async () => {
            setBusy(true);
            await call("phishingContinue", { url }).catch(() => setBusy(false));
          }}
        >
          {t("Trotzdem zu {host} wechseln", { host })}
        </button>
      </div>
    </div>
  );
}
