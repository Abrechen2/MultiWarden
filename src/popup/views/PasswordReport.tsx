// Password report of one account: weak, reused and exposed passwords, logins on unencrypted
// websites, and logins without two-step login although the website offers it.
import { useMemo, useState } from "preact/hooks";
import { t } from "../../shared/i18n";
import { strengthScore, userWords } from "../../shared/strength";
import { CipherType, ItemView } from "../../shared/types";
import { baseDomain, hostnameOf } from "../../shared/uri";
import { useApp } from "../app-state";
import { ItemIcon, Spinner } from "../components";
import { Icon } from "../icons";
import { itemKey } from "../util";
import { exposedCount } from "./ItemDetail";
import { AccountSelect, useToolAccount } from "./tool-account";

// results of the online checks stay for the life of the popup
const exposedCache = new Map<string, number>();
let tfaDomains: Set<string> | null = null;
const tfaDocs = new Map<string, string>();

function hostsOf(i: ItemView): string[] {
  return (i.login?.uris ?? []).map((u) => hostnameOf(u.uri.trim()) ?? "").filter(Boolean);
}

/** logins whose password the user may see */
function reportable(items: ItemView[]): ItemView[] {
  return items.filter((i) => i.type === CipherType.Login && !i.deletedDate && !i.decryptError && i.viewPassword && !!i.login?.password);
}

