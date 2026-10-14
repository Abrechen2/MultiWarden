import type { Rpc, RpcName } from "../shared/messages";

import { t } from "../shared/i18n";
export async function call<K extends RpcName>(rpc: K, args: Rpc[K]["req"] = {} as Rpc[K]["req"]): Promise<Rpc[K]["res"]> {
  const r = await chrome.runtime.sendMessage({ rpc, args });
  if (!r) throw new Error(t("Keine Antwort vom Hintergrunddienst"));
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function callAny(rpc: string, args: any = {}): Promise<any> {
  const r = await chrome.runtime.sendMessage({ rpc, args });
  if (!r?.ok) throw new Error(r?.error ?? t("Fehler"));
  return r.data;
}

export function onBroadcast(fn: (event: string) => void): () => void {
  const l = (msg: any) => {
    if (msg && typeof msg === "object" && typeof msg.event === "string") fn(msg.event);
  };
  chrome.runtime.onMessage.addListener(l);
  return () => chrome.runtime.onMessage.removeListener(l);
}
