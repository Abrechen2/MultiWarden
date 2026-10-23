import { useEffect, useMemo, useState } from "preact/hooks";
import { isRestricted } from "../../shared/policies";
import { generateUsername, generateWithSavedOptions, passwordStrength } from "../../shared/generator";
import { loadGenState } from "./Generator";
import { AccountPublic, CipherType, FieldType, ItemView, UriMatch } from "../../shared/types";
import { Route, useApp } from "../app-state";
import { Field, PasswordInput, Spinner, Switch, TextInput, useToast } from "../components";
import { useDialogs } from "../dialogs";
import { Icon } from "../icons";
import { call } from "../rpc";
import { cardBrandFromNumber, itemKey, TYPE_LABEL } from "../util";
import { EXTRA_FIELDS, FieldDef, IDENTITY_FIELDS } from "./item-fields";
import { scanTotpQr } from "./qr-scan";
import { domainLabel, FillScope, hostLabel, matchForNew, scopeChoices, scopeOf, withScope } from "../fill-scope";

import { inSentence, t, tk } from "../../shared/i18n";
const MATCH_LABELS: [string, string][] = [
  ["", tk("Standard")],
  [String(UriMatch.Domain), tk("Basisdomain")],
  [String(UriMatch.Host), tk("Host")],
  [String(UriMatch.StartsWith), tk("Beginnt mit")],
  [String(UriMatch.Exact), tk("Exakt")],
  [String(UriMatch.RegularExpression), tk("Regulärer Ausdruck")],
  [String(UriMatch.Never), tk("Nie")],
];

// values as stored by the official clients
const BRANDS = ["Visa", "Mastercard", "Amex", "Discover", "Diners Club", "JCB", "Maestro", "UnionPay", "RuPay", "Other"];

export function Select({
  value,
  onChange,
  children,
  testid,
}: {
  value: string;
  onChange: (v: string) => void;
  children: any;
  testid?: string;
}) {
  return (
    <div class="input-wrap">
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} data-testid={testid}>
        {children}
      </select>
      <Icon name="chevronDown" size={16} class="suffix" />
    </div>
  );
}

function blankItem(type: CipherType, accountKey: string, prefill?: Partial<ItemView>): ItemView {
  const base: ItemView = {
    id: "",
    accountKey,
    organizationId: null,
    folderId: null,
    collectionIds: [],
    type,
    name: "",
    notes: "",
    favorite: false,
    reprompt: 0,
    edit: true,
    viewPassword: true,
    fields: [],
    passwordHistory: [],
    attachments: [],
  };
  if (type === CipherType.Login) base.login = { username: "", password: "", totp: "", uris: [{ uri: "", match: null }], passkeys: 0 };
  if (type === CipherType.Card) base.card = {};
  if (type === CipherType.Identity) base.identity = {};
  if (type === CipherType.SecureNote) base.secureNote = { type: 0 };
  if (type === CipherType.SshKey) base.sshKey = {};
  if (EXTRA_FIELDS[type]) base.extra = {};
  return { ...base, ...(prefill ?? {}), accountKey, type, login: prefill?.login ? { ...base.login!, ...prefill.login } : base.login };
}

/** Can an item of this type be created in the account (policy "restricted item types")? */
export function canCreateIn(a: AccountPublic, type: CipherType, orgs: { accountKey: string; id: string }[]): boolean {
  const p = a.policies;
  if (!p?.dataOwnership && !isRestricted(p, type, null)) return true;
  return orgs.some((o) => o.accountKey === a.key && !isRestricted(p, type, o.id));
}

