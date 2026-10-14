// Account chooser of the tools (each tool works within one account).
import { useState } from "preact/hooks";
import { t } from "../../shared/i18n";
import { useApp } from "../app-state";

/** Account chooser shared by the tools (each tool works within one account). */
export function useToolAccount(): [string, (k: string) => void, { key: string; label: string }[]] {
  const app = useApp();
  const unlocked = app.accounts.filter((a) => a.status === "unlocked");
  const preferred = app.filters.account && unlocked.some((a) => a.key === app.filters.account) ? app.filters.account : unlocked[0]?.key;
  const [key, setKey] = useState<string>(preferred ?? "");
  const valid = unlocked.some((a) => a.key === key) ? key : (preferred ?? "");
  return [valid, setKey, unlocked.map((a) => ({ key: a.key, label: a.label }))];
}

export function AccountSelect({
  value,
  onChange,
  accounts,
}: {
  value: string;
  onChange: (k: string) => void;
  accounts: { key: string; label: string }[];
}) {
  return (
    <label class="tool-account">
      <span>{t("Konto")}</span>
      <select value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)} data-testid="tool-account">
        {accounts.map((a) => (
          <option value={a.key} key={a.key}>
            {a.label}
          </option>
        ))}
      </select>
    </label>
  );
}
