import { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { applyAppearance, contrast, DEFAULT_CUSTOM, normalizeHex, schemeOf } from "../../shared/appearance";
import { LANGUAGES, t, tk } from "../../shared/i18n";
import { Settings, UriMatch } from "../../shared/types";
import { normalizeBlockedDomain } from "../../shared/uri";
import { mergeTimeoutPolicies, timeoutAllowed } from "../../shared/policies";
import { useApp } from "../app-state";
import { PasswordInput, Spinner, Switch, useToast } from "../components";
import { Icon, IconName, Logo } from "../icons";
import { call } from "../rpc";
import THIRD_PARTY from "../../shared/third-party.json";
import { ColorPicker } from "../color-picker";
import { MATCH_NAMES } from "../fill-scope";
import { bioCreate, bioSupported, inActionPopup, openBioWindow, takePendingBio } from "../biometric";

export type SettingsSection = "accounts" | "security" | "autofill" | "notifications" | "vault" | "appearance" | "about";

/** Order and labels of the sections (Bitwarden-style layout shows them as sub pages). */
export const SECTIONS: { id: SettingsSection; title: string; icon: IconName; desc: string }[] = [
  { id: "accounts", title: tk("Konten"), icon: "users", desc: tk("Konten verwalten, hinzufügen, synchronisieren") },
  { id: "security", title: tk("Sicherheit"), icon: "shield", desc: tk("Sperren, PIN, Zwischenablage") },
  { id: "autofill", title: tk("Autofill"), icon: "fill", desc: tk("Inline-Menü, Tastenkürzel, URI-Erkennung") },
  { id: "notifications", title: tk("Benachrichtigungen"), icon: "bell", desc: tk("Logins speichern, Passkeys, ausgeschlossene Websites") },
  { id: "vault", title: tk("Tresor"), icon: "vault", desc: tk("Papierkorb und weitere Tresor-Werkzeuge") },
  { id: "appearance", title: tk("Darstellung"), icon: "palette", desc: tk("Sprache, Design, Farben, Layout") },
  { id: "about", title: tk("Über"), icon: "info", desc: tk("Version und Hinweise") },
];

export function Row({
  title,
  desc,
  children,
  onClick,
  testid,
  icon,
}: {
  title: string;
  desc?: ComponentChildren;
  children?: ComponentChildren;
  onClick?: () => void;
  testid?: string;
  icon?: IconName;
}) {
  return (
    <div
      class={"settings-row" + (onClick ? " clickable" : "")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick()) : undefined}
      data-testid={testid}
    >
      {icon && (
        <span class="row-icon">
          <Icon name={icon} size={18} />
        </span>
      )}
      <div class="grow">
        <div>{title}</div>
        {desc && <div class="desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function Group({ title, children, show }: { title: string; children: ComponentChildren; show: boolean }) {
  return (
    <div class="settings-group">
      {show && <h2>{title}</h2>}
      <div class="card">{children}</div>
    </div>
  );
}

function useSettings() {
  const app = useApp();
  const s = app.state.settings;
  const set = async (p: Partial<Settings>) => {
    await call("setSettings", p);
    await app.reload();
  };
  return { app, s, set };
}

export function SettingsView({ section }: { section?: SettingsSection }) {
  const app = useApp();
  const layout = app.state.settings.settingsLayout ?? "single";
  const sub = layout === "sections" && section ? SECTIONS.find((x) => x.id === section) : undefined;

  return (
    <>
      <div class="topbar">
        {sub && (
          <button class="icon-btn back" onClick={() => app.back()} aria-label={t("Zurück")}>
            <Icon name="chevronLeft" size={20} />
          </button>
        )}
        <h1>{sub ? t(sub.title) : t("Einstellungen")}</h1>
      </div>
      <main data-testid="settings">
        {layout === "sections" && !sub ? (
          <div class="card settings-index" data-testid="settings-index">
            {SECTIONS.map((x) => (
              <Row
                key={x.id}
                icon={x.icon}
                title={t(x.title)}
                desc={t(x.desc)}
                onClick={() => app.go({ name: "settings", section: x.id })}
                testid={"section-" + x.id}
              >
                <Icon name="chevronRight" size={18} />
              </Row>
            ))}
          </div>
        ) : sub ? (
          <SectionBody id={sub.id} showTitles={false} />
        ) : (
          SECTIONS.map((x) => <SectionBody key={x.id} id={x.id} showTitles />)
        )}
      </main>
    </>
  );
}

function SectionBody({ id, showTitles }: { id: SettingsSection; showTitles: boolean }) {
  const title = t(SECTIONS.find((x) => x.id === id)!.title);
  switch (id) {
    case "accounts":
      return <AccountsSection title={title} show={showTitles} />;
    case "security":
      return <SecuritySection title={title} show={showTitles} />;
    case "autofill":
      return <AutofillSection title={title} show={showTitles} />;
    case "notifications":
      return <NotificationsSection title={title} show={showTitles} />;
    case "vault":
      return <VaultSection title={title} show={showTitles} />;
    case "appearance":
      return <AppearanceSection title={title} show={showTitles} />;
    case "about":
      return <AboutSection title={title} show={showTitles} />;
  }
}

type SectionProps = { title: string; show: boolean };

// ---------------------------------------------------------------------------------------------

function AccountsSection({ title, show }: SectionProps) {
  const app = useApp();
  const toast = useToast();
  return (
    <Group title={title} show={show}>
      <Row
        title={t("Konten verwalten")}
        desc={app.accounts.length === 1 ? t("1 Konto verbunden") : t("{n} Konten verbunden", { n: app.accounts.length })}
        onClick={() => app.go({ name: "accounts" })}
        testid="manage-accounts"
      >
        <Icon name="chevronRight" size={18} />
      </Row>
      <Row title={t("Konto hinzufügen")} onClick={() => app.go({ name: "addAccount" })}>
        <Icon name="plus" size={18} />
      </Row>
      <Row
        title={t("Alle synchronisieren")}
        onClick={async () => {
          toast.show(t("Synchronisiere …"));
          const r = await call("sync", {});
          toast.show(r.ok ? t("Synchronisiert") : t("Teilweise fehlgeschlagen"), r.ok ? "ok" : "error");
        }}
      >
        <Icon name="refresh" size={18} />
      </Row>
    </Group>
  );
}

function SecuritySection({ title, show }: SectionProps) {
  const { app, s, set } = useSettings();
  const toast = useToast();
  const [pinSetup, setPinSetup] = useState(false);
  const anyUnlocked = app.accounts.some((a) => a.status === "unlocked");
  const noMp = app.accounts.filter((a) => !a.hasMasterPassword);
  const pinBlocked = app.accounts.filter((a) => a.policies?.removePin);
  const pinAllBlocked = app.accounts.length > 0 && pinBlocked.length === app.accounts.length;
  return (
    <Group title={title} show={show}>
      <VaultTimeoutRows />
      <Row
        title={t("Master-Passwort ändern")}
        desc={t("Für ein Konto mit Master-Passwort")}
        onClick={() => app.go({ name: "changePassword" })}
        testid="open-change-password"
      >
        <Icon name="key" size={18} />
      </Row>
      <Row
        title={t("Anmeldeanfragen anderer Geräte bestätigen")}
        desc={t("Wenn du dich woanders „mit Gerät“ anmeldest, fragt MultiWarden hier nach der Freigabe")}
      >
        <Switch
          checked={s.approveLoginRequests}
          onChange={(v) => set({ approveLoginRequests: v })}
          label={t("Anmeldeanfragen bestätigen")}
          testid="approve-login-requests"
        />
      </Row>
      <Row title={t("Offene Anmeldeanfragen")} onClick={() => app.go({ name: "authRequests" })} testid="open-auth-requests">
        <Icon name="shield" size={18} />
      </Row>
      <Row
        title={t("Geräte")}
        desc={t("Wo deine Konten angemeldet sind")}
        onClick={() => app.go({ name: "devices" })}
        testid="open-devices"
      >
        <Icon name="server" size={18} />
      </Row>
      <Row
        title={t("Mit PIN entsperren")}
        desc={
          pinBlocked.length
            ? t("Durch eine Richtlinie deaktiviert für: {accounts}", { accounts: pinBlocked.map((a) => a.label).join(", ") })
            : s.pinEnabled
              ? t("Alle Konten lassen sich mit derselben PIN entsperren")
              : noMp.length
                ? t("Empfohlen für Konten ohne Master-Passwort (SSO)")
                : t("Statt des Master-Passworts eine PIN verwenden")
        }
        testid="pin-row"
      >
        <Switch
          disabled={pinAllBlocked && !s.pinEnabled}
          checked={s.pinEnabled || pinSetup}
          onChange={async (v) => {
            if (v) {
              if (!anyUnlocked) return toast.show(t("Bitte zuerst entsperren"), "error");
              setPinSetup(true);
            } else if (pinSetup) setPinSetup(false);
            else {
              await call("disablePin", {});
              await app.reload();
              toast.show(t("PIN-Entsperrung deaktiviert"));
            }
          }}
          label={t("Mit PIN entsperren")}
        />
      </Row>
      {pinSetup && !s.pinEnabled && (
        <PinSetup
          onDone={async (ok) => {
            setPinSetup(false);
            if (ok) {
              await app.reload();
              toast.show(t("PIN eingerichtet"));
            }
          }}
        />
      )}
      {s.pinEnabled && (
        <Row
          title={t("Nach Browser-Neustart Master-Passwort verlangen")}
          desc={t(
            "Die PIN gilt dann nur, solange der Browser läuft. Konten ohne Master-Passwort werden nach einem Neustart per SSO entsperrt.",
          )}
        >
          <Switch
            checked={s.pinLockAfterRestart}
            onChange={(v) => set({ pinLockAfterRestart: v })}
            label={t("Nach Neustart Master-Passwort verlangen")}
          />
        </Row>
      )}
      <BiometricRow />
      <Row title={t("Bei Systemsperre sperren")}>
        <Switch checked={s.lockOnSystemLock} onChange={(v) => set({ lockOnSystemLock: v })} label={t("Bei Systemsperre sperren")} />
      </Row>
      <Row title={t("Zwischenablage leeren")}>
        <select
          value={String(s.clearClipboardSeconds)}
          onChange={(e) => set({ clearClipboardSeconds: Number((e.target as HTMLSelectElement).value) })}
        >
          <option value="0">{t("Nie")}</option>
          <option value="10">{t("10 Sekunden")}</option>
          <option value="20">{t("20 Sekunden")}</option>
          <option value="30">{t("30 Sekunden")}</option>
          <option value="60">{t("1 Minute")}</option>
          <option value="120">{t("2 Minuten")}</option>
          <option value="300">{t("5 Minuten")}</option>
        </select>
      </Row>
      <Row
        title={t("Vor Phishing-Seiten warnen")}
        desc={t("Prüft aufgerufene Adressen auf diesem Gerät gegen die Phishing-Liste von Bitwarden (wird regelmäßig geladen)")}
      >
        <Switch
          checked={!!s.phishingWarning}
          onChange={(v) => set({ phishingWarning: v })}
          label={t("Vor Phishing-Seiten warnen")}
          testid="phishing-switch"
        />
      </Row>
      <Row title={t("Jetzt alle sperren")} onClick={() => call("lock", {})}>
        <Icon name="lock" size={18} />
      </Row>
    </Group>
  );
}

function BiometricRow() {
  const { app, s } = useSettings();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const anyUnlocked = app.accounts.some((a) => a.status === "unlocked");
  const enable = async () => {
    if (!anyUnlocked) return toast.show(t("Bitte zuerst entsperren"), "error");
    if (inActionPopup()) return openBioWindow("enable");
    setBusy(true);
    try {
      const c = await bioCreate();
      await call("biometricEnable", c);
      await app.reload();
      toast.show(t("Biometrische Entsperrung eingerichtet"));
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!s.biometric && takePendingBio("enable")) enable();
  }, []);
  if (!bioSupported()) return null;
  return (
    <Row
      title={t("Mit Biometrie entsperren")}
      desc={t("Windows Hello, Touch ID oder Sicherheitsschlüssel statt Master-Passwort")}
      testid="bio-row"
    >
      {busy && <Spinner />}
      <Switch
        checked={!!s.biometric}
        onChange={async (v) => {
          if (v) return enable();
          await call("biometricDisable", {});
          await app.reload();
          toast.show(t("Biometrische Entsperrung deaktiviert"));
        }}
        label={t("Mit Biometrie entsperren")}
        testid="bio-switch"
      />
    </Row>
  );
}

const TIMEOUTS: [string, string][] = [
  ["0", tk("Sofort (beim Schließen des Popups)")],
  ["1", tk("1 Minute")],
  ["5", tk("5 Minuten")],
  ["15", tk("15 Minuten")],
  ["30", tk("30 Minuten")],
  ["60", tk("1 Stunde")],
  ["240", tk("4 Stunden")],
  ["restart", tk("Beim Browser-Neustart")],
  ["never", tk("Nie")],
  ["custom", tk("Benutzerdefiniert")],
];

function VaultTimeoutRows() {
  const { app, s, set } = useSettings();
  // maximum session timeout policies of the organizations (the strictest one applies to all accounts)
  const policy = mergeTimeoutPolicies(app.accounts.map((a) => a.policies?.maxTimeout));
  const actionPolicies = app.accounts.filter((a) => a.policies?.maxTimeout?.action);
  const allowed = (v: string) =>
    v === "custom"
      ? !policy || policy.type == null || policy.type === "custom"
      : timeoutAllowed(v === "restart" || v === "never" ? v : Number(v), policy);
  const preset = TIMEOUTS.some(([v]) => v === String(s.vaultTimeout));
  const [custom, setCustom] = useState(!preset);
  const value = custom ? "custom" : String(s.vaultTimeout);
  const minutes = typeof s.vaultTimeout === "number" ? s.vaultTimeout : 60;
  return (
    <>
      <Row title={t("Tresor-Timeout")} desc={t("Nach dieser Zeit ohne Aktivität in MultiWarden")}>
        <select
          value={value}
          data-testid="vault-timeout"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === "custom") {
              setCustom(true);
              return;
            }
            setCustom(false);
            set({ vaultTimeout: v === "restart" || v === "never" ? v : Number(v) });
          }}
        >
          {TIMEOUTS.map(([v, l]) => (
            <option value={v} key={v} disabled={!allowed(v)}>
              {t(l)}
            </option>
          ))}
        </select>
      </Row>
      {policy && (
        <div class="settings-sub">
          <div class="hint" data-testid="timeout-policy">
            <Icon name="building" size={13} />{" "}
            {policy.type === "immediately"
              ? t("Richtlinie von {org}: sofort sperren", { org: policy.orgName })
              : policy.type === "onAppRestart" || policy.type === "onSystemLock"
                ? t("Richtlinie von {org}: spätestens beim Browser-Neustart", { org: policy.orgName })
                : policy.type === "never"
                  ? t("Richtlinie von {org}: keine Einschränkung", { org: policy.orgName })
                  : t("Richtlinie von {org}: höchstens {n} Minuten", { org: policy.orgName, n: policy.minutes })}
          </div>
        </div>
      )}
      {custom && (
        <Row title={t("Minuten")}>
          <input
            type="number"
            min={1}
            max={policy?.minutes || 10080}
            value={minutes}
            style={{ width: 80 }}
            data-testid="vault-timeout-custom"
            onChange={(e) => {
              const n = Math.max(1, Math.min(10080, Number((e.target as HTMLInputElement).value) || 1));
              set({ vaultTimeout: n });
            }}
          />
        </Row>
      )}
      {s.vaultTimeout === "never" && (
        <div class="settings-sub">
          <div class="banner warn" style={{ margin: 0 }}>
            {t(
              "Die Schlüssel bleiben dann auch nach einem Neustart auf diesem Gerät gespeichert. Jeder mit Zugriff auf den Browser kann den Tresor öffnen.",
            )}
          </div>
        </div>
      )}
      <Row title={t("Aktion nach dem Timeout")}>
        <select
          value={s.vaultTimeoutAction ?? "lock"}
          data-testid="vault-timeout-action"
          onChange={(e) => set({ vaultTimeoutAction: (e.target as HTMLSelectElement).value as "lock" | "logout" })}
        >
          <option value="lock">{t("Sperren")}</option>
          <option value="logout">{t("Abmelden")}</option>
        </select>
      </Row>
      {actionPolicies.length > 0 && (
        <div class="settings-sub">
          <div class="hint">
            {actionPolicies
              .map((a) =>
                t("{account}: {action} (Richtlinie)", {
                  account: a.label,
                  action: a.policies!.maxTimeout!.action === "logOut" ? t("Abmelden") : t("Sperren"),
                }),
              )
              .join(" · ")}
          </div>
        </div>
      )}
    </>
  );
}

