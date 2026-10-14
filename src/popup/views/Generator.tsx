import { useEffect, useState } from "preact/hooks";
import { FORWARDERS, ForwarderSettings, forwarderMeta } from "../../shared/forwarders";
import {
  applyPassphrasePolicy,
  applyPasswordPolicy,
  loadGeneratorPolicy,
  policyMode,
  DEFAULT_PASSPHRASE,
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  generatePassphrase,
  generatePassword,
  generateUsername,
  PassphraseOptions,
  PasswordOptions,
  passwordStrength,
  UsernameOptions,
} from "../../shared/generator";
import type { GeneratorPolicy } from "../../shared/policies";
import { useApp } from "../app-state";
import { ColoredPassword, PasswordInput, Spinner, Switch, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { copyToClipboard, relTime } from "../util";

import { t, tk } from "../../shared/i18n";

type Mode = "password" | "passphrase" | "username";

interface GenState {
  mode: Mode;
  password: PasswordOptions;
  passphrase: PassphraseOptions;
  username: UsernameOptions;
}

const numStyle = { width: 60, border: "1px solid var(--border)", borderRadius: 7, padding: "4px 6px", background: "var(--surface)" };

const PW_SWITCHES: [keyof PasswordOptions, string][] = [
  ["upper", tk("Großbuchstaben (A-Z)")],
  ["lower", tk("Kleinbuchstaben (a-z)")],
  ["digits", tk("Zahlen (0-9)")],
  ["special", tk("Sonderzeichen (!@#$%^&*)")],
  ["avoidAmbiguous", tk("Mehrdeutige Zeichen vermeiden")],
];

const USERNAME_KINDS: [UsernameOptions["kind"], string][] = [
  ["word", tk("Zufälliges Wort")],
  ["plus", tk("Plus-adressierte E-Mail")],
  ["catchall", tk("Catch-all-E-Mail")],
  ["forwarded", tk("Weitergeleiteter E-Mail-Alias")],
];

/** Load the generator options (shared with the inline menu, context menu and item editor). */
export async function loadGenState(policy?: GeneratorPolicy | null): Promise<GenState> {
  const g = ((await chrome.storage.local.get("generatorOptions")).generatorOptions ?? {}) as Partial<GenState>;
  return {
    mode: policyMode(g.mode ?? "password", policy),
    password: applyPasswordPolicy({ ...DEFAULT_PASSWORD, ...(g.password ?? {}) }, policy),
    passphrase: applyPassphrasePolicy({ ...DEFAULT_PASSPHRASE, ...(g.passphrase ?? {}) }, policy),
    username: { ...DEFAULT_USERNAME, ...(g.username ?? {}) },
  };
}

export function GeneratorView() {
  const app = useApp();
  const toast = useToast();
  const [st, setSt] = useState<GenState>({
    mode: "password",
    password: DEFAULT_PASSWORD,
    passphrase: DEFAULT_PASSPHRASE,
    username: DEFAULT_USERNAME,
  });
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [website, setWebsite] = useState(app.page.host ?? "");
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState<GeneratorPolicy | null>(null);

  useEffect(() => {
    loadGeneratorPolicy()
      .then(async (p) => {
        setPolicy(p);
        setSt(await loadGenState(p));
      })
      .finally(() => setLoaded(true));
  }, []);

  const regen = (s = st) => {
    setError("");
    try {
      if (s.mode === "password") setValue(generatePassword(s.password));
      else if (s.mode === "passphrase") setValue(generatePassphrase(s.passphrase));
      else if (s.username.kind === "forwarded") setValue("");
      else setValue(generateUsername(s.username, website));
    } catch (e: any) {
      setValue("");
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    if (!loaded) return;
    regen();
    chrome.storage.local.set({ generatorOptions: st });
  }, [st, loaded]);

  const setPw = (p: Partial<PasswordOptions>) => setSt((s) => ({ ...s, password: applyPasswordPolicy({ ...s.password, ...p }, policy) }));
  const setPp = (p: Partial<PassphraseOptions>) =>
    setSt((s) => ({ ...s, passphrase: applyPassphrasePolicy({ ...s.passphrase, ...p }, policy) }));
  /** switches the organization's policy keeps switched on */
  const forced: Partial<Record<string, boolean>> = policy
    ? {
        upper: policy.useUpper,
        lower: policy.useLower,
        digits: policy.useNumbers || policy.minNumbers > 0,
        special: policy.useSpecial || policy.minSpecial > 0,
        capitalize: policy.capitalize,
        includeNumber: policy.includeNumber,
      }
    : {};
  const setUn = (p: Partial<UsernameOptions>) => setSt((s) => ({ ...s, username: { ...s.username, ...p } }));
  const strength = passwordStrength(st.mode === "username" ? "" : value);
  const kind = st.mode === "username" ? (st.username.kind === "word" ? "username" : "email") : st.mode;

  const copy = async () => {
    if (!value) return;
    await copyToClipboard(value, app.state.settings.clearClipboardSeconds);
    call("generatorHistoryAdd", { value, kind, site: website || undefined }).catch(() => {});
    toast.show(
      st.mode === "password" ? t("Passwort kopiert") : st.mode === "passphrase" ? t("Passphrase kopiert") : t("Benutzername kopiert"),
    );
  };

  const createAlias = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await call("forwarderGenerate", { id: st.username.forwarder as any, website });
      setValue(r.email);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div class="topbar">
        <h1>{t("Generator")}</h1>
        <button
          class="icon-btn"
          title={t("Generatorverlauf")}
          aria-label={t("Generatorverlauf")}
          onClick={() => app.go({ name: "genHistory" })}
          data-testid="gen-history"
        >
          <Icon name="history" size={18} />
        </button>
      </div>
      <main>
        <div class="segmented">
          {(
            [
              ["password", t("Passwort")],
              ["passphrase", t("Passphrase")],
              ["username", t("Benutzername")],
            ] as [Mode, string][]
          ).map(([m, l]) => (
            <button
              key={m}
              class={st.mode === m ? "on" : ""}
              onClick={() => setSt({ ...st, mode: m })}
              disabled={!!policy?.overrideType && m !== "username" && m !== policy.overrideType}
              data-testid={"gen-mode-" + m}
            >
              {l}
            </button>
          ))}
        </div>
        {policy && st.mode !== "username" && (
          <div class="banner" data-testid="gen-policy">
            <Icon name="building" size={16} />
            <span class="grow">{t("Richtlinien deiner Organisation beeinflussen die Generator-Einstellungen.")}</span>
          </div>
        )}
        <div class="gen-output" data-testid="generated">
          <span class="v">
            {value ? (
              st.mode === "username" ? (
                <span class="mono">{value}</span>
              ) : (
                <ColoredPassword value={value} />
              )
            ) : (
              <span class="muted small">
                {error || (st.mode === "username" && st.username.kind === "forwarded" ? t("Noch keine Adresse erstellt") : "")}
              </span>
            )}
          </span>
          {!(st.mode === "username" && st.username.kind === "forwarded") && (
            <button class="icon-btn sm" title={t("Neu generieren")} onClick={() => regen()} data-testid="gen-regen">
              <Icon name="refresh" size={16} />
            </button>
          )}
          <button class="icon-btn sm" title={t("Kopieren")} onClick={copy} disabled={!value} data-testid="gen-copy">
            <Icon name="copy" size={16} />
          </button>
        </div>
        {st.mode === "password" && (
          <div class="detail-card">
            <div class="settings-row" style={{ flexWrap: "wrap" }}>
              <div class="grow">{t("Länge")}</div>
              <input
                type="number"
                min={Math.max(5, policy?.minLength ?? 0)}
                max={128}
                value={st.password.length}
                style={numStyle}
                onInput={(e) => setPw({ length: Math.max(5, Math.min(128, Number((e.target as HTMLInputElement).value) || 5)) })}
              />
              <input
                type="range"
                min={5}
                max={64}
                value={st.password.length}
                onInput={(e) => setPw({ length: Number((e.target as HTMLInputElement).value) })}
              />
            </div>
            {PW_SWITCHES.map(([k, l]) => (
              <div class="settings-row" key={k}>
                <div class="grow">{t(l)}</div>
                <Switch
                  checked={!!st.password[k]}
                  onChange={(v) => setPw({ [k]: v } as any)}
                  label={t(l)}
                  disabled={!!forced[k]}
                  testid={"gen-" + k}
                />
              </div>
            ))}
            <div class="settings-row">
              <div class="grow">{t("Mindestens Zahlen")}</div>
              <input
                type="number"
                min={0}
                max={9}
                value={st.password.minDigits}
                style={numStyle}
                onInput={(e) => setPw({ minDigits: Number((e.target as HTMLInputElement).value) || 0 })}
              />
            </div>
            <div class="settings-row">
              <div class="grow">{t("Mindestens Sonderzeichen")}</div>
              <input
                type="number"
                min={0}
                max={9}
                value={st.password.minSpecial}
                style={numStyle}
                onInput={(e) => setPw({ minSpecial: Number((e.target as HTMLInputElement).value) || 0 })}
              />
            </div>
          </div>
        )}
        {st.mode === "passphrase" && (
          <div class="detail-card">
            <div class="settings-row" style={{ flexWrap: "wrap" }}>
              <div class="grow">{t("Anzahl Wörter")}</div>
              <span class="mono">{st.passphrase.words}</span>
              <input
                type="range"
                min={Math.max(3, policy?.minNumberWords ?? 0)}
                max={20}
                value={st.passphrase.words}
                onInput={(e) => setPp({ words: Number((e.target as HTMLInputElement).value) })}
              />
            </div>
            <div class="settings-row">
              <div class="grow">{t("Trennzeichen")}</div>
              <input
                value={st.passphrase.separator}
                maxLength={1}
                style={{ ...numStyle, width: 44, textAlign: "center" }}
                onInput={(e) => setPp({ separator: (e.target as HTMLInputElement).value })}
              />
            </div>
            <div class="settings-row">
              <div class="grow">{t("Großschreibung")}</div>
              <Switch
                checked={st.passphrase.capitalize}
                onChange={(v) => setPp({ capitalize: v })}
                label={t("Großschreibung")}
                disabled={!!forced.capitalize}
              />
            </div>
            <div class="settings-row">
              <div class="grow">{t("Zahl einfügen")}</div>
              <Switch
                checked={st.passphrase.includeNumber}
                onChange={(v) => setPp({ includeNumber: v })}
                label={t("Zahl einfügen")}
                disabled={!!forced.includeNumber}
              />
            </div>
          </div>
        )}
        {st.mode === "username" && (
          <div class="detail-card">
            <div class="settings-row">
              <div class="grow">{t("Art")}</div>
              <select
                value={st.username.kind}
                onChange={(e) => setUn({ kind: (e.target as HTMLSelectElement).value as UsernameOptions["kind"] })}
                data-testid="username-kind"
              >
                {USERNAME_KINDS.map(([k, l]) => (
                  <option value={k} key={k}>
                    {t(l)}
                  </option>
                ))}
              </select>
            </div>
            {st.username.kind !== "word" && (
              <TextRow
                label={t("Website")}
                value={website}
                onChange={setWebsite}
                onBlur={() => regen()}
                placeholder="beispiel.de"
                testid="gen-website"
              />
            )}
            {st.username.kind === "word" && (
              <>
                <div class="settings-row">
                  <div class="grow">{t("Großschreibung")}</div>
                  <Switch checked={st.username.wordCapitalize} onChange={(v) => setUn({ wordCapitalize: v })} label={t("Großschreibung")} />
                </div>
                <div class="settings-row">
                  <div class="grow">{t("Zahl anhängen")}</div>
                  <Switch
                    checked={st.username.wordIncludeNumber}
                    onChange={(v) => setUn({ wordIncludeNumber: v })}
                    label={t("Zahl anhängen")}
                  />
                </div>
              </>
            )}
            {st.username.kind === "plus" && (
              <>
                <TextRow label={t("E-Mail-Adresse")} value={st.username.email} onChange={(v) => setUn({ email: v })} testid="plus-email" />
                <ModeRow value={st.username.plusMode} onChange={(v) => setUn({ plusMode: v })} />
              </>
            )}
            {st.username.kind === "catchall" && (
              <>
                <TextRow
                  label={t("Domain")}
                  value={st.username.domain}
                  onChange={(v) => setUn({ domain: v })}
                  placeholder="beispiel.de"
                  testid="catchall-domain"
                />
                <ModeRow value={st.username.catchallMode} onChange={(v) => setUn({ catchallMode: v })} />
              </>
            )}
            {st.username.kind === "forwarded" && (
              <ForwarderEditor id={st.username.forwarder} onId={(id) => setUn({ forwarder: id })} onCreate={createAlias} busy={busy} />
            )}
          </div>
        )}
        {st.mode !== "username" && (
          <p class="hint">
            {t("Stärke:")} {strength.label}
          </p>
        )}
      </main>
    </>
  );
}

