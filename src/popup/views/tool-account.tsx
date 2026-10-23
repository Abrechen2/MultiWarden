// Account chooser of the tools (each tool works within one account).
import { useState } from "preact/hooks";
import { t } from "../../shared/i18n";
import { useApp } from "../app-state";

/** Value of the account chooser that stands for every unlocked account (only with `allowAll`). */
export const ALL_ACCOUNTS = "*";

/**
 * Account chooser shared by the tools (each tool works within one account).
 * With `allowAll` the tool also accepts ALL_ACCOUNTS, which is the default while more than one account is unlocked.
 */
export function useToolAccount(allowAll = false): [string, (k: string) => void, { key: string; label: string }[]] {
  const app = useApp();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const single = app.filters.account && unlocked.some((a) => a.key === app.filters.account) ? app.filters.account : unlocked[0]?.key;
  const preferred = allowAll && unlocked.length > 1 ? ALL_ACCOUNTS : single;
  const [key, setKey] = useState<string>(preferred ?? "");
  const valid = unlocked.some((a) => a.key === key) || (allowAll && key === ALL_ACCOUNTS && unlocked.length > 1) ? key : (preferred ?? "");
  return [valid, setKey, unlocked.map((a) => ({ key: a.key, label: a.label }))];
}

export function AccountSelect({
  value,
  onChange,
  accounts,
  allowAll,
}: {
  value: string;
  onChange: (k: string) => void;
  accounts: { key: string; label: string }[];
  allowAll?: boolean;
}) {
  return (
    <label class="tool-account">
      <span>{t("Konto")}</span>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} data-testid="tool-account">
        {allowAll && <option value={ALL_ACCOUNTS}>{t("Alle Konten")}</option>}
        {accounts.map((a) => (
          <option value={a.key} key={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
