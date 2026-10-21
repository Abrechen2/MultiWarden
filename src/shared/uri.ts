import { getDomain, getHostname } from "tldts";
import { UriMatch } from "./types";

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

export function normalizeUri(uri: string): string {
  const u = uri.trim();
  if (!u) return u;
  if (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ||
    /^(about|data|javascript|mailto|chrome|moz-extension|chrome-extension|androidapp|iosapp):/i.test(u)
  )
    return u;
  return "http://" + u;
}

export function parseUrl(uri: string): URL | null {
  try {
    return new URL(normalizeUri(uri));
  } catch {
    return null;
  }
}

/**
 * Base ("registrable") domain, or hostname for IPs / single-label hosts. Private suffixes
 * (github.io, herokuapp.com, pages.dev, …) count as public: a.github.io and b.github.io belong
 * to different owners and must not share a base domain.
 */
export function baseDomain(uri: string): string | null {
  const u = parseUrl(uri);
  // still allows e.g. ftp://host; uriMatches() keeps app schemes away from web pages
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (!host) return null;
  if (IP_RE.test(host) || host === "localhost" || !host.includes(".")) return host;
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

const WEB_PROTOCOL = /^https?:$/;

/**
 * Web URIs (http/https, or no scheme) only match web pages; any other scheme (androidapp://,
 * iosapp://, ftp://, …) only matches the same scheme. Otherwise androidapp://com.foo.app would
 * match the website of whoever owns foo.app.
 */
export function sameSchemeKind(cipherUri: string, url: string): boolean {
  const cu = parseUrl(cipherUri);
  const tu = parseUrl(url);
  if (!cu || !tu) return false;
  const cw = WEB_PROTOCOL.test(cu.protocol);
  const tw = WEB_PROTOCOL.test(tu.protocol);
  return cw && tw ? true : !cw && !tw && cu.protocol === tu.protocol;
}

export function hostOf(uri: string): string | null {
  const u = parseUrl(uri);
  if (!u) return null;
  return u.host.toLowerCase();
}

export function hostnameOf(uri: string): string | null {
  const u = parseUrl(uri);
  if (u) return u.hostname.toLowerCase();
  return getHostname(uri);
}

export function displayHost(uri: string): string {
  const u = parseUrl(uri);
  return u ? u.hostname.replace(/^www\./, "") : uri;
}

export interface MatchContext {
  url: string;
  domain: string | null;
  host: string | null;
  equivalentDomains: Set<string>;
}

export function makeMatchContext(url: string, equivalents: string[][]): MatchContext {
  const domain = baseDomain(url);
  const eq = new Set<string>();
  if (domain) {
    eq.add(domain);
    for (const group of equivalents) {
      if (group.includes(domain)) group.forEach((d) => eq.add(d));
    }
  }
  return { url, domain, host: hostOf(url), equivalentDomains: eq };
}

export function uriMatches(cipherUri: string, match: UriMatch | null | undefined, ctx: MatchContext, defaultMatch: UriMatch): boolean {
  if (!cipherUri) return false;
  const m = match ?? defaultMatch;
  switch (m) {
    case UriMatch.Domain: {
      if (!ctx.domain) return false;
      const d = baseDomain(cipherUri);
      return !!d && ctx.equivalentDomains.has(d) && sameSchemeKind(cipherUri, ctx.url);
    }
    case UriMatch.Host: {
      const h = hostOf(cipherUri);
      return !!h && h === ctx.host && sameSchemeKind(cipherUri, ctx.url);
    }
    case UriMatch.StartsWith:
      return (
        sameSchemeKind(cipherUri, ctx.url) && (ctx.url.startsWith(normalizeUri(cipherUri)) || ctx.url.startsWith(cipherUri))
      );
    case UriMatch.Exact:
      return ctx.url === cipherUri || ctx.url === normalizeUri(cipherUri);
    case UriMatch.RegularExpression:
      try {
        return new RegExp(cipherUri, "i").test(ctx.url);
      } catch {
        return false;
      }
    case UriMatch.Never:
      return false;
  }
  return false;
}

export function isFillableUrl(url: string | undefined): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

/** Normalised host entry for the blocked-domains list ("https://www.x.de/a" → "www.x.de"). */
export function normalizeBlockedDomain(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const h = hostnameOf(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : "http://" + s);
  return h && /^[a-z0-9.\-\[\]:]+$/.test(h) ? h : null;
}

/** The page's host is on the blocked list (exact host or a subdomain of an entry). */
export function isBlockedUrl(url: string | undefined, blocked: string[] | undefined): boolean {
  if (!url || !blocked?.length) return false;
  const h = hostnameOf(url);
  if (!h) return false;
  return blocked.some((b) => h === b || h.endsWith("." + b));
}