export function ItemEditView({ route }: { route: Extract<Route, { name: "edit" }> }) {
  const app = useApp();
  const toast = useToast();
  const dialogs = useDialogs();
  const existing = route.key ? app.itemByKey(route.key) : undefined;
  const isNew = !existing;
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const initialAccount = existing?.accountKey ?? route.accountKey ?? app.filters.account ?? unlocked[0]?.key ?? "";
  const [item, setItem] = useState<ItemView>(() =>
    existing ? structuredClone(existing) : blankItem(route.newType ?? CipherType.Login, initialAccount, route.prefill),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origPassword = existing?.login?.password ?? "";

  const set = (patch: Partial<ItemView>) => setItem((i) => ({ ...i, ...patch }));
  const setLogin = (patch: Partial<NonNullable<ItemView["login"]>>) => setItem((i) => ({ ...i, login: { ...i.login!, ...patch } }));
  // where the login is filled (all websites at once, or individually per website)
  const [customScope, setCustomScope] = useState(() => scopeOf(item.login?.uris ?? []) === "custom");
  const fillScope: FillScope = customScope ? "custom" : scopeOf(item.login?.uris ?? []);
  const defaultMatch = (app.accountMap.get(item.accountKey)?.policies?.uriMatch ?? app.state.settings.defaultUriMatch) as UriMatch;
  const setSub = (k: "card" | "identity" | "sshKey" | "extra", field: string, v: string) =>
    setItem((i) => ({ ...i, [k]: { ...(i[k] ?? {}), [field]: v } }));

  const folders = useMemo(
    () => app.vault.folders.filter((f) => f.accountKey === item.accountKey).sort((a, b) => a.name.localeCompare(b.name, "de")),
    [app.vault, item.accountKey],
  );
  const orgs = app.vault.organizations.filter((o) => o.accountKey === item.accountKey);
  // organization policies: "remove individual vault" and "restricted item types"
  const pol = app.accountMap.get(item.accountKey)?.policies;
  const personalAllowed = !isNew || (!pol?.dataOwnership && !isRestricted(pol, item.type, null));
  const orgAllowed = (id: string) => !isNew || !isRestricted(pol, item.type, id);
  useEffect(() => {
    if (isNew && !personalAllowed && !item.organizationId) {
      const o = orgs.find((x) => orgAllowed(x.id));
      if (o) set({ organizationId: o.id, collectionIds: [] });
    }
  }, [item.accountKey, orgs.length]);
  const collections = app.vault.collections.filter(
    (c) => c.accountKey === item.accountKey && c.organizationId === item.organizationId && (!c.readOnly || c.manage),
  );

  async function newFolder() {
    const name = await dialogs.prompt({ title: t("Neuer Ordner"), label: t("Name"), okLabel: t("Erstellen") });
    if (!name) return;
    const r = await call("createFolder", { accountKey: item.accountKey, name });
    if (r.ok && r.id) {
      await app.reloadVault();
      set({ folderId: r.id });
    } else toast.show(r.error ?? t("Ordner konnte nicht erstellt werden"), "error");
  }

  async function save() {
    setError(null);
    if (!item.name.trim()) {
      setError(t("Bitte einen Namen eingeben."));
      return;
    }
    if (!item.accountKey) {
      setError(t("Bitte ein Konto wählen."));
      return;
    }
    if (isNew && !item.organizationId && !personalAllowed) {
      setError(t("Eine Richtlinie deiner Organisation verlangt, dass neue Einträge in der Organisation gespeichert werden."));
      return;
    }
    if (isNew && item.organizationId && !item.collectionIds.length) {
      setError(t("Bitte mindestens eine Sammlung auswählen."));
      return;
    }
    const out: ItemView = structuredClone(item);
    if (out.login) {
      out.login.uris = out.login.uris.filter((u) => u.uri.trim());
      if (!isNew && origPassword && out.login.password !== origPassword) {
        out.passwordHistory = [{ password: origPassword, lastUsedDate: new Date().toISOString() }, ...out.passwordHistory].slice(0, 5);
        out.login.passwordRevisionDate = new Date().toISOString();
      }
    }
    setBusy(true);
    try {
      const r = await call("saveItem", { accountKey: out.accountKey, item: out, isNew });
      if (!r.ok || !r.item) {
        setError(r.error ?? t("Speichern fehlgeschlagen"));
        return;
      }
      toast.show(isNew ? t("Eintrag erstellt") : t("Gespeichert"));
      await app.reloadVault();
      app.go({ name: "item", key: itemKey(r.item) }, true);
    } finally {
      setBusy(false);
    }
  }

  const strength = passwordStrength(item.login?.password ?? "");
  const strengthColor = ["transparent", "var(--danger)", "var(--warning)", "#4b9fe8", "var(--success)"][strength.score];

  return (
    <>
      <div class="topbar">
        <button class="icon-btn back" onClick={app.back} aria-label={t("Abbrechen")}>
          <Icon name="x" size={20} />
        </button>
        <h1>
          {isNew
            ? t("{type} hinzufügen", { type: inSentence(TYPE_LABEL[item.type]) })
            : t("{type} bearbeiten", { type: inSentence(TYPE_LABEL[item.type]) })}
        </h1>
      </div>
      <main>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          id="edit-form"
        >
          <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
            {isNew && unlocked.length > 1 && (
              <Field label={t("Konto")} hint={t("In welchem Konto soll der Eintrag gespeichert werden?")}>
                <Select
                  value={item.accountKey}
                  onChange={(v) => set({ accountKey: v, folderId: null, organizationId: null, collectionIds: [] })}
                  testid="edit-account"
                >
                  {unlocked.map((a) => (
                    <option value={a.key} key={a.key} disabled={!canCreateIn(a, item.type, app.vault.organizations)}>
                      {a.label} ({a.serverLabel})
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {!isNew && unlocked.length > 1 && (
              <div class="hint" style={{ margin: "0 2px 10px" }}>
                {t("Konto:")} <b>{app.accountMap.get(item.accountKey)?.label}</b> · {app.accountMap.get(item.accountKey)?.serverLabel}
              </div>
            )}
            <Field label={t("Name")}>
              <TextInput value={item.name} onValue={(v) => set({ name: v })} autoFocus={isNew} name="item-name" data-testid="edit-name" />
            </Field>
            {(orgs.length > 0 || item.organizationId) && (
              <Field
                label={t("Besitzer")}
                hint={
                  isNew && !personalAllowed ? t("Persönlicher Tresor durch eine Richtlinie deiner Organisation deaktiviert") : undefined
                }
              >
                <Select
                  value={item.organizationId ?? ""}
                  onChange={(v) => isNew && set({ organizationId: v || null, collectionIds: [] })}
                  testid="edit-owner"
                >
                  <option value="" disabled={!personalAllowed}>
                    {t("Ich (persönlicher Tresor)")}
                  </option>
                  {orgs.map((o) => (
                    <option value={o.id} key={o.id} disabled={(!isNew && o.id !== item.organizationId) || !orgAllowed(o.id)}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {isNew && item.organizationId && (
              <Field label={t("Sammlungen")} group>
                <div class="card" style={{ padding: "4px 10px" }}>
                  {collections.length === 0 && <div class="muted small">{t("Keine beschreibbaren Sammlungen")}</div>}
                  {collections.map((c) => (
                    <label class="checkbox" key={c.id}>
                      <input
                        type="checkbox"
                        checked={item.collectionIds.includes(c.id)}
                        onChange={(e) =>
                          set({
                            collectionIds: (e.target as HTMLInputElement).checked
                              ? [...item.collectionIds, c.id]
                              : item.collectionIds.filter((x) => x !== c.id),
                          })
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}
            <Field label={t("Ordner")} group>
              <div class="row-gap">
                <div style={{ flex: 1 }}>
                  <Select value={item.folderId ?? ""} onChange={(v) => set({ folderId: v || null })} testid="edit-folder">
                    <option value="">{t("Kein Ordner")}</option>
                    {folders.map((f) => (
                      <option value={f.id} key={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <button type="button" class="icon-btn" title={t("Neuer Ordner")} onClick={newFolder}>
                  <Icon name="plus" size={18} />
                </button>
              </div>
            </Field>
          </div>

          {item.type === CipherType.Login && item.login && (
            <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
              <Field label={t("Benutzername")}>
                <TextInput
                  value={item.login.username ?? ""}
                  onValue={(v) => setLogin({ username: v })}
                  name="username"
                  autocomplete="off"
                  data-testid="edit-username"
                  suffix={
                    <button
                      type="button"
                      class="icon-btn sm"
                      title={t("Benutzernamen generieren")}
                      aria-label={t("Benutzernamen generieren")}
                      data-testid="username-generate"
                      onClick={async () => {
                        const site = item.login?.uris.find((u) => u.uri.trim())?.uri ?? "";
                        try {
                          const st = await loadGenState();
                          let v: string;
                          if (st.username.kind === "forwarded")
                            v = (await call("forwarderGenerate", { id: st.username.forwarder as any, website: site })).email;
                          else {
                            v = generateUsername(st.username, site);
                            call("generatorHistoryAdd", { value: v, kind: st.username.kind === "word" ? "username" : "email", site }).catch(
                              () => {},
                            );
                          }
                          setLogin({ username: v });
                        } catch (e: any) {
                          toast.show(e?.message ?? String(e), "error");
                        }
                      }}
                    >
                      <Icon name="wand" size={16} />
                    </button>
                  }
                />
              </Field>
              <Field label={t("Passwort")}>
                <PasswordInput
                  value={item.login.password ?? ""}
                  onValue={(v) => setLogin({ password: v })}
                  autocomplete="new-password"
                  extra={
                    <button
                      type="button"
                      class="icon-btn sm"
                      title={t("Passwort generieren")}
                      aria-label={t("Passwort generieren")}
                      onClick={async () => {
                        if (item.login?.password) {
                          const ok = await dialogs.confirm({
                            title: t("Passwort ersetzen?"),
                            message: t("Das aktuelle Passwort wird durch ein neu generiertes ersetzt."),
                            okLabel: t("Ersetzen"),
                          });
                          if (!ok) return;
                        }
                        // same options as in the generator (password or passphrase), recorded in the history
                        const pw = await generateWithSavedOptions();
                        setLogin({ password: pw });
                        call("generatorHistoryAdd", { value: pw, kind: "password", site: item.name || undefined }).catch(() => {});
                      }}
                    >
                      <Icon name="refresh" size={16} />
                    </button>
                  }
                />
                {item.login.password && (
                  <>
                    <div class="strength">
                      <div style={{ width: strength.score * 25 + "%", background: strengthColor }} />
                    </div>
                    <div class="hint">{strength.label}</div>
                  </>
                )}
              </Field>
              {item.login.passkeys > 0 && (
                <div class="field" data-testid="edit-passkey">
                  <span class="lbl">{t("Passkey")}</span>
                  <div class="row-gap" style={{ gap: 8 }}>
                    <Icon name="passkey" size={16} />
                    <span class="grow" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {item.login.fido2?.[0]
                        ? `${item.login.fido2[0].userName || "Passkey"} · ${item.login.fido2[0].rpId}`
                        : t("Passkey gespeichert")}
                    </span>
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      style={{ color: "var(--danger)" }}
                      onClick={async () => {
                        const ok = await dialogs.confirm({
                          title: t("Passkey entfernen?"),
                          message: t(
                            "Der Passkey wird beim Speichern aus diesem Eintrag gelöscht. Die Anmeldung damit ist danach nicht mehr möglich.",
                          ),
                          okLabel: t("Entfernen"),
                          danger: true,
                        });
                        if (ok) setLogin({ passkeys: 0, fido2: [] });
                      }}
                    >
                      {t("Entfernen")}
                    </button>
                  </div>
                </div>
              )}
              <Field label={t("Authenticator-Schlüssel (TOTP)")} hint={t("Base32-Schlüssel oder otpauth://-URI")}>
                <TextInput
                  value={item.login.totp ?? ""}
                  onValue={(v) => setLogin({ totp: v })}
                  mono
                  autocomplete="off"
                  name="totp"
                  suffix={
                    <button
                      type="button"
                      class="icon-btn sm"
                      title={t("QR-Code auf der aktuellen Seite scannen")}
                      aria-label={t("QR-Code auf der aktuellen Seite scannen")}
                      data-testid="totp-scan"
                      onClick={async () => {
                        try {
                          const v = await scanTotpQr();
                          if (!v) toast.show(t("Kein QR-Code für einen Authenticator auf der Seite gefunden"), "error");
                          else {
                            setLogin({ totp: v });
                            toast.show(t("Authenticator-Schlüssel übernommen"));
                          }
                        } catch (e: any) {
                          toast.show(e?.message ?? String(e), "error");
                        }
                      }}
                    >
                      <Icon name="qr" size={16} />
                    </button>
                  }
                />
              </Field>
              <div class="field">
                <span class="lbl">{t("Websites")}</span>
                {item.login.uris.map((u, idx) => (
                  <div class="uri-row" key={idx}>
                    <TextInput
                      value={u.uri}
                      onValue={(v) => setLogin({ uris: item.login!.uris.map((x, i) => (i === idx ? { ...x, uri: v } : x)) })}
                      placeholder={t("https://example.de")}
                      data-testid="edit-uri"
                    />
                    {fillScope === "custom" && (
                      <div style={{ width: 112 }}>
                        <Select
                          value={u.match == null ? "" : String(u.match)}
                          testid="edit-uri-match"
                          onChange={(v) =>
                            setLogin({
                              uris: item.login!.uris.map((x, i) => (i === idx ? { ...x, match: v === "" ? null : Number(v) } : x)),
                            })
                          }
                        >
                          {MATCH_LABELS.map(([v, l]) => (
                            <option value={v} key={v}>
                              {t(l)}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                    <button
                      type="button"
                      class="icon-btn sm"
                      title={t("Entfernen")}
                      onClick={() => setLogin({ uris: item.login!.uris.filter((_, i) => i !== idx) })}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  onClick={() => setLogin({ uris: [...item.login!.uris, { uri: "", match: matchForNew(fillScope) }] })}
                >
                  <Icon name="plus" size={14} />
                  {t("Website hinzufügen")}
                </button>
              </div>
              <Field label={t("Ausfüllen auf")}>
                <Select
                  value={fillScope}
                  testid="fill-scope"
                  onChange={(v) => {
                    const scope = v as FillScope;
                    setCustomScope(scope === "custom");
                    setLogin({ uris: withScope(item.login!.uris, scope) });
                  }}
                >
                  <option value="default">
                    {t("Standard: {v}", { v: t(MATCH_LABELS.find(([v]) => v === String(defaultMatch))?.[1] ?? "") })}
                  </option>
                  {scopeChoices(item.login.uris, fillScope).includes("domain") && (
                    <option value="domain">{domainLabel(item.login.uris)}</option>
                  )}
                  <option value="host">{hostLabel(item.login.uris)}</option>
                  <option value="custom">{t("Individuell je Website")}</option>
                </Select>
              </Field>
            </div>
          )}

          {item.type === CipherType.Card && (
            <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
              <Field label={t("Karteninhaber")}>
                <TextInput
                  value={item.card?.cardholderName ?? ""}
                  onValue={(v) => setSub("card", "cardholderName", v)}
                  autocomplete="off"
                />
              </Field>
              <Field label={t("Kartennummer")}>
                <TextInput
                  value={item.card?.number ?? ""}
                  onValue={(v) => {
                    setSub("card", "number", v);
                    const b = cardBrandFromNumber(v);
                    if (b && !item.card?.brand) setSub("card", "brand", b);
                  }}
                  mono
                  inputMode="numeric"
                  autocomplete="off"
                />
              </Field>
              <Field label={t("Marke")}>
                <Select value={item.card?.brand ?? ""} onChange={(v) => setSub("card", "brand", v)}>
                  <option value="">–</option>
                  {BRANDS.map((b) => (
                    <option value={b} key={b}>
                      {b === "Other" ? t("Andere") : b}
                    </option>
                  ))}
                </Select>
              </Field>
              <div class="row-gap" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <Field label={t("Ablaufmonat")}>
                    <Select value={item.card?.expMonth ?? ""} onChange={(v) => setSub("card", "expMonth", v)}>
                      <option value="">–</option>
                      {Array.from({ length: 12 }, (_, i) => (
                        <option value={String(i + 1)} key={i}>
                          {String(i + 1).padStart(2, "0")}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={t("Ablaufjahr")}>
                    <TextInput
                      value={item.card?.expYear ?? ""}
                      onValue={(v) => setSub("card", "expYear", v)}
                      inputMode="numeric"
                      placeholder="2030"
                    />
                  </Field>
                </div>
              </div>
              <Field label={t("Prüfnummer")}>
                <PasswordInput value={item.card?.code ?? ""} onValue={(v) => setSub("card", "code", v)} autocomplete="off" />
              </Field>
            </div>
          )}

          {item.type === CipherType.Identity && (
            <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
              {IDENTITY_FIELDS.map((f) => (
                <FieldEditor key={f.key} def={f} value={item.identity?.[f.key] ?? ""} onValue={(v) => setSub("identity", f.key, v)} />
              ))}
            </div>
          )}

          {EXTRA_FIELDS[item.type] && (
            <div class="detail-card" style={{ padding: "12px 12px 2px" }} data-testid="extra-fields">
              {EXTRA_FIELDS[item.type].map((f) => (
                <FieldEditor key={f.key} def={f} value={item.extra?.[f.key] ?? ""} onValue={(v) => setSub("extra", f.key, v)} />
              ))}
            </div>
          )}

          {item.type === CipherType.SshKey && (
            <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
              {(
                [
                  ["privateKey", t("Privater Schlüssel")],
                  ["publicKey", t("Öffentlicher Schlüssel")],
                  ["keyFingerprint", t("Fingerabdruck")],
                ] as [string, string][]
              ).map(([k, l]) => (
                <Field label={l} key={k}>
                  <div class="input-wrap">
                    <textarea
                      class="mono"
                      rows={k === "privateKey" ? 5 : 2}
                      value={item.sshKey?.[k] ?? ""}
                      onInput={(e) => setSub("sshKey", k, (e.target as HTMLTextAreaElement).value)}
                      spellcheck={false}
                    />
                  </div>
                </Field>
              ))}
            </div>
          )}

          <div class="detail-card" style={{ padding: "12px 12px 2px" }}>
            <Field label={t("Notizen")}>
              <div class="input-wrap">
                <textarea
                  rows={item.type === CipherType.SecureNote ? 8 : 3}
                  value={item.notes ?? ""}
                  onInput={(e) => set({ notes: (e.target as HTMLTextAreaElement).value })}
                  data-testid="edit-notes"
                />
              </div>
            </Field>
          </div>

          <div class="detail-card" style={{ padding: "12px 12px 6px" }}>
            <span class="lbl" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-muted)" }}>
              {t("Benutzerdefinierte Felder")}
            </span>
            {item.fields.map((f, idx) => (
              <div key={idx} style={{ margin: "8px 0", paddingBottom: 8, borderBottom: "1px solid var(--border-soft)" }}>
                <div class="row-gap" style={{ marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <TextInput
                      value={f.name}
                      placeholder={t("Name")}
                      onValue={(v) => set({ fields: item.fields.map((x, i) => (i === idx ? { ...x, name: v } : x)) })}
                    />
                  </div>
                  <div style={{ width: 118 }}>
                    <Select
                      value={String(f.type)}
                      onChange={(v) => set({ fields: item.fields.map((x, i) => (i === idx ? { ...x, type: Number(v) } : x)) })}
                    >
                      <option value={String(FieldType.Text)}>{t("Text")}</option>
                      <option value={String(FieldType.Hidden)}>{t("Verborgen")}</option>
                      <option value={String(FieldType.Boolean)}>{t("Kontrollkästchen")}</option>
                      {f.type === FieldType.Linked && <option value={String(FieldType.Linked)}>{t("Verknüpft")}</option>}
                    </Select>
                  </div>
                  <button
                    type="button"
                    class="icon-btn sm"
                    title={t("Feld entfernen")}
                    onClick={() => set({ fields: item.fields.filter((_, i) => i !== idx) })}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
                {f.type === FieldType.Boolean ? (
                  <label class="checkbox">
                    <input
                      type="checkbox"
                      checked={f.value === "true"}
                      onChange={(e) =>
                        set({
                          fields: item.fields.map((x, i) =>
                            i === idx ? { ...x, value: String((e.target as HTMLInputElement).checked) } : x,
                          ),
                        })
                      }
                    />
                    {t("Wert")}
                  </label>
                ) : f.type === FieldType.Hidden ? (
                  <PasswordInput
                    value={f.value}
                    onValue={(v) => set({ fields: item.fields.map((x, i) => (i === idx ? { ...x, value: v } : x)) })}
                    autocomplete="off"
                  />
                ) : f.type === FieldType.Text ? (
                  <TextInput
                    value={f.value}
                    placeholder={t("Wert")}
                    onValue={(v) => set({ fields: item.fields.map((x, i) => (i === idx ? { ...x, value: v } : x)) })}
                  />
                ) : null}
              </div>
            ))}
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => set({ fields: [...item.fields, { name: "", value: "", type: FieldType.Text }] })}
            >
              <Icon name="plus" size={14} />
              {t("Feld hinzufügen")}
            </button>
          </div>

          <div class="detail-card">
            <div class="settings-row">
              <div class="grow">{t("Favorit")}</div>
              <Switch checked={item.favorite} onChange={(v) => set({ favorite: v })} label={t("Favorit")} />
            </div>
            <div class="settings-row">
              <div class="grow">
                {t("Master-Passwort erneut abfragen")}
                <div class="desc">{t("Vor dem Anzeigen oder Ausfüllen nachfragen")}</div>
              </div>
              <Switch
                checked={item.reprompt === 1}
                onChange={(v) => set({ reprompt: v ? 1 : 0 })}
                label={t("Master-Passwort erneut abfragen")}
              />
            </div>
            {item.type === CipherType.Login && item.login && app.state.settings.autofillOnPageLoad && (
              <div class="settings-row">
                <div class="grow">
                  {t("Beim Laden der Seite ausfüllen")}
                  <div class="desc">
                    {t("Standard: {v}", {
                      v: app.state.settings.autofillOnPageLoadDefault ? t("ausfüllen") : t("nicht ausfüllen"),
                    })}
                  </div>
                </div>
                <select
                  class="input"
                  style={{ width: "auto" }}
                  data-testid="autofill-on-load"
                  value={item.login.autofillOnPageLoad == null ? "" : item.login.autofillOnPageLoad ? "1" : "0"}
                  onChange={(e) => {
                    const v = (e.currentTarget as HTMLSelectElement).value;
                    setLogin({ autofillOnPageLoad: v === "" ? null : v === "1" });
                  }}
                >
                  <option value="">{t("Standard")}</option>
                  <option value="1">{t("Ja")}</option>
                  <option value="0">{t("Nein")}</option>
                </select>
              </div>
            )}
          </div>
          {error && <div class="banner error">{error}</div>}
        </form>
      </main>
      <div class="footer-bar">
        <button class="btn btn-primary" type="submit" form="edit-form" disabled={busy} data-testid="save">
          {busy && <Spinner />}
          {t("Speichern")}
        </button>
        <button class="btn btn-ghost" onClick={app.back}>
          {t("Abbrechen")}
        </button>
      </div>
    </>
  );
}

function FieldEditor({ def, value, onValue }: { def: FieldDef; value: string; onValue: (v: string) => void }) {
  const label = t(def.label);
  if (def.input === "select")
    return (
      <Field label={label}>
        <Select value={value} onChange={onValue} testid={"field-" + def.key}>
          <option value="">–</option>
          {def.options!.map(([v, l]) => (
            <option value={v} key={v}>
              {t(l)}
            </option>
          ))}
        </Select>
      </Field>
    );
  if (def.secret)
    return (
      <Field label={label}>
        <PasswordInput value={value} onValue={onValue} autocomplete="off" name={"field-" + def.key} />
      </Field>
    );
  return (
    <Field label={label}>
      <TextInput
        value={value}
        onValue={onValue}
        autocomplete="off"
        type={def.input === "date" ? "date" : def.input === "email" ? "email" : def.input === "tel" ? "tel" : "text"}
        mono={def.mono}
        name={"field-" + def.key}
      />
    </Field>
  );
}
