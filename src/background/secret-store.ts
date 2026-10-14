// Encrypted extension-wide data that is not part of any vault: generator history and the API
// tokens of the email forwarding services. Every unlocked account keeps its own copy, encrypted
// with its user key ("secretStore:<accountKey>"), so the data is available as soon as any account is
// unlocked; copies of locked accounts are merged in when they are unlocked again.
import { decryptString, encryptString } from "../crypto/bw";
import type { ForwarderId, ForwarderSettings } from "../shared/forwarders";
import { local } from "./store";
import { VaultService } from "./vault-service";

export interface HistoryEntry {
  value: string;
  date: number;
  kind: "password" | "passphrase" | "username" | "email";
  site?: string;
}

export interface SecretData {
  history: HistoryEntry[];
  /** entries older than this were cleared (also in copies of locked accounts) */
  historyClearedAt: number;
  forwarders: Partial<Record<ForwarderId, ForwarderSettings>>;
  forwardersUpdatedAt: number;
}

const MAX_HISTORY = 100;
const empty = (): SecretData => ({ history: [], historyClearedAt: 0, forwarders: {}, forwardersUpdatedAt: 0 });

export class SecretStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private svc: VaultService) {}

  /** Merged data of all unlocked accounts (null: everything locked). */
  async load(): Promise<SecretData | null> {
    const keys = this.svc.unlockedUserKeys();
    if (!keys.length) return null;
    const out = empty();
    const seen = new Set<string>();
    for (const { accountKey, userKey } of keys) {
      const enc = await local.get<string>("secretStore:" + accountKey);
      if (!enc) continue;
      let d: SecretData;
      try {
        d = { ...empty(), ...JSON.parse(await decryptString(enc, userKey)) };
      } catch {
        continue;
      }
      out.historyClearedAt = Math.max(out.historyClearedAt, d.historyClearedAt || 0);
      for (const h of d.history ?? []) {
        const k = h.date + "\u0000" + h.value;
        if (!seen.has(k)) {
          seen.add(k);
          out.history.push(h);
        }
      }
      if ((d.forwardersUpdatedAt || 0) > out.forwardersUpdatedAt) {
        out.forwarders = d.forwarders ?? {};
        out.forwardersUpdatedAt = d.forwardersUpdatedAt;
      }
    }
    out.history = out.history
      .filter((h) => h.date > out.historyClearedAt)
      .sort((a, b) => b.date - a.date)
      .slice(0, MAX_HISTORY);
    return out;
  }

  private async save(d: SecretData) {
    const json = JSON.stringify(d);
    for (const { accountKey, userKey } of this.svc.unlockedUserKeys())
      await local.set("secretStore:" + accountKey, await encryptString(json, userKey));
  }

  /** Serialised read-modify-write. */
  update(fn: (d: SecretData) => void): Promise<SecretData | null> {
    const run = async () => {
      const d = await this.load();
      if (!d) return null;
      fn(d);
      await this.save(d);
      return d;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  addHistory(e: Omit<HistoryEntry, "date"> & { date?: number }) {
    if (!e.value) return Promise.resolve(null);
    return this.update((d) => {
      // the same value twice in a row (e.g. copied and then filled) counts once
      if (d.history[0]?.value === e.value) return;
      d.history.unshift({ ...e, date: e.date ?? Date.now() });
      d.history = d.history.slice(0, MAX_HISTORY);
    });
  }

  clearHistory() {
    return this.update((d) => {
      d.history = [];
      d.historyClearedAt = Date.now();
    });
  }

  setForwarder(id: ForwarderId, s: ForwarderSettings) {
    return this.update((d) => {
      d.forwarders = { ...d.forwarders, [id]: s };
      d.forwardersUpdatedAt = Date.now();
    });
  }
}
