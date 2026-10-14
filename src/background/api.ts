// HTTP layer for Bitwarden-compatible servers (Bitwarden cloud, self-hosted, Vaultwarden).
import { KdfConfig, KdfType } from "../crypto/bw";
import { serviceUrl } from "../shared/types";
import type { AccountRecord, ServerUrls } from "../shared/types";

import { t } from "../shared/i18n";
export const CLIENT_NAME = "browser";
export const CLIENT_VERSION = "2026.10.0";

export function camelize<T = any>(v: any): T {
  if (Array.isArray(v)) return v.map(camelize) as any;
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      const nk = k.length > 0 && /^[A-Z]/.test(k) ? k[0].toLowerCase() + k.slice(1) : k;
      out[nk] = camelize(val);
    }
    return out;
  }
  return v;
}

function ua(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "";
}

export function deviceType(): number {
  const u = ua();
  if (/Firefox\//.test(u)) return 3;
  if (/Edg\//.test(u)) return 5;
  if (/OPR\//.test(u)) return 4;
  if (/Vivaldi/.test(u)) return 19;
  return 2;
}

export function deviceName(): string {
  return ({ 2: "chrome", 3: "firefox", 4: "opera", 5: "edge", 19: "vivaldi" } as Record<number, string>)[deviceType()] ?? "chrome";
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: any,
    message: string,
  ) {
    super(message);
  }
}

export function errorMessage(status: number, body: any): string {
  const b = body ? camelize(body) : null;
  const m =
    b?.errorModel?.message ||
    b?.message ||
    b?.error_description ||
    (b?.validationErrors && Object.values(b.validationErrors as Record<string, string[]>).flat()[0]) ||
    b?.error;
  if (m && typeof m === "string") return m;
  if (status === 0) return t("Server nicht erreichbar");
  return t("HTTP-Fehler {status}", { status });
}

function baseHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Device-Type": String(deviceType()),
    "Bitwarden-Client-Name": CLIENT_NAME,
    "Bitwarden-Client-Version": CLIENT_VERSION,
  };
}

export async function httpJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { ...baseHeaders(), ...(init.headers ?? {}) },
      body: init.body,
      cache: "no-store",
      // like the official extension: lets cookies of auth proxies in front of self-hosted servers pass
      credentials: "include",
    });
  } catch (e) {
    throw new HttpError(0, null, t("Server nicht erreichbar: ") + new URL(url).host);
  }
  let json: any = null;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (text && (ct.includes("json") || /^[\[{]/.test(text.trim()))) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  } else if (text) {
    json = { message: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

export interface PreloginResult {
  kdf: KdfConfig;
  salt: string;
}

export async function prelogin(urls: ServerUrls, email: string): Promise<PreloginResult> {
  const body = JSON.stringify({ email });
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  const normEmail = email.trim().toLowerCase();

  // Newer endpoint returning an explicit salt
  try {
    const r = await httpJson(urls.identity + "/accounts/prelogin/password", { method: "POST", headers, body });
    if (r.status === 200 && r.json) {
      const j = camelize(r.json);
      if (j.kdfSettings) {
        return {
          kdf: {
            kdf: j.kdfSettings.kdfType,
            iterations: j.kdfSettings.iterations,
            memory: j.kdfSettings.memory ?? undefined,
            parallelism: j.kdfSettings.parallelism ?? undefined,
          },
          salt: j.salt || normEmail,
        };
      }
      if (j.kdf != null) return legacyPrelogin(j, normEmail);
    }
  } catch (e) {
    if (e instanceof HttpError && e.status === 0) throw e;
  }
  for (const base of [urls.identity, urls.api]) {
    const r = await httpJson(base + "/accounts/prelogin", { method: "POST", headers, body });
    if (r.status === 200 && r.json) return legacyPrelogin(camelize(r.json), normEmail);
    if (r.status !== 404 && r.status !== 405) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
  }
  throw new Error(t("Prelogin fehlgeschlagen – ist die Server-URL korrekt?"));
}

function legacyPrelogin(j: any, email: string): PreloginResult {
  return {
    kdf: {
      kdf: j.kdf ?? KdfType.PBKDF2_SHA256,
      iterations: j.kdfIterations ?? 600000,
      memory: j.kdfMemory ?? undefined,
      parallelism: j.kdfParallelism ?? undefined,
    },
    salt: email,
  };
}

export function formEncode(o: Record<string, string | number | undefined>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v)))
    .join("&");
}

