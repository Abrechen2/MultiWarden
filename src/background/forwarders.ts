// API calls of the email forwarding services (create a new alias).
import { ForwarderId, ForwarderSettings, forwarderMeta } from "../shared/forwarders";
import { t } from "../shared/i18n";

function hostnameOf(website: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : "https://" + website).hostname;
  } catch {
    return website;
  }
}

async function call(url: string, init: RequestInit, name: string): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", credentials: "omit" });
  } catch {
    throw new Error(t("{service} ist nicht erreichbar", { service: name }));
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 401 || res.status === 403) throw new Error(t("{service}: Zugriffstoken ungültig", { service: name }));
  if (res.status < 200 || res.status >= 300) {
    const msg = json?.error ?? json?.message ?? json?.detail ?? "";
    throw new Error(
      t("{service}: Fehler {status}", { service: name, status: res.status }) + (msg ? " – " + String(msg).slice(0, 200) : ""),
    );
  }
  return { status: res.status, json };
}

/** Creates a new forwarding address for `website` and returns it. */
export async function createAlias(id: ForwarderId, s: ForwarderSettings, website: string): Promise<string> {
  const meta = forwarderMeta(id);
  if (!meta) throw new Error(t("Unbekannter Weiterleitungsdienst"));
  for (const r of meta.required)
    if (!s[r]?.trim()) throw new Error(t("{service}: Bitte zuerst die Zugangsdaten eintragen", { service: meta.name }));
  const base = (s.baseUrl?.trim() || meta.defaultBaseUrl).replace(/\/+$/, "");
  const host = website ? hostnameOf(website) : "";
  const generatedBy = host ? t("Website: {site}. Erstellt von MultiWarden.", { site: host }) : t("Erstellt von MultiWarden.");
  const json = { "Content-Type": "application/json", Accept: "application/json" };
  const token = s.token!.trim();
  switch (id) {
    case "addyio": {
      const r = await call(
        base + "/api/v1/aliases",
        {
          method: "POST",
          headers: { ...json, Authorization: "Bearer " + token, "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify({ domain: s.domain!.trim(), description: generatedBy.slice(0, 200) }),
        },
        meta.name,
      );
      return need(r.json?.data?.email, meta.name);
    }
    case "duckduckgo": {
      const r = await call(
        base + "/email/addresses",
        { method: "POST", headers: { ...json, Authorization: "Bearer " + token } },
        meta.name,
      );
      return need(r.json?.address ? r.json.address + "@duck.com" : "", meta.name);
    }
    case "firefoxrelay": {
      const r = await call(
        base + "/v1/relayaddresses/",
        {
          method: "POST",
          headers: { ...json, Authorization: "Token " + token },
          body: JSON.stringify({ enabled: true, generated_for: (website || "").slice(0, 255), description: generatedBy.slice(0, 64) }),
        },
        meta.name,
      );
      return need(r.json?.full_address, meta.name);
    }
    case "forwardemail": {
      const domain = s.domain!.trim();
      const r = await call(
        `${base}/v1/domains/${encodeURIComponent(domain)}/aliases`,
        {
          method: "POST",
          headers: { ...json, Authorization: "Basic " + btoa(token + ":") },
          body: JSON.stringify({ labels: host, description: generatedBy }),
        },
        meta.name,
      );
      return need(r.json?.name ? `${r.json.name}@${r.json.domain?.name ?? domain}` : "", meta.name);
    }
    case "simplelogin": {
      const url = base + "/api/alias/random/new" + (host ? "?hostname=" + encodeURIComponent(host) : "");
      const r = await call(
        url,
        { method: "POST", headers: { ...json, Authentication: token }, body: JSON.stringify({ note: generatedBy }) },
        meta.name,
      );
      return need(r.json?.alias, meta.name);
    }
    case "fastmail": {
      const auth = { Authorization: "Bearer " + token };
      const sess = await call(base + "/jmap/session", { headers: { ...json, ...auth } }, meta.name);
      const accountId = sess.json?.primaryAccounts?.["https://www.fastmail.com/dev/maskedemail"];
      if (!accountId) throw new Error(t("{service}: Konto unterstützt keine maskierten E-Mail-Adressen", { service: meta.name }));
      const r = await call(
        base + "/jmap/api/",
        {
          method: "POST",
          headers: { ...json, ...auth },
          body: JSON.stringify({
            using: ["https://www.fastmail.com/dev/maskedemail", "urn:ietf:params:jmap:core"],
            methodCalls: [
              [
                "MaskedEmail/set",
                {
                  accountId,
                  create: {
                    "new-masked-email": {
                      state: "enabled",
                      description: "",
                      forDomain: website || "",
                      emailPrefix: s.prefix?.trim() || "",
                    },
                  },
                },
                "0",
              ],
            ],
          }),
        },
        meta.name,
      );
      const resp = r.json?.methodResponses?.[0];
      if (resp?.[0] === "MaskedEmail/set") {
        const email = resp[1]?.created?.["new-masked-email"]?.email;
        if (email) return email;
        const err = resp[1]?.notCreated?.["new-masked-email"]?.description;
        if (err) throw new Error(`${meta.name}: ${err}`);
      } else if (resp?.[0] === "error") throw new Error(`${meta.name}: ${resp[1]?.description ?? t("Fehler")}`);
      return need("", meta.name);
    }
  }
}

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(t("{service} hat keine Adresse geliefert", { service: name }));
  return v;
}
