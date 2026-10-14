// Isolated content script (document_start): relays WebAuthn requests from the page script to the
// background and the answers back. The background decides based on the sender's real URL.
(() => {
  const g = globalThis as any;
  if (g.__mwFido2Bridge) return;
  g.__mwFido2Bridge = true;
  if (window.top !== window) return;

  const ports = new Map<string, chrome.runtime.Port>();

  function reply(id: string, msg: any) {
    window.postMessage(JSON.stringify({ __mw: "fido2", id, ...msg }), "*");
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || typeof ev.data !== "string" || !ev.data.startsWith('{"__mw":"fido2"')) return;
    let m: any;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof m.id !== "string") return;
    if (m.dir === "req") {
      if (ports.has(m.id)) return;
      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: "mw-fido2" });
      } catch {
        return; // extension context gone → page script falls back after its timeout
      }
      ports.set(m.id, port);
      reply(m.id, { dir: "ack" });
      let done = false;
      const ping = setInterval(() => {
        try {
          port.postMessage({ type: "ping" });
        } catch {
          /* disconnected */
        }
      }, 20_000);
      const end = (msg: any) => {
        if (done) return;
        done = true;
        clearInterval(ping);
        ports.delete(m.id);
        reply(m.id, { dir: "res", ...msg });
      };
      port.onMessage.addListener((r: any) => {
        if (r?.type === "result") end({ result: r.result });
        else if (r?.type === "fallback") end({ fallback: true });
        else if (r?.type === "error") end({ error: { name: String(r.name), message: String(r.message) } });
      });
      port.onDisconnect.addListener(() => {
        // background went away without an answer
        end(
          m.options?.mediation === "conditional"
            ? { fallback: true }
            : { error: { name: "NotAllowedError", message: "The operation either timed out or was not allowed." } },
        );
      });
      port.postMessage({ type: "request", kind: m.kind, options: m.options, fallbackSupported: m.fallbackSupported !== false });
    } else if (m.dir === "abort") {
      const port = ports.get(m.id);
      if (!port) return;
      try {
        port.postMessage({ type: "abort" });
      } catch {
        /* gone */
      }
    }
  });
})();
