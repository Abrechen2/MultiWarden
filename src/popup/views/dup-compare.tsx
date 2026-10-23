// Duplicate check: what is the same and what differs inside a group (summary + per-entry differences).
import { ItemEvidence } from "../../shared/dup-evidence";
import { FieldDiff } from "../../shared/duplicates";
import { t, tk } from "../../shared/i18n";
import { formatDate } from "../util";
import { EXTRA_FIELDS, IDENTITY_FIELDS } from "./item-fields";

const BASE_LABELS: Record<string, string> = {
  name: tk("Name"),
  username: tk("Benutzername"),
  password: tk("Passwort"),
  totp: tk("Authenticator-Schlüssel (TOTP)"),
  uris: tk("Websites"),
  passkeys: tk("Passkeys"),
  notes: tk("Notizen"),
  folder: tk("Ordner"),
  "card:cardholderName": tk("Karteninhaber"),
  "card:brand": tk("Marke"),
  "card:number": tk("Kartennummer"),
  "card:expMonth": tk("Ablaufmonat"),
  "card:expYear": tk("Ablaufjahr"),
  "card:code": tk("Prüfnummer"),
  "ssh:privateKey": tk("Privater Schlüssel"),
  "ssh:publicKey": tk("Öffentlicher Schlüssel"),
  "ssh:keyFingerprint": tk("Fingerabdruck"),
};

function fieldDef(key: string) {
  const [kind, k] = key.split(/:(.*)/s);
  if (kind === "identity") return IDENTITY_FIELDS.find((f) => f.key === k);
  if (kind === "extra") return Object.values(EXTRA_FIELDS).flat().find((f) => f.key === k);
  return undefined;
}

export function fieldLabel(key: string): string {
  if (BASE_LABELS[key]) return t(BASE_LABELS[key]);
  const def = fieldDef(key);
  if (def) return t(def.label);
  return key.replace(/^[a-z]+:/, ""); // custom field: its own name
}

/** The field definition may know a secret the generic comparison did not flag – never show its value then. */
const isSecret = (d: FieldDiff) => d.secret || !!fieldDef(d.key)?.secret;

/** Shown value of one entry: the text, a variant letter for secrets, or "leer". */
function shown(d: FieldDiff, idx: number): string {
  const v = d.variants[idx];
  if (v < 0) return t("leer");
  if (isSecret(d)) return t("Variante {v}", { v: String.fromCharCode(65 + (v % 26)) });
  return d.values[idx] ?? "";
}

export function DupCompareSummary({ diff }: { diff: FieldDiff[] }) {
  const differ = diff.filter((d) => !d.same);
  const same = diff.filter((d) => d.same);
  return (
    <div class="dup-compare" data-testid="dup-compare">
      {differ.length > 0 && (
        <div class="dup-differ" data-testid="dup-differ">
          <span class="dup-mark">≠</span>
          <span>
            <b>{t("Unterschiedlich")}:</b> {differ.map((d) => fieldLabel(d.key)).join(", ")}
          </span>
        </div>
      )}
      {same.length > 0 && (
        <div class="dup-same" data-testid="dup-same">
          <span class="dup-mark">=</span>
          <span>
            <b>{t("Gleich")}:</b> {same.map((d) => fieldLabel(d.key)).join(", ")}
          </span>
        </div>
      )}
    </div>
  );
}

/** The differing fields of one entry of the group. */
export function DupItemDiffs({ diff, idx }: { diff: FieldDiff[]; idx: number }) {
  const differ = diff.filter((d) => !d.same);
  if (!differ.length) return null;
  return (
    <div class="dup-diffs" data-testid="dup-diffs">
      {differ.map((d) => (
        <span class={"dup-diff" + (isSecret(d) ? " secret" : "")} key={d.key} title={shown(d, idx)}>
          <span class="k">{fieldLabel(d.key)}:</span> <span class="v">{shown(d, idx)}</span>
        </span>
      ))}
    </div>
  );
}

/** What is known about one entry of a group with differing passwords (dates, last use, login outcome, successor). */
export function DupEvidenceLine({ ev }: { ev: ItemEvidence }) {
  const at = (ms: number) => formatDate(new Date(ms).toISOString());
  const parts = [
    ev.passwordChanged &&
      (ev.passwordChangedIsCreation
        ? t("Angelegt {date}", { date: formatDate(ev.passwordChanged) })
        : t("Passwort geändert {date}", { date: formatDate(ev.passwordChanged) })),
    ev.lastUsed && t("Auf diesem Gerät zuletzt ausgefüllt {date}", { date: at(ev.lastUsed) }),
    ev.outcome &&
      (ev.outcome.ok
        ? t("Anmeldung erfolgreich {date}", { date: at(ev.outcome.at) })
        : t("Anmeldung fehlgeschlagen {date}", { date: at(ev.outcome.at) })),
    ev.supersededBy && t("Veraltet: Passwort steht im Verlauf von „{name}“", { name: ev.supersededBy.name }),
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div class="muted small" data-testid="dup-evidence">
      {parts.join(" · ")}
    </div>
  );
}
