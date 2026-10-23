// URI matching for self-hosted services: on IP addresses, localhost and single-label hosts the port
// identifies the service, so base-domain matching must not offer the login of another port. Matches
// are ranked so the most specific saved URI (path, then host with port) comes first.
import "./chrome-stub";
import { makeMatchContext, matchQuality, uriMatches } from "../src/shared/uri";
import { CipherType, UriMatch } from "../src/shared/types";
import { VaultService } from "../src/background/vault-service";
import { describeScope, scopeChoices } from "../src/popup/fill-scope";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const dom = (cipherUri: string, url: string) => uriMatches(cipherUri, null, makeMatchContext(url, []), UriMatch.Domain);

// base domain on IPs / localhost / single-label hosts: the port counts
check("IP same port", dom("https://192.168.178.36:5765", "https://192.168.178.36:5765/login") === true);
check("IP other port", dom("https://192.168.178.36:8080", "https://192.168.178.36:5765/login") === false);
check("IP default port vs explicit port", dom("http://192.168.178.36", "http://192.168.178.36:5765/") === false);
check("IP explicit port vs default port", dom("http://192.168.178.36:8080", "http://192.168.178.36/") === false);
check("IP default ports of http and https are one service", dom("http://192.168.178.36", "https://192.168.178.36/") === true);
check("IP without scheme, default port", dom("192.168.178.36", "https://192.168.178.36/Main") === true);
check("IP without scheme, explicit port", dom("192.168.178.36:5765", "https://192.168.178.36:5765/") === true);
check("IP without scheme, other port", dom("192.168.178.36:8080", "https://192.168.178.36:5765/") === false);
check("IPv6 other port", dom("http://[fd00::1]:8080", "http://[fd00::1]:9000/") === false);
check("IPv6 same port", dom("http://[fd00::1]:8080", "http://[fd00::1]:8080/") === true);
check("localhost other port", dom("http://localhost:3000", "http://localhost:8080/") === false);
check("single-label host other port", dom("http://unraid2:8080", "http://unraid2:9000/") === false);
check("single-label host same port", dom("http://unraid2:8080", "http://unraid2:8080/x") === true);
// normal domains keep Bitwarden's base-domain behaviour
check("domain other port still matches", dom("https://nas.example.de:8443", "https://nas.example.de:5001/") === true);
check("domain subdomain still matches", dom("https://example.de", "https://login.example.de/") === true);
// explicit match types are untouched
check(
  "Host match unchanged",
  uriMatches("https://192.168.178.36:8080", UriMatch.Host, makeMatchContext("https://192.168.178.36:5765/", []), UriMatch.Domain) ===
    false,
);
check(
  "StartsWith ignores the port rule only by its own logic",
  uriMatches("https://192.168.178.36:5765/app", UriMatch.StartsWith, makeMatchContext("https://192.168.178.36:5765/app/x", []), UriMatch.Domain),
);

// item view: an IP entry is filled on that host and port only, not "and all subdomains"
{
  const d = describeScope([{ uri: "https://192.168.178.36:5765/login" }], UriMatch.Domain);
  check("scope label of an IP entry names host and port", d === "Nur 192.168.178.36:5765", d);
  const n = describeScope([{ uri: "https://example.de" }], UriMatch.Domain);
  check("scope label of a domain unchanged", n === "example.de und alle Subdomains", n);
}

// edit dialog: on an IP entry "domain" and "host" mean the same, only "host" is offered
{
  const ip = [{ uri: "https://192.168.178.36:5765" }];
  const c = (uris: any[], cur: any) => JSON.stringify(scopeChoices(uris, cur));
  check("IP entry offers no separate domain scope", c(ip, "default") === JSON.stringify(["default", "host", "custom"]), c(ip, "default"));
  check("IP entry keeps a domain scope that is already set", c(ip, "domain") === JSON.stringify(["default", "domain", "host", "custom"]));
  check(
    "domain entry offers both",
    c([{ uri: "https://example.de" }], "default") === JSON.stringify(["default", "domain", "host", "custom"]),
  );
}

// ranking
const url = "https://wiki.example.de:8443/app/login?x=1";
const q = (u: string) => matchQuality(u, url);
check("exact URL ranks highest", q("https://wiki.example.de:8443/app/login?x=1") > q("https://wiki.example.de:8443/app"));
check("path prefix ranks above host", q("https://wiki.example.de:8443/app") > q("https://wiki.example.de:8443"));
check("host with port ranks above other port", q("https://wiki.example.de:8443") > q("https://wiki.example.de:9000"));
check("same hostname ranks above sibling subdomain", q("https://wiki.example.de:9000") > q("https://example.de"));
check("path prefix needs a segment boundary", q("https://wiki.example.de:8443/ap") === q("https://wiki.example.de:8443"));
check("no-scheme URI ranks like http(s)", q("wiki.example.de:8443/app") === q("https://wiki.example.de:8443/app"));

// matchesForUrl: most specific first, recency only breaks ties
(async () => {
  const item = (id: string, uri: string): any => ({
    accountKey: "a",
    id,
    name: id,
    type: CipherType.Login,
    login: { username: "u", password: "p", uris: [{ uri, match: null }] },
  });
  const svc: any = Object.create(VaultService.prototype);
  svc.ready = Promise.resolve();
  svc.settings = { defaultUriMatch: UriMatch.Domain };
  svc.accountPolicies = () => undefined;
  svc.defaultMatchFor = () => UriMatch.Domain;
  Object.defineProperty(svc, "sortedAccounts", { value: [{ key: "a" }] });
  const items = [item("domain", "https://example.de"), item("host", "https://wiki.example.de:8443"), item("path", "https://wiki.example.de:8443/app")];
  svc.ensureVault = async () => ({ items, equivalentDomains: [] });
  svc.lastUsed = new Map([["a", { domain: 3, host: 2, path: 1 }]]);
  const order = (await svc.matchesForUrl(url)).map((i: any) => i.id);
  check("matchesForUrl ranks by specificity before recency", JSON.stringify(order) === JSON.stringify(["path", "host", "domain"]), order);

  console.log(failed ? `${failed} FAILED` : "ALL PASSED");
  process.exit(failed ? 1 : 0);
})();