function AutofillSection({ title, show }: SectionProps) {
  const { app, s, set } = useSettings();
  const uriPolicy = app.accounts.filter((a) => a.policies?.uriMatch != null);
  const [showBlocked, setShowBlocked] = useState(false);
  const isFirefox = navigator.userAgent.includes("Firefox");
  const menuMode = !s.inlineMenu ? "off" : s.inlineMenuOnIcon ? "icon" : "focus";
  return (
    <Group title={title} show={show}>
      <Row
        title={t("Inline-Menü in Eingabefeldern")}
        desc={t("Passende Logins, Karten und Identitäten aller Konten direkt am Feld anzeigen")}
      >
        <select
          value={menuMode}
          data-testid="inline-menu-mode"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            set({ inlineMenu: v !== "off", inlineMenuOnIcon: v === "icon" });
          }}
        >
          <option value="focus">{t("Beim Anklicken des Feldes")}</option>
          <option value="icon">{t("Nur über das Symbol im Feld")}</option>
          <option value="off">{t("Aus")}</option>
        </select>
      </Row>
      {s.inlineMenu && (
        <>
          <Row title={t("Karten im Inline-Menü anzeigen")}>
            <Switch checked={s.inlineMenuCards} onChange={(v) => set({ inlineMenuCards: v })} label={t("Karten im Inline-Menü")} />
          </Row>
          <Row title={t("Identitäten im Inline-Menü anzeigen")}>
            <Switch
              checked={s.inlineMenuIdentities}
              onChange={(v) => set({ inlineMenuIdentities: v })}
              label={t("Identitäten im Inline-Menü")}
            />
          </Row>
        </>
      )}
      <Row title={t("Karten als Autofill-Vorschläge anzeigen")} desc={t("Im Tresor-Tab unter „Autofill-Vorschläge“")}>
        <Switch checked={s.suggestCards} onChange={(v) => set({ suggestCards: v })} label={t("Karten als Vorschläge")} />
      </Row>
      <Row title={t("Identitäten als Autofill-Vorschläge anzeigen")}>
        <Switch checked={s.suggestIdentities} onChange={(v) => set({ suggestIdentities: v })} label={t("Identitäten als Vorschläge")} />
      </Row>
      <Row
        title={t("Beim Laden der Seite ausfüllen")}
        desc={t(
          "Füllt Anmeldeformulare automatisch mit dem zuletzt verwendeten passenden Login aus. Kompromittierte oder nicht vertrauenswürdige Websites können das ausnutzen.",
        )}
      >
        <Switch
          checked={s.autofillOnPageLoad}
          onChange={(v) => set({ autofillOnPageLoad: v })}
          label={t("Beim Laden der Seite ausfüllen")}
          testid="autofill-on-load-global"
        />
      </Row>
      {s.autofillOnPageLoad && (
        <Row title={t("Standard für Logins")} desc={t("Kann in jedem Login einzeln geändert werden")}>
          <select
            value={s.autofillOnPageLoadDefault ? "1" : "0"}
            onChange={(e) => set({ autofillOnPageLoadDefault: (e.target as HTMLSelectElement).value === "1" })}
          >
            <option value="1">{t("Beim Laden ausfüllen")}</option>
            <option value="0">{t("Nicht beim Laden ausfüllen")}</option>
          </select>
        </Row>
      )}
      <Row title={t("TOTP nach dem Ausfüllen kopieren")}>
        <Switch checked={s.autoCopyTotp} onChange={(v) => set({ autoCopyTotp: v })} label={t("TOTP kopieren")} />
      </Row>
      <Row
        title={t("Standard-URI-Erkennung")}
        desc={
          <>
            {t(
              "Wo Logins ausgefüllt werden, wenn der Eintrag nichts anderes festlegt. Basisdomain: auch auf anderen Subdomains (shop.example.com ↔ mail.example.com). Host: nur auf genau der gespeicherten Subdomain.",
            )}
            {uriPolicy.length > 0 && (
              <div>{t("Durch Richtlinie vorgegeben für: {accounts}", { accounts: uriPolicy.map((a) => a.label).join(", ") })}</div>
            )}
          </>
        }
      >
        <select
          value={String(s.defaultUriMatch)}
          onChange={(e) => set({ defaultUriMatch: Number((e.target as HTMLSelectElement).value) as UriMatch })}
          data-testid="default-uri-match"
        >
          {[UriMatch.Domain, UriMatch.Host, UriMatch.StartsWith, UriMatch.Exact, UriMatch.RegularExpression, UriMatch.Never].map((m) => (
            <option value={String(m)} key={m}>
              {t(MATCH_NAMES[m])}
            </option>
          ))}
        </select>
      </Row>
      <Row title={t("Kontextmenü anzeigen")} desc={t("Ausfüllen, Kopieren und Passwort-Generator per Rechtsklick")}>
        <Switch checked={s.contextMenu} onChange={(v) => set({ contextMenu: v })} label={t("Kontextmenü")} />
      </Row>
      {chrome.webRequest !== undefined && (
        <Row
          title={t("HTTP-Anmeldedialoge beantworten")}
          desc={t("Basic-/Digest-Anmeldung einer Website automatisch ausfüllen, wenn genau ein Login zum Host passt")}
        >
          <Switch checked={s.basicAuth} onChange={(v) => set({ basicAuth: v })} label={t("HTTP-Anmeldung")} />
        </Row>
      )}
      <BrowserPasswordManager />
      <Row
        title={t("Blockierte Domains")}
        desc={t("Kein Inline-Menü, kein automatisches Ausfüllen, keine Speichern-Abfrage und keine Passkeys auf diesen Websites")}
        onClick={() => setShowBlocked(!showBlocked)}
        testid="blocked-domains"
      >
        <Icon name={showBlocked ? "chevronDown" : "chevronRight"} size={18} />
      </Row>
      {showBlocked && <BlockedDomains />}
      <Row title={t("data-bwignore beachten")} desc={t("Felder, die eine Website mit diesem Attribut markiert, nicht ausfüllen")}>
        <Switch checked={s.honorBwIgnore} onChange={(v) => set({ honorBwIgnore: v })} label="data-bwignore" />
      </Row>
      <Row title={t("data-bwautofill beachten")} desc={t("Eigene Felder auch in so markierte Elemente einer Website eintragen")}>
        <Switch checked={s.honorBwAutofill} onChange={(v) => set({ honorBwAutofill: v })} label="data-bwautofill" />
      </Row>
      <Row
        title={t("Tastenkürzel")}
        desc={t(
          "Strg+Umschalt+L füllt den passenden Login aus (mehrfach drücken wechselt zwischen Treffern aller Konten), Strg+Umschalt+9 generiert ein Passwort. Karten und Identitäten lassen sich ebenfalls per Kürzel ausfüllen.",
        )}
        onClick={() => chrome.tabs.create({ url: isFirefox ? "about:addons" : "chrome://extensions/shortcuts" })}
      >
        <Icon name="external" size={16} />
      </Row>
    </Group>
  );
}

