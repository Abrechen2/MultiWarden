import { useEffect, useRef, useState } from "preact/hooks";
import type { LoginFlowPublic } from "../../shared/messages";
import type { ServerType, ServerUrls } from "../../shared/types";
import { Route, useApp } from "../app-state";
import { Field, PasswordInput, Spinner, TextInput, useToast } from "../components";
import { Icon, Logo } from "../icons";
import { call, onBroadcast } from "../rpc";

import { localized, t, tk } from "../../shared/i18n";
const PROVIDER_NAMES: Record<number, string> = localized({
  0: tk("Authenticator-App"),
  1: tk("E-Mail"),
  2: "Duo",
  3: "YubiKey OTP",
  6: tk("Duo (Organisation)"),
  7: tk("Sicherheitsschlüssel / Passkey"),
});
const CODE_PROVIDERS = [0, 1, 3];
const SUPPORTED = [0, 1, 2, 3, 6, 7];
const ACTIVE_STEPS = new Set([
  "sso-wait",
  "twoFactor",
  "twoFactor-wait",
  "newDevice",
  "mp",
  "tde",
  "tde-new",
  "auth-request",
  "set-password",
  "kc-confirm",
]);

export function isActiveFlow(f: LoginFlowPublic | null | undefined): boolean {
  return !!f && ACTIVE_STEPS.has(f.step);
}

function preferredProvider(providers: number[]): number {
  const s = providers.filter((p) => SUPPORTED.includes(p));
  for (const p of [7, 0, 2, 6, 3, 1]) if (s.includes(p)) return p;
  return s[0] ?? 0;
}

const ENV_SUFFIX: Record<string, string> = {
  webVault: "",
  api: "/api",
  identity: "/identity",
  icons: "/icons",
  notifications: "/notifications",
  events: "/events",
};