export async function postToken(urls: ServerUrls, form: Record<string, string | number | undefined>) {
  return httpJson(urls.identity + "/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: formEncode(form),
  });
}

export function decodeJwt(token: string): any {
  try {
    const p = token.split(".")[1];
    const json = atob(p.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((p.length + 3) % 4));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return {};
  }
}

/** Authenticated API access for one account, with transparent token refresh. */
export class AccountApi {
  private refreshing: Promise<void> | null = null;

  constructor(
    private acc: AccountRecord,
    private onTokens: (acc: AccountRecord) => Promise<void>,
    private onLoggedOut: (acc: AccountRecord) => Promise<void>,
  ) {}

  async accessToken(): Promise<string> {
    const now = Date.now() / 1000;
    if (!this.acc.accessToken || !this.acc.accessTokenExp || this.acc.accessTokenExp - now < 120) {
      await this.refresh();
    }
    return this.acc.accessToken!;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.acc.refreshToken) {
        await this.onLoggedOut(this.acc);
        throw new HttpError(401, null, t("Sitzung abgelaufen – bitte neu anmelden"));
      }
      const r = await postToken(this.acc.urls, {
        grant_type: "refresh_token",
        client_id: this.acc.clientId || CLIENT_NAME,
        refresh_token: this.acc.refreshToken,
      });
      if (r.status !== 200) {
        if (r.status === 400 || r.status === 401) {
          await this.onLoggedOut(this.acc);
          throw new HttpError(401, r.json, t("Sitzung abgelaufen – bitte neu anmelden"));
        }
        throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
      }
      this.acc.accessToken = r.json.access_token;
      if (r.json.refresh_token) this.acc.refreshToken = r.json.refresh_token;
      const claims = decodeJwt(this.acc.accessToken!);
      this.acc.accessTokenExp = claims.exp ?? Date.now() / 1000 + (r.json.expires_in ?? 3600);
      await this.onTokens(this.acc);
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async send<T = any>(method: string, path: string, body?: unknown, base: "api" | "identity" | "events" = "api"): Promise<T> {
    const url =
      (base === "api" ? this.acc.urls.api : base === "identity" ? this.acc.urls.identity : serviceUrl(this.acc.urls, "events")) + path;
    const doReq = async () =>
      httpJson(url, {
        method,
        headers: {
          Authorization: "Bearer " + (await this.accessToken()),
          ...(body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    let r = await doReq();
    if (r.status === 401) {
      await this.refresh();
      r = await doReq();
    }
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
    return camelize(r.json) as T;
  }
}

/** Authenticated request with a non-JSON body (multipart uploads). */
export async function sendBody(api: AccountApi, url: string, method: string, body: BodyInit): Promise<number> {
  const doReq = async () => {
    try {
      const r = await fetch(url, {
        method,
        headers: { ...baseHeaders(), Authorization: "Bearer " + (await api.accessToken()) },
        body,
        cache: "no-store",
        credentials: "include",
      });
      let json: any = null;
      try {
        json = await r.json();
      } catch {
        /* empty */
      }
      return { status: r.status, json };
    } catch {
      throw new HttpError(0, null, t("Server nicht erreichbar: ") + new URL(url).host);
    }
  };
  let r = await doReq();
  if (r.status === 401) {
    await api.refresh();
    r = await doReq();
  }
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
  return r.status;
}

/** One-off authenticated request with a raw access token (during login, before an account exists). */
export async function bearerJson<T = any>(
  url: string,
  token: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const r = await httpJson(url, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
  return camelize(r.json) as T;
}

export async function anonJson<T = any>(
  url: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const r = await httpJson(url, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json; charset=utf-8" } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.json, errorMessage(r.status, r.json));
  return camelize(r.json) as T;
}