const PRIVACY_KEYS = ["passwordSavingEnabled", "autofillAddressEnabled", "autofillCreditCardEnabled"];

/** Turn off the browser's own password manager (optional "privacy" permission). */
function BrowserPasswordManager() {
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  const check = async () => {
    try {
      const has = await chrome.permissions.contains({ permissions: ["privacy"] });
      const svc = (chrome as any).privacy?.services;
      if (!has || !svc) return setOn(false);
      const d = await svc.passwordSavingEnabled.get({});
      setOn(d.value === false && d.levelOfControl === "controlled_by_this_extension");
    } catch {
      setOn(false);
    }
  };
  useEffect(() => {
    check();
  }, []);
  if (on === null || !chrome.permissions) return null;
  const toggle = async (v: boolean) => {
    try {
      if (v && !(await chrome.permissions.request({ permissions: ["privacy"] }))) return;
      const svc = (chrome as any).privacy?.services;
      if (!svc) {
        toast.show(t("Bitte das Popup erneut öffnen und noch einmal versuchen"), "error");
        return;
      }
      for (const k of PRIVACY_KEYS) {
        if (!svc[k]) continue;
        try {
          if (v) await svc[k].set({ value: false });
          else await svc[k].clear({});
        } catch {
          /* not supported by this browser */
        }
      }
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    }
    await check();
  };
  return (
    <Row
      title={t("MultiWarden als Standard-Passwortmanager")}
      desc={t("Passwort-Speicherung und Autofill des Browsers abschalten, damit sich die Vorschläge nicht überlagern")}
    >
      <Switch checked={on} onChange={toggle} label={t("Standard-Passwortmanager")} />
    </Row>
  );
}

