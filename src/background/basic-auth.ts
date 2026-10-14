// HTTP Basic/Digest authentication: answer the browser's credential prompt with the one matching
// login (rules as in the official extension: only top-level navigations the user opened, only
// basic/digest, never proxies, challenger must be the request host, exactly one match).
import { EventType } from "../shared/events";
import { CipherType, UriMatch } from "../shared/types";
import { VaultService } from "./vault-service";

const FILTER: chrome.webRequest.RequestFilter = { urls: ["http://*/*", "https://*/*"] };
const SCHEMES = new Set(["basic", "digest"]);
const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };

type Details = chrome.webRequest.WebAuthenticationChallengeDetails;

function parse(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

const normHost = (h: string) => h.replace(/^\[|\]$/g, "").toLowerCase();

export function shouldAnswer(d: Details): boolean {
  if (d.isProxy) return false;
  if (!SCHEMES.has((d.scheme ?? "").toLowerCase())) return false;
  if (d.tabId == null || d.tabId < 0) return false;
  if (d.type !== "main_frame") return false;
  const url = parse(d.url);
  if (!url || !d.challenger?.host) return false;
  if (normHost(d.challenger.host) !== normHost(url.hostname)) return false;
  const cp = Number(d.challenger.port);
  if (Number.isInteger(cp) && cp > 0) {
    const rp = url.port === "" ? DEFAULT_PORT[url.protocol] : Number(url.port);
    if (cp !== rp) return false;
  }
  return true;
}

export class BasicAuth {
  private pending = new Set<string>();
  private registered = false;
  private readonly firefox = typeof (globalThis as any).browser !== "undefined" && chrome.runtime.getURL("").startsWith("moz-");

  constructor(private svc: VaultService) {}

  /** (un)register the listeners according to the setting */
  update() {
    const wr = chrome.webRequest;
    if (!wr?.onAuthRequired) return;
    const want = this.svc.settings.basicAuth !== false;
    if (want && !this.registered) {
      try {
        wr.onAuthRequired.addListener(this.onAuth as any, FILTER, [this.firefox ? "blocking" : "asyncBlocking"] as any);
        wr.onCompleted.addListener(this.done, FILTER);
        wr.onErrorOccurred.addListener(this.done, FILTER);
        this.registered = true;
      } catch (e) {
        console.warn("basic auth listener", e);
      }
    } else if (!want && this.registered) {
      wr.onAuthRequired.removeListener(this.onAuth as any);
      wr.onCompleted.removeListener(this.done);
      wr.onErrorOccurred.removeListener(this.done);
      this.pending.clear();
      this.registered = false;
    }
  }

  private done = (d: { requestId: string }) => {
    this.pending.delete(d.requestId);
  };

  private onAuth = async (d: Details, callback?: (r: chrome.webRequest.BlockingResponse) => void) => {
    const r = await this.answer(d).catch(() => ({}));
    callback?.(r);
    return r;
  };

  async answer(d: Details): Promise<chrome.webRequest.BlockingResponse> {
    // a second challenge for the same request means the credentials were wrong → let the browser ask
    if (!d.url || this.pending.has(d.requestId) || !shouldAnswer(d)) return {};
    this.pending.add(d.requestId);
    await this.svc.ready;
    if (this.svc.settings.basicAuth === false || !this.svc.anyUnlocked()) return {};
    // items with the default match are compared by host (incl. port), as in the official extension
    const matches = (await this.svc.matchesForUrl(d.url, UriMatch.Host)).filter((i) => i.type === CipherType.Login);
    if (matches.length !== 1) return {};
    const m = matches[0];
    if (m.reprompt === 1 || m.login?.username == null || m.login?.password == null) return {};
    await this.svc.markUsed(m.accountKey, m.id);
    this.svc.events.collect(m.accountKey, EventType.CipherClientAutofilled, m);
    return { authCredentials: { username: m.login.username, password: m.login.password } };
  }
}