export function AddAccountView({ route }: { route: Extract<Route, { name: "addAccount" }> }) {
  const app = useApp();
  const toast = useToast();
  const first = app.accounts.length === 0;
  const [flow, setFlow] = useState<LoginFlowPublic | null | undefined>(undefined);
  const [server, setServer] = useState<ServerType>((route.server as ServerType) ?? "us");
  const [baseUrl, setBaseUrl] = useState(route.baseUrl ?? "");
  const [email, setEmail] = useState(route.email ?? "");
  const [password, setPassword] = useState("");
  const [ssoMode, setSsoMode] = useState(false);
  const [registerMode, setRegisterMode] = useState(false);
  const [regName, setRegName] = useState("");
  const [password2, setRegPassword2] = useState("");
  const [regHint, setRegHint] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [orgIdentifier, setOrgIdentifier] = useState("");
  const [needIdentifier, setNeedIdentifier] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // self-hosted: services under other URLs ("custom environment")
  const [showEnv, setShowEnv] = useState(false);
  const [env, setEnv] = useState<Partial<ServerUrls>>({});
  useEffect(() => {
    if (server !== "selfhosted" || !/^https?:\/\/[^/]+/i.test(baseUrl.trim())) return;
    const tm = setTimeout(() => {
      call("getCustomEnv", { baseUrl: baseUrl.trim() })
        .then((r) => {
          setEnv(r.env);
          if (Object.keys(r.env).length) setShowEnv(true);
        })
        .catch(() => {});
    }, 300);
    return () => clearTimeout(tm);
  }, [server, baseUrl]);

  /** Check the server input and store the custom URLs before a request to the server. */
  async function prepServer(): Promise<boolean> {
    if (server !== "selfhosted") return true;
    if (!baseUrl.trim()) {
      setError(t("Bitte die URL deines Servers eingeben."));
      return false;
    }
    try {
      await call("setCustomEnv", { baseUrl: baseUrl.trim(), env: showEnv ? env : {} });
      return true;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return false;
    }
  }

  const refresh = async () => {
    try {
      setFlow(await call("loginGet", {}));
    } catch {
      setFlow(null);
    }
  };

  useEffect(() => {
    refresh();
    chrome.storage.local.get("lastServer").then((r) => {
      const ls = r.lastServer as { server: ServerType; baseUrl?: string } | undefined;
      if (ls && !route.server) {
        setServer(ls.server);
        if (ls.baseUrl) setBaseUrl(ls.baseUrl);
      }
    });
    return onBroadcast((ev) => {
      if (ev === "loginFlowChanged") refresh();
    });
  }, []);

  // flow finished → back to the vault
  useEffect(() => {
    if (flow?.step === "done") {
      (async () => {
        await call("loginAck", {});
        toast.show(flow.existingAccountKey ? t("Konto entsperrt") : t("Konto hinzugefügt"));
        await app.reload();
        app.go({ name: "vault" }, true);
      })();
    }
  }, [flow?.step]);

  const rememberServer = () => chrome.storage.local.set({ lastServer: { server, baseUrl: server === "selfhosted" ? baseUrl : undefined } });

  async function submitPassword() {
    setError(null);
    if (!email.trim() || !password) return setError(t("Bitte E-Mail und Master-Passwort eingeben."));
    if (!(await prepServer())) return;
    setBusy(true);
    try {
      const f = await call("loginStart", { server, baseUrl: server === "selfhosted" ? baseUrl : undefined, email, password });
      rememberServer();
      if (f.step === "error") {
        setError(f.error ?? t("Anmeldung fehlgeschlagen"));
        if (f.ssoRequiredIdentifier) {
          setSsoMode(true);
          setOrgIdentifier(f.ssoRequiredIdentifier);
        }
        await call("loginAck", {});
        setFlow(null);
      } else setFlow(f);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitSso() {
    setError(null);
    if (!(await prepServer())) return;
    setBusy(true);
    try {
      let ident = orgIdentifier.trim();
      if (!ident) {
        if (!email.trim()) {
          setBusy(false);
          return setError(t("Bitte E-Mail-Adresse oder SSO-Kennung angeben."));
        }
        const r = await call("loginSsoLookup", { server, baseUrl: server === "selfhosted" ? baseUrl : undefined, email });
        if (!r.identifier) {
          setNeedIdentifier(true);
          setBusy(false);
          return setError(
            t("Für diese E-Mail-Domain ist keine Organisation hinterlegt. Bitte die SSO-Kennung deiner Organisation eingeben."),
          );
        }
        ident = r.identifier;
      }
      rememberServer();
      const f = await call("loginSsoStart", {
        server,
        baseUrl: server === "selfhosted" ? baseUrl : undefined,
        email,
        orgIdentifier: ident,
      });
      if (f.step === "error") {
        setError(f.error ?? t("SSO fehlgeschlagen"));
        await call("loginAck", {});
        setFlow(null);
      } else setFlow(f);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDevice() {
    setError(null);
    if (!email.trim()) return setError(t("Bitte die E-Mail-Adresse eingeben"));
    if (!(await prepServer())) return;
    setBusy(true);
    try {
      const f = await call("loginDevice", { server, baseUrl: server === "selfhosted" ? baseUrl : undefined, email });
      rememberServer();
      if (f.step === "error") {
        setError(f.error ?? t("Anmeldung fehlgeschlagen"));
        await call("loginAck", {});
        setFlow(null);
      } else setFlow(f);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitPasskey() {
    setError(null);
    if (!(await prepServer())) return;
    setBusy(true);
    try {
      const f = await call("loginPasskey", { server, baseUrl: server === "selfhosted" ? baseUrl : undefined });
      rememberServer();
      if (f.step === "error") {
        setError(f.error ?? t("Anmeldung fehlgeschlagen"));
        await call("loginAck", {});
        setFlow(null);
      } else setFlow(f);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function requestHint() {
    setError(null);
    if (!email.trim()) return setError(t("Bitte die E-Mail-Adresse eingeben"));
    if (!(await prepServer())) return;
    try {
      await call("requestPasswordHint", { server, baseUrl: server === "selfhosted" ? baseUrl : undefined, email });
      setInfo(t("Falls ein Konto mit dieser Adresse existiert, wurde der Hinweis per E-Mail verschickt."));
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function submitRegister() {
    setError(null);
    setInfo(null);
    if (!(await prepServer())) return;
    if (!email.trim()) return setError(t("Bitte die E-Mail-Adresse eingeben"));
    if (password.length < 12) return setError(t("Das Master-Passwort muss mindestens 12 Zeichen lang sein."));
    if (password !== password2) return setError(t("Die Master-Passwörter stimmen nicht überein."));
    setBusy(true);
    try {
      const r = await call("register", {
        server,
        baseUrl: server === "selfhosted" ? baseUrl : undefined,
        email,
        name: regName,
        password,
        hint: regHint,
      });
      rememberServer();
      if (r.status === "verify-email") {
        setInfo(
          t("Wir haben dir eine E-Mail geschickt. Öffne den Link darin, um das Konto fertig einzurichten, und melde dich danach hier an."),
        );
        setRegisterMode(false);
      } else if (r.flow) {
        if (r.flow.step === "error") setError(r.flow.error ?? t("Anmeldung fehlgeschlagen"));
        else setFlow(r.flow);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const cancelFlow = async () => {
    await call("loginCancel", {});
    setFlow(null);
    if (flow?.existingAccountKey) app.back();
  };

  const active = isActiveFlow(flow);
  const title = !active
    ? t("Konto hinzufügen")
    : flow!.existingAccountKey
      ? t("Konto entsperren")
      : flow!.step.startsWith("twoFactor")
        ? t("Zweistufige Anmeldung")
        : flow!.step === "newDevice"
          ? t("Neues Gerät bestätigen")
          : t("Anmeldung");

  if (flow === undefined)
    return (
      <div class="empty" style={{ paddingTop: 200 }}>
        <Spinner />
      </div>
    );

  return (
    <>
      {(!first || active) && (
        <div class="topbar">
          <button
            class="icon-btn back"
            onClick={() => (active ? cancelFlow() : app.back())}
            aria-label={active ? t("Abbrechen") : t("Zurück")}
          >
            <Icon name={active ? "x" : "chevronLeft"} size={20} />
          </button>
          <h1>{title}</h1>
        </div>
      )}
      <main>
        {active ? (
          <FlowSteps flow={flow!} onFlow={setFlow} onCancel={cancelFlow} />
        ) : (
          <div class={first ? "auth" : ""} style={first ? { padding: "8px 6px" } : undefined}>
            {first && (
              <div class="brand">
                <Logo size={48} />
                <h1>{t("MultiWarden")}</h1>
                <p>{t("Mehrere Bitwarden-Konten gleichzeitig – ein gemeinsamer Tresor.")}</p>
              </div>
            )}
            {flow?.step === "error" && flow.error && !error && <div class="banner error">{flow.error}</div>}
            {info && (
              <div class="banner" data-testid="login-info">
                {info}
              </div>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                registerMode ? submitRegister() : ssoMode ? submitSso() : submitPassword();
              }}
            >
              <Field label={t("Server")} group>
                <div class="segmented" style={{ marginBottom: 0 }}>
                  {(
                    [
                      ["us", "bitwarden.com"],
                      ["eu", "bitwarden.eu"],
                      ["selfhosted", t("Eigener Server")],
                    ] as [ServerType, string][]
                  ).map(([v, l]) => (
                    <button type="button" class={server === v ? "on" : ""} onClick={() => setServer(v)} key={v}>
                      {l}
                    </button>
                  ))}
                </div>
              </Field>
              {server === "selfhosted" && (
                <Field label={t("Server-URL")} hint={t("z. B. https://vault.example.de (Vaultwarden oder Bitwarden self-hosted)")}>
                  <TextInput
                    value={baseUrl}
                    onValue={setBaseUrl}
                    placeholder={t("https://vault.example.de")}
                    type="url"
                    name="server-url"
                    autocomplete="url"
                  />
                </Field>
              )}
              {server === "selfhosted" && (
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  style={{ padding: 0, margin: "-4px 0 10px" }}
                  onClick={() => setShowEnv(!showEnv)}
                  data-testid="toggle-env"
                >
                  <Icon name={showEnv ? "chevronDown" : "chevronRight"} size={14} />
                  {t("Weitere Server-URLs")}
                </button>
              )}
              {server === "selfhosted" && showEnv && (
                <div class="card" style={{ padding: "10px 10px 0", marginBottom: 12 }} data-testid="custom-env">
                  <p class="hint" style={{ marginTop: 0 }}>
                    {t("Nur nötig, wenn einzelne Dienste nicht unter der Server-URL laufen. Leere Felder nutzen die Server-URL.")}
                  </p>
                  {(
                    [
                      ["webVault", tk("Web-Tresor")],
                      ["api", tk("API")],
                      ["identity", tk("Identität")],
                      ["icons", tk("Symbole")],
                      ["notifications", tk("Benachrichtigungen")],
                      ["events", tk("Ereignisse")],
                    ] as [Exclude<keyof ServerUrls, "base">, string][]
                  ).map(([k, l]) => (
                    <Field label={t(l)} key={k}>
                      <TextInput
                        value={(env[k] as string) ?? ""}
                        onValue={(v) => setEnv((e) => ({ ...e, [k]: v }))}
                        placeholder={(baseUrl.trim().replace(/\/+$/, "") || "https://vault.example.de") + ENV_SUFFIX[k]}
                        type="url"
                        name={"env-" + k}
                      />
                    </Field>
                  ))}
                </div>
              )}
              <Field label={ssoMode ? t("E-Mail-Adresse (optional)") : t("E-Mail-Adresse")}>
                <TextInput
                  value={email}
                  onValue={setEmail}
                  type="email"
                  name="email"
                  autocomplete="username"
                  placeholder={t("name@example.de")}
                  autoFocus={!route.email}
                />
              </Field>
              {registerMode ? (
                <>
                  <Field label={t("Name (optional)")}>
                    <TextInput value={regName} onValue={setRegName} name="reg-name" autocomplete="name" />
                  </Field>
                  <Field
                    label={t("Master-Passwort")}
                    hint={t("Mindestens 12 Zeichen. Es kann nicht wiederhergestellt werden, wenn du es vergisst.")}
                  >
                    <PasswordInput value={password} onValue={setPassword} name="reg-password" autocomplete="new-password" />
                  </Field>
                  <Field label={t("Master-Passwort bestätigen")}>
                    <PasswordInput value={password2} onValue={setRegPassword2} name="reg-password2" autocomplete="new-password" />
                  </Field>
                  <Field label={t("Hinweis zum Master-Passwort (optional)")}>
                    <TextInput value={regHint} onValue={setRegHint} name="reg-hint" />
                  </Field>
                </>
              ) : !ssoMode ? (
                <Field label={t("Master-Passwort")}>
                  <PasswordInput value={password} onValue={setPassword} name="master-password" autoFocus={!!route.email} />
                </Field>
              ) : (
                (needIdentifier || orgIdentifier) && (
                  <Field
                    label={t("SSO-Kennung der Organisation")}
                    hint={t("Die Kennung bekommst du von deiner IT bzw. aus dem Web-Tresor.")}
                  >
                    <TextInput value={orgIdentifier} onValue={setOrgIdentifier} name="sso-identifier" autoFocus />
                  </Field>
                )
              )}
              {error && <div class="banner error">{error}</div>}
              {registerMode ? (
                <>
                  <button class="btn btn-primary btn-block" type="submit" disabled={busy} data-testid="register-submit">
                    {busy ? <Spinner /> : <Icon name="plus" size={16} />}
                    {t("Konto erstellen")}
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-block"
                    style={{ marginTop: 6 }}
                    onClick={() => {
                      setRegisterMode(false);
                      setError(null);
                    }}
                  >
                    {t("Zurück zur Anmeldung")}
                  </button>
                </>
              ) : (
                <button
                  class="btn btn-primary btn-block"
                  type="submit"
                  disabled={busy}
                  data-testid={ssoMode ? "sso-submit" : "login-submit"}
                >
                  {busy ? <Spinner /> : <Icon name={ssoMode ? "building" : "lock"} size={16} />}
                  {busy ? t("Anmeldung läuft …") : ssoMode ? t("Weiter zu SSO") : t("Anmelden")}
                </button>
              )}
              {!registerMode && !ssoMode && (
                <button
                  type="button"
                  class="btn btn-ghost btn-block"
                  style={{ marginTop: 6 }}
                  onClick={submitDevice}
                  data-testid="login-device"
                >
                  <Icon name="server" size={16} />
                  {t("Mit Gerät anmelden")}
                </button>
              )}
              {!registerMode && !ssoMode && (
                <button
                  type="button"
                  class="btn btn-ghost btn-block"
                  style={{ marginTop: 6 }}
                  onClick={submitPasskey}
                  data-testid="login-passkey"
                >
                  <Icon name="key" size={16} />
                  {t("Mit Passkey anmelden")}
                </button>
              )}
              {!registerMode && (
                <button
                  type="button"
                  class="btn btn-ghost btn-block"
                  style={{ marginTop: 6 }}
                  onClick={() => {
                    setSsoMode(!ssoMode);
                    setError(null);
                  }}
                  data-testid="toggle-sso"
                >
                  <Icon name={ssoMode ? "lock" : "building"} size={16} />
                  {ssoMode ? t("Mit Master-Passwort anmelden") : t("Mit Single Sign-on (SSO) anmelden")}
                </button>
              )}
              {!registerMode && (
                <div class="row-gap" style={{ justifyContent: "center", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
                  {!ssoMode && (
                    <button type="button" class="link small" onClick={requestHint} data-testid="request-hint">
                      {t("Master-Passwort-Hinweis anfordern")}
                    </button>
                  )}
                  <button
                    type="button"
                    class="link small"
                    onClick={() => {
                      setRegisterMode(true);
                      setSsoMode(false);
                      setError(null);
                      setInfo(null);
                    }}
                    data-testid="open-register"
                  >
                    {t("Neues Konto erstellen")}
                  </button>
                </div>
              )}
              <p class="hint" style={{ textAlign: "center", marginTop: 10 }}>
                {ssoMode
                  ? t("Die Anmeldung beim Identity-Provider deiner Organisation öffnet sich in einem neuen Tab.")
                  : t("Dein Master-Passwort verlässt dieses Gerät nicht. Es wird lokal mit der KDF deines Kontos abgeleitet.")}
              </p>
            </form>
          </div>
        )}
      </main>
    </>
  );
}

function FlowSteps({
  flow,
  onFlow,
  onCancel,
}: {
  flow: LoginFlowPublic;
  onFlow: (f: LoginFlowPublic | null) => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(true);
  const [rememberDevice, setRememberDevice] = useState(flow.rememberDevice ?? true);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<number>(() => preferredProvider(flow.twoFactor?.providers ?? []));
  const emailSent = useRef(false);

  const run = async (fn: () => Promise<LoginFlowPublic | null>) => {
    setBusy(true);
    try {
      const f = await fn();
      onFlow(f);
    } catch (e: any) {
      toast.show(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  // poll while waiting for something outside the popup
  useEffect(() => {
    if (!["sso-wait", "twoFactor-wait", "auth-request"].includes(flow.step)) return;
    const tx = window.setInterval(
      async () => {
        try {
          onFlow(flow.step === "auth-request" ? await call("loginPoll", {}) : await call("loginGet", {}));
        } catch {
          /* ignore */
        }
      },
      flow.step === "auth-request" ? 3000 : 1500,
    );
    return () => window.clearInterval(tx);
  }, [flow.step]);

  useEffect(() => {
    if (flow.step === "twoFactor") {
      setProvider((p) => (flow.twoFactor?.providers.includes(p) ? p : preferredProvider(flow.twoFactor?.providers ?? [])));
    }
  }, [flow.step, flow.twoFactor?.providers.join(",")]);

  const sendEmail = async () => {
    const r = await call("loginSendEmail", {});
    if (r.ok) toast.show(t("Code wurde per E-Mail gesendet"));
    else toast.show(r.error ?? t("Senden fehlgeschlagen"), "error");
  };

  useEffect(() => {
    // email is the only method → send the code right away
    if (flow.step === "twoFactor" && provider === 1 && !emailSent.current && flow.twoFactor?.providers.length === 1) {
      emailSent.current = true;
      sendEmail();
    }
  }, [flow.step, provider]);

  const errorBanner = flow.error ? <div class="banner error">{flow.error}</div> : null;
  const infoBanner = flow.info ? <div class="banner">{flow.info}</div> : null;
  const who = (
    <p class="muted small" style={{ margin: "0 0 12px" }}>
      {flow.email ? flow.email + " · " : ""}
      {flow.server === "selfhosted" ? (flow.baseUrl ?? "") : flow.server === "eu" ? "bitwarden.eu" : "bitwarden.com"}
    </p>
  );

  switch (flow.step) {
    case "sso-wait":
      return (
        <div data-testid="flow-sso-wait">
          {who}
          <div class="empty" style={{ padding: "16px 0" }}>
            <Spinner />
            <p>{t("Melde dich im geöffneten Tab bei deinem Identity-Provider an. Danach geht es hier automatisch weiter.")}</p>
          </div>
          <button class="btn btn-ghost btn-block" onClick={onCancel}>
            {t("Abbrechen")}
          </button>
        </div>
      );

    case "twoFactor": {
      const providers = (flow.twoFactor?.providers ?? []).filter((p) => SUPPORTED.includes(p));
      const unsupported = (flow.twoFactor?.providers ?? []).filter((p) => !SUPPORTED.includes(p));
      const isCode = CODE_PROVIDERS.includes(provider);
      return (
        <form
          data-testid="flow-twofactor"
          onSubmit={(e) => {
            e.preventDefault();
            if (isCode) run(() => call("loginTwoFactor", { provider, token: code, remember }));
          }}
        >
          {who}
          {providers.length === 0 && (
            <div class="banner error">
              {t("Für dieses Konto sind nur nicht unterstützte Verfahren eingerichtet ({list}).", {
                list: unsupported.map((p) => PROVIDER_NAMES[p] ?? p).join(", "),
              })}
            </div>
          )}
          {providers.length > 1 && (
            <Field label={t("Methode")}>
              <div class="input-wrap">
                <select
                  value={provider}
                  onChange={(e) => {
                    const p = Number((e.target as HTMLSelectElement).value);
                    setProvider(p);
                    setCode("");
                    if (p === 1) sendEmail();
                  }}
                  data-testid="twofactor-method"
                >
                  {providers.map((p) => (
                    <option value={p} key={p}>
                      {PROVIDER_NAMES[p]}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={16} class="suffix" />
              </div>
            </Field>
          )}
          {isCode ? (
            <>
              <p class="muted" style={{ marginTop: 0 }}>
                {provider === 0 && t("Gib den 6-stelligen Code aus deiner Authenticator-App ein.")}
                {provider === 1 && flow.twoFactor?.emailHint
                  ? t("Gib den Code ein, der an {email} gesendet wurde.", { email: flow.twoFactor.emailHint })
                  : t("Gib den Code ein, der an deine E-Mail-Adresse gesendet wurde.")}
                {provider === 3 && t("Stecke deinen YubiKey ein und berühre ihn.")}
              </p>
              <Field label={t("Bestätigungscode")}>
                <TextInput
                  value={code}
                  onValue={setCode}
                  autoFocus
                  inputMode={provider === 3 ? "text" : "numeric"}
                  autocomplete="one-time-code"
                  mono
                  name="code"
                />
              </Field>
            </>
          ) : (
            <p class="muted" style={{ marginTop: 0 }}>
              {provider === 7
                ? t(
                    "Es öffnet sich ein Tab auf deinem Server, in dem du die Anmeldung mit deinem Sicherheitsschlüssel oder Passkey bestätigst.",
                  )
                : t("Es öffnet sich ein Tab mit Duo. Nach der Bestätigung geht es hier automatisch weiter.")}
            </p>
          )}
          <label class="checkbox">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} />
            {t("Auf diesem Gerät merken")}
          </label>
          {errorBanner}
          {isCode ? (
            <button
              class="btn btn-primary btn-block"
              type="submit"
              disabled={busy || !code.trim()}
              style={{ marginTop: 8 }}
              data-testid="twofactor-submit"
            >
              {busy && <Spinner />}
              {t("Bestätigen")}
            </button>
          ) : (
            <button
              class="btn btn-primary btn-block"
              type="button"
              disabled={busy}
              style={{ marginTop: 8 }}
              data-testid="twofactor-external"
              onClick={() => run(() => (provider === 7 ? call("loginWebAuthn", { remember }) : call("loginDuo", { provider, remember })))}
            >
              {busy && <Spinner />}
              <Icon name={provider === 7 ? "key" : "external"} size={16} />
              {provider === 7 ? t("Sicherheitsschlüssel verwenden") : t("Mit Duo bestätigen")}
            </button>
          )}
          {provider === 1 && (
            <button type="button" class="btn btn-ghost btn-block" style={{ marginTop: 6 }} onClick={sendEmail}>
              {t("Code erneut senden")}
            </button>
          )}
        </form>
      );
    }

    case "twoFactor-wait":
      return (
        <div data-testid="flow-twofactor-wait">
          {who}
          <div class="empty" style={{ padding: "16px 0" }}>
            <Spinner />
            <p>
              {flow.waitKind === "passkey"
                ? t("Bestätige die Anmeldung im geöffneten Tab mit deinem Passkey.")
                : flow.waitKind === "webauthn"
                  ? t("Bestätige die Anmeldung im geöffneten Tab mit deinem Sicherheitsschlüssel oder Passkey.")
                  : t("Bestätige die Anmeldung im geöffneten Duo-Tab.")}
            </p>
          </div>
          <button class="btn btn-ghost btn-block" onClick={onCancel}>
            {t("Abbrechen")}
          </button>
        </div>
      );

    case "newDevice":
      return (
        <form
          data-testid="flow-newdevice"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => call("loginNewDevice", { otp: code }));
          }}
        >
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {t("Der Server kennt dieses Gerät noch nicht. Gib den Bestätigungscode ein, der an deine E-Mail-Adresse gesendet wurde.")}
          </p>
          <Field label={t("Bestätigungscode")}>
            <TextInput value={code} onValue={setCode} autoFocus inputMode="numeric" autocomplete="one-time-code" mono name="code" />
          </Field>
          {errorBanner}
          <button class="btn btn-primary btn-block" type="submit" disabled={busy || !code.trim()}>
            {busy && <Spinner />}
            {t("Bestätigen")}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-block"
            style={{ marginTop: 6 }}
            onClick={async () => {
              const r = await call("loginResendDevice", {});
              toast.show(r.ok ? t("Neuer Code wurde gesendet") : (r.error ?? t("Senden fehlgeschlagen")), r.ok ? "ok" : "error");
            }}
          >
            {t("Code erneut senden")}
          </button>
        </form>
      );

    case "mp":
      return (
        <form
          data-testid="flow-mp"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => call("loginMasterPassword", { password, rememberDevice }));
          }}
        >
          {who}
          {flow.method === "passkey" && infoBanner}
          <p class="muted" style={{ marginTop: 0 }}>
            {flow.method === "passkey"
              ? t("Die Anmeldung mit Passkey war erfolgreich. Gib jetzt dein Master-Passwort ein, um den Tresor zu entschlüsseln.")
              : t("Die SSO-Anmeldung war erfolgreich. Gib jetzt dein Master-Passwort ein, um den Tresor zu entschlüsseln.")}
          </p>
          <Field label={t("Master-Passwort")}>
            <PasswordInput value={password} onValue={setPassword} autoFocus name="master-password" />
          </Field>
          {flow.tde && (
            <label class="checkbox">
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice((e.target as HTMLInputElement).checked)} />
              {t("Dieses Gerät merken (künftig ohne Master-Passwort)")}
            </label>
          )}
          {errorBanner}
          <button class="btn btn-primary btn-block" type="submit" disabled={busy || !password} style={{ marginTop: 8 }}>
            {busy && <Spinner />}
            {t("Entsperren")}
          </button>
        </form>
      );

    case "tde":
      return (
        <div data-testid="flow-tde">
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {t("Dieses Gerät ist für dein Konto noch nicht freigegeben. Wie möchtest du es bestätigen?")}
          </p>
          <label class="checkbox">
            <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice((e.target as HTMLInputElement).checked)} />
            {t("Dieses Gerät merken")}
          </label>
          {errorBanner}
          {infoBanner}
          <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
            {flow.tde?.canDevice && (
              <button
                class="btn btn-primary btn-block"
                disabled={busy}
                onClick={() => run(() => call("loginTde", { option: "device", rememberDevice }))}
              >
                <Icon name="users" size={16} />
                {t("Mit einem anderen Gerät bestätigen")}
              </button>
            )}
            {flow.tde?.canAdmin && (
              <button
                class="btn btn-secondary btn-block"
                disabled={busy}
                onClick={() => run(() => call("loginTde", { option: "admin", rememberDevice }))}
              >
                <Icon name="building" size={16} />
                {t("Admin-Freigabe anfordern")}
              </button>
            )}
            {flow.tde?.canMp && (
              <button
                class="btn btn-secondary btn-block"
                disabled={busy}
                onClick={() => run(() => call("loginTde", { option: "mp", rememberDevice }))}
              >
                <Icon name="lock" size={16} />
                {t("Mit Master-Passwort entsperren")}
              </button>
            )}
            {!flow.tde?.canDevice && !flow.tde?.canAdmin && !flow.tde?.canMp && (
              <div class="banner warn">
                {t("Für dieses Konto ist keine Freigabemethode verfügbar. Bitte wende dich an deine Administration.")}
              </div>
            )}
          </div>
        </div>
      );

    case "tde-new":
      return (
        <div data-testid="flow-tde-new">
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {t(
              "Willkommen! Dein Konto wird jetzt eingerichtet. Deine Organisation kann es im Notfall wiederherstellen (Kontowiederherstellung).",
            )}
          </p>
          <label class="checkbox">
            <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice((e.target as HTMLInputElement).checked)} />
            {t("Dieses Gerät merken")}
          </label>
          {errorBanner}
          <button
            class="btn btn-primary btn-block"
            disabled={busy}
            style={{ marginTop: 8 }}
            onClick={() => run(() => call("loginTdeCreate", { rememberDevice }))}
          >
            {busy && <Spinner />}
            {t("Konto einrichten")}
          </button>
        </div>
      );

    case "auth-request":
      return (
        <div data-testid="flow-auth-request">
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {flow.authRequest?.type === 2
              ? t(
                  "Deine Anfrage wurde an die Administration geschickt. Sobald sie freigegeben ist, geht es hier weiter – oder später beim nächsten Entsperren per SSO.",
                )
              : t("Bestätige die Anmeldung in einer anderen Bitwarden-App, in der du angemeldet bist (Web-Tresor, Desktop oder Mobil).")}
          </p>
          <div class="detail-card" style={{ padding: 12 }}>
            <div class="k small muted" style={{ fontWeight: 600 }}>
              {t("Fingerabdruck-Phrase")}
            </div>
            <div class="mono" style={{ fontSize: 15, color: "var(--danger)", marginTop: 4 }} data-testid="fingerprint">
              {flow.authRequest?.fingerprint}
            </div>
            <div class="hint">{t("Prüfe, dass auf dem anderen Gerät dieselbe Phrase angezeigt wird.")}</div>
          </div>
          {errorBanner}
          <div class="row-gap" style={{ justifyContent: "center", marginTop: 6 }}>
            <Spinner />
            <span class="muted small">{t("Warte auf Freigabe …")}</span>
          </div>
          <button class="btn btn-ghost btn-block" style={{ marginTop: 10 }} onClick={onCancel}>
            {flow.authRequest?.type === 2 ? t("Schließen") : t("Abbrechen")}
          </button>
        </div>
      );

    case "set-password": {
      const mismatch = password2 && password !== password2;
      return (
        <form
          data-testid="flow-set-password"
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== password2) return;
            run(() => call("loginSetPassword", { password, hint }));
          }}
        >
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {t("Dein Konto wurde über SSO angelegt. Lege jetzt ein Master-Passwort fest – damit wird dein Tresor verschlüsselt.")}
          </p>
          <Field
            label={t("Neues Master-Passwort")}
            hint={t("Mindestens 12 Zeichen. Es kann nicht wiederhergestellt werden, wenn du es vergisst.")}
          >
            <PasswordInput value={password} onValue={setPassword} autoFocus autocomplete="new-password" name="new-master-password" />
          </Field>
          <Field label={t("Master-Passwort wiederholen")} error={mismatch ? t("Die Passwörter stimmen nicht überein") : undefined}>
            <PasswordInput value={password2} onValue={setPassword2} autocomplete="new-password" name="new-master-password-2" />
          </Field>
          <Field label={t("Hinweis (optional)")}>
            <TextInput value={hint} onValue={setHint} name="hint" />
          </Field>
          {errorBanner}
          <button
            class="btn btn-primary btn-block"
            type="submit"
            disabled={busy || password.length < 12 || password !== password2}
            data-testid="set-password-submit"
          >
            {busy && <Spinner />}
            {t("Master-Passwort festlegen")}
          </button>
        </form>
      );
    }

    case "kc-confirm":
      return (
        <div data-testid="flow-kc">
          {who}
          <p class="muted" style={{ marginTop: 0 }}>
            {t("Deine Organisation verwaltet die Schlüssel über einen Key Connector. Dein Tresorschlüssel wird dort gespeichert:")}
          </p>
          <div class="detail-card" style={{ padding: 12 }}>
            <div class="mono" data-testid="kc-host">
              {flow.keyConnectorHost}
            </div>
          </div>
          <p class="hint">{t("Bestätige nur, wenn du diesen Server kennst und ihm vertraust.")}</p>
          {errorBanner}
          <button class="btn btn-primary btn-block" disabled={busy} onClick={() => run(() => call("loginKeyConnector", {}))}>
            {busy && <Spinner />}
            {t("Bestätigen und fortfahren")}
          </button>
          <button class="btn btn-ghost btn-block" style={{ marginTop: 6 }} onClick={onCancel}>
            {t("Abbrechen")}
          </button>
        </div>
      );
  }
  return null;
}