function BlockedDomains() {
  const { s, set } = useSettings();
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const list = s.blockedDomains ?? [];
  const add = () => {
    const d = normalizeBlockedDomain(value);
    if (!d) {
      setErr(t("Ungültige Domain"));
      return;
    }
    setErr("");
    setValue("");
    if (!list.includes(d)) set({ blockedDomains: [...list, d].sort() });
  };
  return (
    <div class="settings-sub" data-testid="blocked-list">
      {list.length === 0 && (
        <p class="hint" style={{ margin: "0 0 8px" }}>
          {t("Noch keine. Subdomains einer eingetragenen Domain sind ebenfalls blockiert.")}
        </p>
      )}
      {list.map((d) => (
        <div class="never-row" key={d}>
          <Icon name="globe" size={14} />
          <span class="grow">{d}</span>
          <button
            class="icon-btn sm"
            title={t("Entfernen")}
            aria-label={t("{site} entfernen", { site: d })}
            onClick={() => set({ blockedDomains: list.filter((x) => x !== d) })}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <form
        class="row-inline"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          class="input"
          placeholder="beispiel.de"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          data-testid="blocked-input"
        />
        <button class="btn btn-secondary btn-sm" type="submit" data-testid="blocked-add">
          {t("Hinzufügen")}
        </button>
      </form>
      {err && <div class="field-error">{err}</div>}
    </div>
  );
}

function NotificationsSection({ title, show }: SectionProps) {
  const { s, set } = useSettings();
  const toast = useToast();
  const [showNever, setShowNever] = useState(false);
  return (
    <Group title={title} show={show}>
      <Row
        title={t("Passkeys verwenden")}
        desc={t("Anmeldungen mit Passkeys auf Websites über MultiWarden abwickeln und neue Passkeys im Tresor speichern")}
      >
        <Switch checked={s.passkeys} onChange={(v) => set({ passkeys: v })} label={t("Passkeys verwenden")} />
      </Row>
      <Row
        title={t("Speichern neuer Logins anbieten")}
        desc={t("Nach der Anmeldung auf einer Website fragen, ob die Zugangsdaten gespeichert werden sollen")}
      >
        <Switch checked={s.promptSave} onChange={(v) => set({ promptSave: v })} label={t("Speichern anbieten")} />
      </Row>
      <Row
        title={t("Aktualisieren geänderter Passwörter anbieten")}
        desc={t("Wenn du dich mit einem neuen Passwort für einen gespeicherten Login anmeldest")}
      >
        <Switch checked={s.promptUpdate} onChange={(v) => set({ promptUpdate: v })} label={t("Aktualisieren anbieten")} />
      </Row>
      <Row
        title={t("Anmelde-Ergebnis merken (für den Duplikat-Check)")}
        desc={t("Merkt sich auf diesem Gerät, ob die Anmeldung mit einem gespeicherten Login geklappt hat – ohne Passwörter")}
      >
        <Switch
          checked={s.trackLoginOutcome}
          onChange={(v) => set({ trackLoginOutcome: v })}
          label={t("Anmelde-Ergebnis merken (für den Duplikat-Check)")}
        />
      </Row>
      <Row
        title={t("Bei unklaren Einträgen nachfragen")}
        desc={t("Nur wenn es für die Website mehrere Logins mit unterschiedlichen Passwörtern gibt")}
      >
        <Switch
          checked={s.askLoginOutcome}
          onChange={(v) => set({ askLoginOutcome: v })}
          disabled={!s.trackLoginOutcome}
          label={t("Bei unklaren Einträgen nachfragen")}
        />
      </Row>
      <Row title={t("Gespeicherte Anmelde-Ergebnisse löschen")}>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          data-testid="clear-login-outcomes"
          onClick={async () => {
            try {
              await call("clearLoginOutcomes", {});
              toast.show(t("Gelöscht"));
            } catch (e: any) {
              toast.show(e?.message ?? String(e), "error");
            }
          }}
        >
          {t("Löschen")}
        </button>
      </Row>
      <Row
        title={t("Ausgeschlossene Websites")}
        desc={t("Hier wird nie nach dem Speichern gefragt")}
        onClick={() => setShowNever(!showNever)}
        testid="never-domains"
      >
        <Icon name={showNever ? "chevronDown" : "chevronRight"} size={18} />
      </Row>
      {showNever && <NeverDomains />}
    </Group>
  );
}

function VaultSection({ title, show }: SectionProps) {
  const app = useApp();
  return (
    <Group title={title} show={show}>
      <Row
        title={t("Ordner")}
        desc={t("Ordner aller Konten anlegen, umbenennen und löschen")}
        onClick={() => app.go({ name: "folders" })}
        testid="open-folders"
      >
        <Icon name="folder" size={18} />
      </Row>
      <Row title={t("Einträge importieren")} onClick={() => app.go({ name: "import" })} testid="open-import">
        <Icon name="upload" size={18} />
      </Row>
      <Row title={t("Tresor exportieren")} onClick={() => app.go({ name: "export" })} testid="open-export">
        <Icon name="download" size={18} />
      </Row>
      <Row title={t("Archiv")} onClick={() => app.go({ name: "archive" })} testid="open-archive">
        <Icon name="archive" size={18} />
      </Row>
      <Row title={t("Papierkorb")} onClick={() => app.go({ name: "trash" })}>
        <Icon name="trash" size={18} />
      </Row>
    </Group>
  );
}

// ---------------------------------------------------------------------------------------------
// appearance

const SCHEMES: { id: Settings["colorScheme"]; label: string; swatch: string[] }[] = [
  { id: "multiwarden", label: tk("MultiWarden"), swatch: ["#f1f4f8", "#175ddc", "#0e1622"] },
  { id: "mint", label: tk("Mint"), swatch: ["#eef7f3", "#0e8063", "#0c1714"] },
  { id: "tuvia", label: tk("Tuvia"), swatch: ["#fbf1f6", "#ff4d9a", "#190e14"] },
  { id: "red", label: tk("Rot"), swatch: ["#f8f2f2", "#c4202f", "#1a1012"] },
  { id: "gray", label: tk("Grau"), swatch: ["#f2f2f2", "#3f3f46", "#161616"] },
  { id: "custom", label: tk("Eigene Farben"), swatch: [] },
];

const CUSTOM_FIELDS: { key: keyof typeof DEFAULT_CUSTOM; label: string }[] = [
  { key: "background", label: tk("Hintergrund") },
  { key: "container", label: tk("Container (Karten, Listen)") },
  { key: "accent", label: tk("Akzent (Knöpfe, Hervorhebungen)") },
  { key: "text", label: tk("Text") },
  { key: "textMuted", label: tk("Text gedämpft") },
  { key: "border", label: tk("Rahmen") },
  { key: "danger", label: tk("Warnfarbe") },
];

function AppearanceSection({ title, show }: SectionProps) {
  const { s, set } = useSettings();
  const scheme = schemeOf(s);
  return (
    <Group title={title} show={show}>
      <Row title={t("Sprache")} testid="language-row">
        <select
          value={s.language ?? "system"}
          onChange={(e) => set({ language: (e.target as HTMLSelectElement).value as Settings["language"] })}
          data-testid="language"
        >
          <option value="system">{t("Systemsprache")}</option>
          {LANGUAGES.map((l) => (
            <option value={l.id} key={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Row>
      <div class="settings-sub" data-testid="color-schemes">
        <div class="lbl-row">{t("Farbschema")}</div>
        <div class="scheme-grid">
          {SCHEMES.map((x) => (
            <button
              type="button"
              key={x.id}
              class={"scheme" + (scheme === x.id ? " on" : "")}
              onClick={() => set({ colorScheme: x.id })}
              aria-pressed={scheme === x.id}
              data-testid={"scheme-" + x.id}
            >
              <span class="sw">
                {(x.id === "custom"
                  ? [
                      s.customColors?.background ?? DEFAULT_CUSTOM.background,
                      s.customColors?.accent ?? DEFAULT_CUSTOM.accent,
                      s.customColors?.text ?? DEFAULT_CUSTOM.text,
                    ]
                  : x.swatch
                ).map((c, i) => (
                  <i key={i} style={{ background: c }} />
                ))}
              </span>
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      {scheme !== "custom" ? (
        <Row title={t("Hell / Dunkel")}>
          <select
            value={s.theme}
            onChange={(e) => set({ theme: (e.target as HTMLSelectElement).value as Settings["theme"] })}
            data-testid="theme-mode"
          >
            <option value="system">{t("Wie System")}</option>
            <option value="light">{t("Hell")}</option>
            <option value="dark">{t("Dunkel")}</option>
          </select>
        </Row>
      ) : (
        <CustomColors />
      )}
      <Row title={t("Kompaktmodus")} desc={t("Weniger Abstand in Listen und Einstellungen")}>
        <Switch checked={!!s.compactMode} onChange={(v) => set({ compactMode: v })} label={t("Kompaktmodus")} />
      </Row>
      <Row title={t("Breite des Popups")}>
        <select
          value={s.popupWidth ?? "default"}
          onChange={(e) => set({ popupWidth: (e.target as HTMLSelectElement).value as Settings["popupWidth"] })}
        >
          <option value="default">{t("Standard")}</option>
          <option value="wide">{t("Breit")}</option>
          <option value="extraWide">{t("Extra breit")}</option>
        </select>
      </Row>
      <Row title={t("Animationen")}>
        <Switch checked={s.animations !== false} onChange={(v) => set({ animations: v })} label={t("Animationen")} />
      </Row>
      <Row title={t("Schnellkopieren in der Liste")} desc={t("Knöpfe zum Kopieren von Benutzername und Passwort direkt im Tresor")}>
        <Switch checked={!!s.quickCopy} onChange={(v) => set({ quickCopy: v })} label={t("Schnellkopieren")} />
      </Row>
      <Row title={t("Anzahl passender Logins am Symbol")}>
        <Switch checked={s.badgeCounter !== false} onChange={(v) => set({ badgeCounter: v })} label={t("Zähler am Symbol")} />
      </Row>
      <Row title={t("Website-Symbole anzeigen")} desc={t("Werden über den Icon-Dienst des jeweiligen Servers geladen")}>
        <Switch checked={s.showFavicons} onChange={(v) => set({ showFavicons: v })} label={t("Website-Symbole")} />
      </Row>
      <Row title={t("Aufbau der Einstellungen")} desc={t("Alles auf einer Seite oder wie bei Bitwarden mit Unterseiten je Bereich")}>
        <select
          value={s.settingsLayout ?? "single"}
          onChange={(e) => set({ settingsLayout: (e.target as HTMLSelectElement).value as Settings["settingsLayout"] })}
          data-testid="settings-layout"
        >
          <option value="single">{t("Eine Seite")}</option>
          <option value="sections">{t("Unterseiten (Bitwarden)")}</option>
        </select>
      </Row>
    </Group>
  );
}

/** Hex code typed directly (#rgb or #rrggbb); applied live, saved on Enter / leaving the field. */
function HexInput({
  value,
  label,
  testid,
  onPreview,
  onCommit,
}: {
  value: string;
  label: string;
  testid: string;
  onPreview: (v: string) => void;
  onCommit: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!editing) setText(value);
  }, [value, editing]);
  const valid = normalizeHex(text);
  const commit = () => {
    setEditing(false);
    // the live preview already changed `value`, so save whenever a valid colour was typed
    if (valid && dirty) onCommit(valid);
    else if (!valid) setText(value);
    setDirty(false);
  };
  return (
    <input
      class={"hex-input" + (valid ? "" : " invalid")}
      value={text}
      maxLength={7}
      spellcheck={false}
      aria-label={t("{label} als Hex-Code", { label })}
      data-testid={testid}
      onFocus={() => setEditing(true)}
      onInput={(e) => {
        let v = (e.target as HTMLInputElement).value.trim();
        if (v && !v.startsWith("#")) v = "#" + v;
        setText(v);
        setDirty(true);
        const n = normalizeHex(v);
        if (n && v.length === 7) onPreview(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onBlur={commit}
    />
  );
}

function CustomColors() {
  const { s, set } = useSettings();
  const colors = { ...DEFAULT_CUSTOM, ...(s.customColors ?? {}) };
  const live = useRef({ ...colors });
  const [, force] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    live.current = { ...colors };
  }, [JSON.stringify(s.customColors)]);
  const preview = (k: string, v: string) => {
    live.current = { ...live.current, [k]: v };
    applyAppearance({ ...s, colorScheme: "custom", customColors: live.current });
    force((x) => x + 1);
  };
  const save = (k: string, v: string) => set({ customColors: { ...live.current, [k]: v } });
  const low = contrast(live.current.text, live.current.container) < 4.5 || contrast(live.current.text, live.current.background) < 4.5;
  return (
    <div class="settings-sub custom-colors" data-testid="custom-colors">
      {CUSTOM_FIELDS.map((f) => {
        const value = (live.current as any)[f.key] as string;
        const isOpen = open === f.key;
        return (
          <div class="color-field" key={f.key}>
            <div class="color-row">
              <span class="grow">{t(f.label)}</span>
              <HexInput
                value={value}
                label={t(f.label)}
                testid={"hex-" + f.key}
                onPreview={(v) => preview(f.key, v)}
                onCommit={(v) => save(f.key, v)}
              />
              <button
                type="button"
                class={"swatch-btn" + (isOpen ? " on" : "")}
                style={{ background: value }}
                title={t("{label}: Farbe wählen", { label: t(f.label) })}
                aria-label={t("{label}: Farbe wählen", { label: t(f.label) })}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : f.key)}
                data-testid={"color-" + f.key}
              />
            </div>
            {isOpen && (
              <ColorPicker
                value={value}
                label={t(f.label)}
                onPreview={(v) => preview(f.key, v)}
                onCommit={(v) => {
                  preview(f.key, v);
                  save(f.key, v);
                }}
                onClose={() => setOpen(null)}
              />
            )}
          </div>
        );
      })}
      {low && (
        <div class="banner warn">{t("Der Kontrast zwischen Text und Hintergrund ist gering – Texte sind eventuell schwer lesbar.")}</div>
      )}
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => set({ customColors: {} })}>
        <Icon name="refresh" size={14} />
        {t("Auf Standardfarben zurücksetzen")}
      </button>
    </div>
  );
}

function AboutSection({ title, show }: SectionProps) {
  const app = useApp();
  const ext = (path: string) => (typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path);
  return (
    <>
      <Group title={title} show={show}>
        <div class="settings-row">
          <Logo size={30} />
          <div class="grow">
            <div style={{ fontWeight: 700 }}>MultiWarden {app.state.version}</div>
            <div class="desc">
              {t("Inoffizieller Client für Bitwarden-kompatible Server (Bitwarden, Vaultwarden). Nicht mit Bitwarden Inc. verbunden.")}
            </div>
          </div>
        </div>
        <a
          class="settings-row clickable link-row"
          href={ext("THIRD-PARTY-NOTICES.txt")}
          target="_blank"
          rel="noopener"
          data-testid="license-texts"
        >
          <div class="grow">
            <div>{t("Lizenzen")}</div>
            <div class="desc">
              {t(
                "MultiWarden ist freie Software unter der GNU GPL v3 (oder neuer). Hier stehen die Lizenztexte aller enthaltenen Open-Source-Komponenten.",
              )}
            </div>
          </div>
          <Icon name="external" size={16} />
        </a>
      </Group>
      <div class="settings-group" data-testid="oss-list">
        <h2>{t("Open-Source-Komponenten")}</h2>
        <div class="card">
          {THIRD_PARTY.map((c) => (
            <a
              class="settings-row clickable link-row"
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              key={c.name}
              data-testid="oss-item"
            >
              <div class="grow">
                <div class="oss-name">
                  {c.name}
                  <span class="oss-license">{c.license}</span>
                </div>
                <div class="desc">{t(c.use)}</div>
                <div class="desc oss-url">{c.url.replace(/^https:\/\/(www\.)?/, "")}</div>
              </div>
              <Icon name="external" size={14} />
            </a>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

function PinSetup({ onDone }: { onDone: (ok: boolean) => void }) {
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [lockAfterRestart, setLockAfterRestart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    if (pin.length < 4) return setErr(t("Die PIN muss mindestens 4 Zeichen lang sein."));
    if (pin !== pin2) return setErr(t("Die PINs stimmen nicht überein."));
    setBusy(true);
    try {
      await call("setPin", { pin, lockAfterRestart });
      onDone(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="settings-sub"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="pin-setup"
    >
      <p class="hint" style={{ margin: "0 0 10px" }}>
        {t(
          "Die PIN gilt für alle Konten, die gerade entsperrt sind (und für später entsperrte Konten). Nach fünf Fehlversuchen wird sie deaktiviert.",
        )}
      </p>
      <label class="field">
        <span class="lbl">{t("PIN")}</span>
        <PasswordInput value={pin} onValue={setPin} autoFocus name="new-pin" autocomplete="off" />
      </label>
      <label class="field">
        <span class="lbl">{t("PIN wiederholen")}</span>
        <PasswordInput value={pin2} onValue={setPin2} name="new-pin-2" autocomplete="off" />
      </label>
      <label class="checkbox" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={lockAfterRestart} onChange={(e) => setLockAfterRestart((e.target as HTMLInputElement).checked)} />
        {t("Nach Browser-Neustart Master-Passwort verlangen")}
      </label>
      {err && <div class="banner error">{err}</div>}
      <div class="row-gap" style={{ justifyContent: "flex-end" }}>
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => onDone(false)}>
          {t("Abbrechen")}
        </button>
        <button class="btn btn-primary btn-sm" type="submit" disabled={busy || !pin} data-testid="pin-save">
          {busy && <Spinner />}
          {t("PIN festlegen")}
        </button>
      </div>
    </form>
  );
}

function NeverDomains() {
  const [domains, setDomains] = useState<string[] | null>(null);
  useEffect(() => {
    call("neverDomains", {})
      .then((r) => setDomains(r.domains))
      .catch(() => setDomains([]));
  }, []);
  if (!domains) return null;
  return (
    <div class="settings-sub">
      {domains.length === 0 ? (
        <p class="hint" style={{ margin: 0 }}>
          {t("Noch keine. Wähle in der Leiste „Login speichern?“ auf einer Website „Nie für diese Website“, um sie hier aufzunehmen.")}
        </p>
      ) : (
        domains.map((d) => (
          <div class="never-row" key={d}>
            <Icon name="globe" size={14} />
            <span class="grow">{d}</span>
            <button
              class="icon-btn sm"
              title={t("Entfernen")}
              aria-label={t("{site} entfernen", { site: d })}
              onClick={async () => setDomains((await call("neverDomains", { remove: d })).domains)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
