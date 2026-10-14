// Phishing warning (like the official extension): the addresses of opened pages are checked locally
// against Bitwarden's list of known phishing links; on a hit the tab shows a warning page instead.
import { local } from "./store";

const MANIFEST_URL = "https://assets.bitwarden.com/security/v1/manifest.json";
const LIST_BASE = "https://assets.bitwarden.com/security/v1/";
/** test addresses of the official client (always flagged) */
const TEST_URLS = ["http://phishing.testcategory.com/", "https://phishing.testcategory.com/", "https://phishing.testcategory.com/block"];

export class PhishingGuard {
  private list: Set<string> | null = null;
  private loading: Promise<void> | null = null;
  /** "host:tabId" the user chose to open anyway */
  private ignored = new Set<string>();
  private lastChecked = new Map<number, string>();

  constructor(private enabled: () => boolean) {}

  private async load() {
    if (this.list) return;
    if (!this.loading)
      this.loading = (async () => {
        const text = (await local.get<string>("phishingList")) ?? "";
        this.list = new Set(text ? text.split("\n") : []);
      })().finally(() => (this.loading = null));
    await this.loading;
  }

  /** Download the list when it changed (daily alarm, and when the warning is switched on). */
  async update(force = false) {
    if (!this.enabled()) return;
    const last = (await local.get<number>("phishingChecked")) ?? 0;
    if (!force && Date.now() - last < 20 * 3600_000) return;
    const res = await fetch(MANIFEST_URL, { cache: "no-store", credentials: "omit" });
    if (!res.ok) throw new Error("manifest " + res.status);
    const m = await res.json();
    const sha = m?.full_list?.sha256;
    if (sha && sha === (await local.get<string>("phishingSha"))) {
      await local.set("phishingChecked", Date.now());
      return;
    }
    const lr = await fetch(LIST_BASE + (m?.full_list?.path ?? "link-blocklist.txt"), { cache: "no-store", credentials: "omit" });
    if (!lr.ok) throw new Error("list " + lr.status);
    await this.setList((await lr.text()).split(/\r?\n/), sha);
  }

  /** Replace the list (also used by the tests). */
  async setList(lines: string[], sha?: string) {
    const clean = lines.map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l));
    await local.set("phishingList", clean.join("\n"));
    await local.set("phishingSha", sha ?? "");
    await local.set("phishingChecked", Date.now());
    this.list = new Set(clean);
  }

  async clear() {
    await local.remove(["phishingList", "phishingSha", "phishingChecked"]);
    this.list = null;
  }

  async isPhishing(url: string): Promise<boolean> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const href = u.href;
    if (TEST_URLS.includes(href)) return true;
    await this.load();
    const set = this.list!;
    if (!set.size) return false;
    const variants = [href];
    if (href.endsWith("/")) variants.push(href.slice(0, -1));
    for (const v of [...variants]) {
      if (v.startsWith("https://")) variants.push("http://" + v.slice(8));
      else if (v.startsWith("http://")) variants.push("https://" + v.slice(7));
    }
    return variants.some((v) => set.has(v));
  }

  /** Called for every URL change of a tab; returns the warning page URL on a hit. */
  async check(tabId: number, url: string): Promise<string | null> {
    if (!this.enabled()) return null;
    if (this.lastChecked.get(tabId) === url) return null;
    this.lastChecked.set(tabId, url);
    if (!/^https?:/i.test(url)) return null;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    if (this.ignored.has(host + ":" + tabId)) return null;
    if (!(await this.isPhishing(url))) return null;
    return chrome.runtime.getURL("popup.html?popout=1&phishing=" + encodeURIComponent(url));
  }

  /** "Continue anyway": no more warnings for this host in this tab. */
  allow(tabId: number, url: string) {
    try {
      this.ignored.add(new URL(url).hostname + ":" + tabId);
    } catch {
      /* ignore */
    }
  }

  tabClosed(tabId: number) {
    this.lastChecked.delete(tabId);
    for (const k of [...this.ignored]) if (k.endsWith(":" + tabId)) this.ignored.delete(k);
  }
}
