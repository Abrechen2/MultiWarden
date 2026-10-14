// Event logs of organizations: like the official clients, events about items of organizations that
// use event logs are collected locally and uploaded once a minute (POST <events>/collect).
import { EventType } from "../shared/events";
import { local } from "./store";
import type { VaultService } from "./vault-service";

interface QueuedEvent {
  type: number;
  cipherId?: string;
  organizationId?: string;
  date: string;
}

const KEY = "eventQueue";
const MAX = 500;

export class EventCollector {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private svc: VaultService) {}

  /** Queue an event; item events only for items of organizations with event logs. */
  collect(accountKey: string, type: number, item?: { id: string; organizationId?: string | null }) {
    const run = async () => {
      const acc = this.svc.getAccount(accountKey);
      const orgs = acc?.eventOrgs ?? [];
      if (!acc || !orgs.length) return;
      if (item && (!item.organizationId || !orgs.includes(item.organizationId))) return;
      if (!item && type !== EventType.UserClientExportedVault) return;
      const q = (await local.get<Record<string, QueuedEvent[]>>(KEY)) ?? {};
      const list = (q[accountKey] ??= []);
      list.push({ type, cipherId: item?.id, organizationId: item?.organizationId ?? undefined, date: new Date().toISOString() });
      if (list.length > MAX) list.splice(0, list.length - MAX);
      await local.set(KEY, q);
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /** Upload the queued events of all accounts (events of removed accounts are dropped). */
  upload(onlyAccount?: string) {
    const run = async () => {
      const q = (await local.get<Record<string, QueuedEvent[]>>(KEY)) ?? {};
      let changed = false;
      for (const [key, list] of Object.entries(q)) {
        if (onlyAccount && key !== onlyAccount) continue;
        const acc = this.svc.getAccount(key);
        if (!acc || !list.length) {
          delete q[key];
          changed = true;
          continue;
        }
        if (acc.needsLogin) continue;
        try {
          await this.svc.accountApi(key).send("POST", "/collect", list, "events");
          delete q[key];
          changed = true;
        } catch (e) {
          console.warn("event upload", key, e);
        }
      }
      if (changed) await local.set(KEY, q);
    };
    // queued behind running collects, so no event gets lost while uploading
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async pending(): Promise<Record<string, QueuedEvent[]>> {
    await this.chain.catch(() => {});
    return (await local.get<Record<string, QueuedEvent[]>>(KEY)) ?? {};
  }
}
