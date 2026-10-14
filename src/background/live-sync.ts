// Live sync: like the official clients, every unlocked account keeps a SignalR connection
// (WebSocket, MessagePack protocol) to its server's notifications hub; changes made on other
// devices arrive immediately instead of with the periodic sync.
import { serviceUrl } from "../shared/types";
import { decodeMsgpack, PING, splitFrames } from "./msgpack";
import type { VaultService } from "./vault-service";

const RS = "\x1e";

export interface ServerNotification {
  contextId?: string | null;
  type: number;
  payload: any;
}

export const PushType = {
  SyncCipherUpdate: 0,
  SyncCipherCreate: 1,
  SyncLoginDelete: 2,
  SyncFolderDelete: 3,
  SyncCiphers: 4,
  SyncVault: 5,
  SyncOrgKeys: 6,
  SyncFolderCreate: 7,
  SyncFolderUpdate: 8,
  SyncCipherDelete: 9,
  SyncSettings: 10,
  LogOut: 11,
  AuthRequest: 15,
  AuthRequestResponse: 16,
  SyncOrganizations: 17,
  RefreshSecurityTasks: 22,
} as const;

class Connection {
  private ws?: WebSocket;
  private ping?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = false;
  connected = false;

  constructor(
    private key: string,
    private svc: VaultService,
    private onMessage: (key: string, n: ServerNotification) => void,
  ) {}

  async start() {
    if (this.stopped) return;
    const acc = this.svc.getAccount(this.key);
    if (!acc || acc.needsLogin) return;
    let token: string;
    try {
      token = await this.svc.accountApi(this.key).accessToken();
    } catch {
      return this.scheduleRetry();
    }
    if (this.stopped) return;
    const base = serviceUrl(acc.urls, "notifications").replace(/^http/i, "ws");
    let ws: WebSocket;
    try {
      ws = new WebSocket(base + "/hub?access_token=" + encodeURIComponent(token));
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    let handshake = false;
    ws.onopen = () => ws.send(JSON.stringify({ protocol: "messagepack", version: 1 }) + RS);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        // handshake response "{}<RS>" (or an error)
        const msg = ev.data.split(RS)[0];
        if (!handshake) {
          handshake = true;
          if (msg && msg !== "{}" && /error/i.test(msg)) return ws.close();
          this.connected = true;
          this.attempts = 0;
          this.ping = setInterval(() => {
            try {
              ws.send(PING);
            } catch {
              /* closed */
            }
          }, 15_000);
        }
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      // a binary handshake response "{}<RS>" (Vaultwarden)
      if (!handshake) {
        handshake = true;
        this.connected = true;
        this.attempts = 0;
        this.ping = setInterval(() => {
          try {
            ws.send(PING);
          } catch {
            /* closed */
          }
        }, 15_000);
      }
      let data = bytes;
      if (data[0] === 0x7b) {
        // "{}<RS>" handshake answer, possibly followed by messages
        const end = data.indexOf(0x1e);
        data = end >= 0 ? data.subarray(end + 1) : new Uint8Array(0);
      }
      for (const fr of splitFrames(data)) {
        let m: any;
        try {
          m = decodeMsgpack(fr);
        } catch {
          continue;
        }
        if (!Array.isArray(m)) continue;
        if (m[0] === 7) {
          ws.close();
          return;
        }
        // invocation: [1, headers, invocationId, target, arguments]
        if (m[0] !== 1 || m[3] !== "ReceiveMessage" || !Array.isArray(m[4])) continue;
        for (const a of m[4]) {
          if (!a || typeof a !== "object") continue;
          this.onMessage(this.key, {
            contextId: a.ContextId ?? a.contextId,
            type: Number(a.Type ?? a.type),
            payload: a.Payload ?? a.payload ?? {},
          });
        }
      }
    };
    ws.onclose = () => {
      this.cleanup();
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* followed by close */
    };
  }

  private cleanup() {
    this.connected = false;
    if (this.ping) clearInterval(this.ping);
    this.ping = undefined;
    this.ws = undefined;
  }

  private scheduleRetry() {
    if (this.stopped || this.retry) return;
    // 5 s, 10 s, 20 s … up to 5 minutes
    const delay = Math.min(300_000, 5_000 * 2 ** this.attempts) * (0.8 + Math.random() * 0.4);
    this.attempts++;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.start();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    const ws = this.ws;
    this.cleanup();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}

export class LiveSync {
  private conns = new Map<string, Connection>();

  constructor(
    private svc: VaultService,
    private onMessage: (key: string, n: ServerNotification) => void,
  ) {}

  /** Connect unlocked accounts, disconnect locked / logged-out ones. */
  update() {
    const want = new Set(
      this.svc
        .publicAccounts()
        .filter((a) => a.status === "unlocked")
        .map((a) => a.key),
    );
    for (const [k, c] of this.conns)
      if (!want.has(k)) {
        c.stop();
        this.conns.delete(k);
      }
    for (const k of want)
      if (!this.conns.has(k)) {
        const c = new Connection(k, this.svc, this.onMessage);
        this.conns.set(k, c);
        c.start();
      }
  }

  status(): Record<string, boolean> {
    return Object.fromEntries([...this.conns].map(([k, c]) => [k, c.connected]));
  }
}