function TextRow({
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  testid?: string;
}) {
  return (
    <div class="settings-row">
      <div class="grow">{label}</div>
      <input
        value={value}
        placeholder={placeholder}
        style={{ ...numStyle, width: 190 }}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
        onBlur={onBlur}
        data-testid={testid}
      />
    </div>
  );
}

function ModeRow({ value, onChange }: { value: "random" | "website"; onChange: (v: "random" | "website") => void }) {
  return (
    <div class="settings-row">
      <div class="grow">{t("Zusatz")}</div>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as "random" | "website")}>
        <option value="random">{t("Zufällig")}</option>
        <option value="website">{t("Name der Website")}</option>
      </select>
    </div>
  );
}

/** Service choice and its (encrypted) access data. */
function ForwarderEditor({ id, onId, onCreate, busy }: { id: string; onId: (id: string) => void; onCreate: () => void; busy: boolean }) {
  const toast = useToast();
  const meta = forwarderMeta(id) ?? FORWARDERS[0];
  const [all, setAll] = useState<Record<string, ForwarderSettings> | null>(null);
  const [cur, setCur] = useState<ForwarderSettings>({});
  useEffect(() => {
    call("forwarderSettings", {})
      .then((r) => setAll(r.forwarders as any))
      .catch(() => setAll({}));
  }, []);
  // take the stored values when loaded or when the service changes – not after our own saves, which would
  // throw away what was typed into the next field in the meantime
  const loaded = all !== null;
  useEffect(() => {
    if (all) setCur(all[meta.id] ?? {});
  }, [loaded, meta.id]);
  const save = async (next: ForwarderSettings) => {
    setCur(next);
    try {
      await call("forwarderSave", { id: meta.id, settings: next });
      setAll((a) => ({ ...(a ?? {}), [meta.id]: next }));
    } catch (e: any) {
      toast.show(e?.message ?? String(e), "error");
    }
  };
  const field = (k: keyof ForwarderSettings, label: string, placeholder?: string) => (
    <div class="settings-row" key={k}>
      <div class="grow">{label}</div>
      <input
        value={cur[k] ?? ""}
        placeholder={placeholder}
        style={{ ...numStyle, width: 190 }}
        onInput={(e) => setCur({ ...cur, [k]: (e.target as HTMLInputElement).value })}
        onBlur={() => save(cur)}
        data-testid={"fwd-" + k}
      />
    </div>
  );
  return (
    <>
      <div class="settings-row">
        <div class="grow">{t("Dienst")}</div>
        <select value={meta.id} onChange={(e) => onId((e.target as HTMLSelectElement).value)} data-testid="fwd-service">
          {FORWARDERS.map((f) => (
            <option value={f.id} key={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </div>
      {all === null ? (
        <div class="settings-row">
          <Spinner />
        </div>
      ) : (
        <>
          <div class="settings-row" style={{ flexWrap: "wrap" }}>
            <div class="grow">{t(meta.tokenLabel)}</div>
            <div style={{ width: "100%" }} onFocusOut={() => save(cur)}>
              <PasswordInput value={cur.token ?? ""} onValue={(v) => setCur({ ...cur, token: v })} autocomplete="off" name="fwd-token" />
            </div>
          </div>
          {meta.fields.includes("domain") && field("domain", t("E-Mail-Domain"), "beispiel.de")}
          {meta.fields.includes("prefix") && field("prefix", t("Präfix (optional)"))}
          {meta.fields.includes("baseUrl") && field("baseUrl", t("Server-URL (selbst gehostet, optional)"), meta.defaultBaseUrl)}
          <div class="settings-row">
            <span class="grow hint" style={{ margin: 0 }}>
              {t("Zugangsdaten werden verschlüsselt gespeichert.")}
            </span>
            <button
              class="btn btn-primary btn-sm"
              disabled={busy}
              onClick={async () => {
                await save(cur);
                onCreate();
              }}
              data-testid="fwd-create"
            >
              {busy && <Spinner />}
              {t("Adresse erstellen")}
            </button>
          </div>
        </>
      )}
    </>
  );
}

const KIND_LABEL: Record<string, string> = {
  password: tk("Passwort"),
  passphrase: tk("Passphrase"),
  username: tk("Benutzername"),
  email: tk("E-Mail-Adresse"),
};

export function GeneratorHistoryView() {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const [data, setData] = useState<{ locked: boolean; history: { value: string; date: number; kind: string; site?: string }[] } | null>(
    null,
  );
  const load = () =>
    call("generatorHistory", {})
      .then(setData)
      .catch(() => setData({ locked: true, history: [] }));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Zurück")}>
          <Icon name="chevronLeft" size={20} />
        </button>
        <h1>{t("Generatorverlauf")}</h1>
        {data && data.history.length > 0 && (
          <button
            class="btn btn-ghost btn-sm"
            data-testid="history-clear"
            onClick={async () => {
              const ok = await dialogs.confirm({
                title: t("Verlauf löschen?"),
                message: t("Alle generierten Passwörter und Benutzernamen im Verlauf werden gelöscht."),
                okLabel: t("Löschen"),
                danger: true,
              });
              if (!ok) return;
              await call("generatorHistoryClear", {});
              await load();
              toast.show(t("Verlauf gelöscht"));
            }}
          >
            {t("Alle löschen")}
          </button>
        )}
      </div>
      <main>
        {!data ? (
          <div class="empty">
            <Spinner />
          </div>
        ) : data.history.length === 0 ? (
          <div class="empty">
            <Icon name="history" size={32} />
            {t("Noch nichts generiert.")}
            <div class="hint" style={{ maxWidth: 280, textAlign: "center" }}>
              {t("Kopierte und ausgefüllte Passwörter und Benutzernamen erscheinen hier, verschlüsselt gespeichert.")}
            </div>
          </div>
        ) : (
          <div class="card" data-testid="history-list">
            {data.history.map((h) => (
              <div class="row" key={h.date + h.value} style={{ cursor: "default" }} data-testid="history-row">
                <div class="text">
                  <div class="title">
                    <span class="t mono">{h.value}</span>
                  </div>
                  <div class="subtitle">
                    {t(KIND_LABEL[h.kind] ?? h.kind)} · {relTime(h.date)}
                    {h.site ? " · " + h.site : ""}
                  </div>
                </div>
                <div class="actions">
                  <button
                    class="icon-btn sm"
                    title={t("Kopieren")}
                    aria-label={t("Kopieren")}
                    onClick={async () => {
                      await copyToClipboard(h.value, app.state.settings.clearClipboardSeconds);
                      toast.show(t("{what} kopiert", { what: t(KIND_LABEL[h.kind] ?? h.kind) }));
                    }}
                  >
                    <Icon name="copy" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