async function load2faDirectory(): Promise<Set<string>> {
  if (tfaDomains) return tfaDomains;
  const res = await fetch("https://api.2fa.directory/v3/totp.json", { credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new Error(t("Prüfung fehlgeschlagen (HTTP {status})", { status: res.status }));
  const data = (await res.json()) as [string, { domain?: string; "additional-domains"?: string[]; documentation?: string }][];
  const set = new Set<string>();
  for (const [, v] of data) {
    for (const d of [v.domain, ...(v["additional-domains"] ?? [])]) {
      if (!d) continue;
      set.add(d.toLowerCase());
      if (v.documentation) tfaDocs.set(d.toLowerCase(), v.documentation);
    }
  }
  tfaDomains = set;
  return set;
}

/** the host or one of its parent domains is listed (login.example.com → example.com) */
function tfaMatch(i: ItemView, set: Set<string>): string | null {
  for (const h of hostsOf(i)) {
    const labels = h.replace(/^www\./, "").split(".");
    for (let k = 0; k < labels.length - 1; k++) {
      const d = labels.slice(k).join(".");
      if (set.has(d)) return d;
    }
  }
  return null;
}

type SectionId = "weak" | "reused" | "exposed" | "http" | "tfa";

export function PasswordReportTool() {
  const app = useApp();
  const [accountKey, setAccountKey, accounts] = useToolAccount();
  const [open, setOpen] = useState<Record<string, boolean>>({ weak: true, reused: true, exposed: true, http: true, tfa: true });
  const [exposedState, setExposedState] = useState<"idle" | "busy" | "done" | string>(() => "idle");
  const [progress, setProgress] = useState(0);
  const [, rerender] = useState(0);
  const [tfaState, setTfaState] = useState<"idle" | "busy" | "done" | string>(() => (tfaDomains ? "done" : "idle"));

  const items = useMemo(() => reportable(app.vault.items.filter((i) => i.accountKey === accountKey)), [app.vault, accountKey]);
  const acc = app.accountMap.get(accountKey);

  const weak = useMemo(
    () =>
      items
        .map((i) => ({
          item: i,
          score: strengthScore(
            i.login!.password!,
            userWords([i.login?.username, acc?.email, i.name, ...hostsOf(i).map((h) => baseDomain(h) ?? h)]),
          ),
        }))
        .filter((x) => x.score <= 2)
        .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name)),
    [items, acc?.email],
  );
  const reused = useMemo(() => {
    const by = new Map<string, ItemView[]>();
    for (const i of items) by.set(i.login!.password!, [...(by.get(i.login!.password!) ?? []), i]);
    return [...by.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  }, [items]);
  const http = useMemo(() => items.filter((i) => (i.login?.uris ?? []).some((u) => /^http:\/\//i.test(u.uri.trim()))), [items]);
  const exposed = items
    .map((i) => ({ item: i, n: exposedCache.get(i.login!.password!) }))
    .filter((x) => (x.n ?? 0) > 0)
    .sort((a, b) => (b.n ?? 0) - (a.n ?? 0));
  const allChecked = items.every((i) => exposedCache.has(i.login!.password!));
  const tfa = tfaDomains
    ? items
        .filter((i) => !i.login?.totp)
        .map((i) => ({ item: i, domain: tfaMatch(i, tfaDomains!) }))
        .filter((x) => x.domain)
    : [];

  const runExposed = async () => {
    setExposedState("busy");
    const unique = [...new Set(items.map((i) => i.login!.password!))].filter((p) => !exposedCache.has(p));
    let done = 0;
    setProgress(0);
    try {
      const queue = [...unique];
      const worker = async () => {
        while (queue.length) {
          const pw = queue.shift()!;
          exposedCache.set(pw, await exposedCount(pw));
          done++;
          setProgress(done / unique.length);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
      setExposedState("done");
    } catch (e: any) {
      setExposedState(e?.message ?? String(e));
    }
    rerender((x) => x + 1);
  };

  const runTfa = async () => {
    setTfaState("busy");
    try {
      await load2faDirectory();
      setTfaState("done");
    } catch (e: any) {
      setTfaState(e?.message ?? String(e));
    }
  };

  if (!accounts.length) return <div class="empty">{t("Keine entsperrten Konten.")}</div>;

  const Row = ({ i, info, warn }: { i: ItemView; info?: string; warn?: string }) => (
    <div
      class="row"
      role="button"
      tabIndex={0}
      onClick={() => app.go({ name: "item", key: itemKey(i) })}
      data-testid="report-item"
      data-name={i.name}
    >
      <ItemIcon item={i} acc={app.accountMap.get(i.accountKey)} favicons={app.state.settings.showFavicons} />
      <div class="text">
        <div class="title">
          <span class="t">{i.name}</span>
          {warn && <span class="pill warn">{warn}</span>}
        </div>
        <div class="subtitle">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{[i.login?.username, info].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
    </div>
  );

  const Section = ({
    id,
    title,
    count,
    desc,
    children,
  }: {
    id: SectionId;
    title: string;
    count: number | null;
    desc: string;
    children: any;
  }) => (
    <section class="report-section" data-testid={"report-" + id}>
      <button class="report-head" onClick={() => setOpen({ ...open, [id]: !open[id] })} aria-expanded={open[id]}>
        <span class="grow">{title}</span>
        {count != null && (
          <span class={"count" + (count > 0 ? " bad" : " ok")} data-testid={"report-count-" + id}>
            {count}
          </span>
        )}
        <Icon name={open[id] ? "chevronDown" : "chevronRight"} size={16} />
      </button>
      {open[id] && (
        <>
          <div class="muted small report-desc">{desc}</div>
          {children}
        </>
      )}
    </section>
  );

  return (
    <div data-testid="password-report">
      <div class="tool-intro muted small">
        {t("Prüft die Logins eines Kontos auf Schwachstellen. Die Auswertung läuft auf deinem Gerät.")}
      </div>
      <div class="tool-controls">
        {accounts.length > 1 && <AccountSelect value={accountKey} onChange={setAccountKey} accounts={accounts} />}
      </div>

      <Section
        id="weak"
        title={t("Schwache Passwörter")}
        count={weak.length}
        desc={t("Leicht zu erratende Passwörter, z. B. kurze, bekannte Wörter, Jahreszahlen oder Teile von Benutzername und Website.")}
      >
        {weak.length > 0 && (
          <div class="card">
            {weak.map((x) => (
              <Row key={itemKey(x.item)} i={x.item} warn={x.score <= 1 ? t("Schwach") : t("Mittel")} />
            ))}
          </div>
        )}
      </Section>

      <Section
        id="reused"
        title={t("Mehrfach verwendete Passwörter")}
        count={reused.reduce((n, g) => n + g.length, 0)}
        desc={t("Dasselbe Passwort für mehrere Logins: Wird es bei einer Website gestohlen, sind alle betroffen.")}
      >
        {reused.map((g, idx) => (
          <div class="card report-group" key={idx}>
            {g.map((i) => (
              <Row key={itemKey(i)} i={i} warn={t("{n}× verwendet", { n: g.length })} />
            ))}
          </div>
        ))}
      </Section>

      <Section
        id="exposed"
        title={t("Passwörter in Datenlecks")}
        count={allChecked && items.length ? exposed.length : null}
        desc={t("Abgleich mit Have I Been Pwned: Nur die ersten fünf Zeichen des SHA-1-Hashes jedes Passworts verlassen das Gerät.")}
      >
        {exposedState === "busy" ? (
          <div class="row-gap small muted report-action">
            <Spinner /> {t("Wird geprüft … {p} %", { p: Math.round(progress * 100) })}
          </div>
        ) : !allChecked || !items.length ? (
          <button
            class="btn btn-secondary btn-sm report-action"
            onClick={runExposed}
            disabled={!items.length}
            data-testid="report-exposed-run"
          >
            <Icon name="shield" size={15} />
            {t("Jetzt prüfen ({n} Passwörter)", { n: new Set(items.map((i) => i.login!.password!)).size })}
          </button>
        ) : null}
        {typeof exposedState === "string" && !["idle", "busy", "done"].includes(exposedState) && (
          <div class="banner error">{exposedState}</div>
        )}
        {exposed.length > 0 && (
          <div class="card">
            {exposed.map((x) => (
              <Row key={itemKey(x.item)} i={x.item} warn={t("{n}× gefunden", { n: (x.n ?? 0).toLocaleString() })} />
            ))}
          </div>
        )}
      </Section>

      <Section
        id="http"
        title={t("Unverschlüsselte Websites")}
        count={http.length}
        desc={t("Logins mit http://-Adresse: Die Zugangsdaten werden unverschlüsselt übertragen. Wenn möglich auf https:// ändern.")}
      >
        {http.length > 0 && (
          <div class="card">
            {http.map((i) => (
              <Row key={itemKey(i)} i={i} info={(i.login?.uris ?? []).find((u) => /^http:\/\//i.test(u.uri.trim()))?.uri} />
            ))}
          </div>
        )}
      </Section>

      <Section
        id="tfa"
        title={t("Zwei-Faktor nicht eingerichtet")}
        count={tfaDomains ? tfa.length : null}
        desc={t(
          "Websites, die eine Authenticator-App unterstützen, bei denen aber kein TOTP-Schlüssel gespeichert ist. Die Liste kommt von 2fa.directory.",
        )}
      >
        {tfaState === "busy" ? (
          <div class="row-gap small muted report-action">
            <Spinner /> {t("Liste wird geladen …")}
          </div>
        ) : !tfaDomains ? (
          <button class="btn btn-secondary btn-sm report-action" onClick={runTfa} data-testid="report-tfa-run">
            <Icon name="download" size={15} />
            {t("Liste von 2fa.directory laden")}
          </button>
        ) : null}
        {typeof tfaState === "string" && !["idle", "busy", "done"].includes(tfaState) && <div class="banner error">{tfaState}</div>}
        {tfa.length > 0 && (
          <div class="card">
            {tfa.map((x) => (
              <div class="report-tfa" key={itemKey(x.item)}>
                <Row i={x.item} info={x.domain!} />
                {tfaDocs.get(x.domain!) && (
                  <a class="btn btn-ghost btn-sm" href={tfaDocs.get(x.domain!)} target="_blank" rel="noopener noreferrer">
                    {t("Anleitung")}
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
