// Runs in the page's own JavaScript world (MAIN) at document_start: routes WebAuthn calls of the
// website through MultiWarden. Anything MultiWarden does not handle goes to the browser unchanged.
// Communication with the extension goes through the isolated content script (fido2-bridge).
(() => {
  const w = window as any;
  if (w.__mwFido2Page) return;
  w.__mwFido2Page = true;
  const loc = location;
  if (!(loc.protocol === "https:" || (loc.protocol === "http:" && loc.hostname === "localhost"))) return;
  if (document.contentType && document.contentType !== "text/html") return;
  // only the top-level document; frames keep the browser's own WebAuthn
  if (window.top !== window) return;
  const creds = navigator.credentials as CredentialsContainer | undefined;
  if (!creds || typeof w.PublicKeyCredential !== "function") return;

  const nativeCreate = creds.create.bind(creds);
  const nativeGet = creds.get.bind(creds);
  const PKC = w.PublicKeyCredential as any;

  // let websites offer passkeys even if the device has no platform authenticator
  let platformAvailable = false;
  try {
    const orig = PKC.isUserVerifyingPlatformAuthenticatorAvailable?.bind(PKC);
    if (orig)
      orig()
        .then((v: boolean) => {
          platformAvailable = v;
          if (!v) PKC.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
        })
        .catch(() => {});
  } catch {
    /* ignore */
  }

  // ---------------------------------------------------------------------------------------------
  // base64url helpers

  function toBytes(src: any): Uint8Array {
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    throw new TypeError("Expected a BufferSource");
  }
  function b64u(src: any): string {
    const b = toBytes(src);
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function fromB64u(s: string): ArrayBuffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  // ---------------------------------------------------------------------------------------------
  // messaging with the bridge (JSON strings, so nothing depends on cross-world object cloning)

  type Reply = { result?: any; fallback?: boolean; error?: { name: string; message: string } };
  let seq = 0;
  const pending = new Map<string, { resolve: (r: Reply) => void; acked: boolean }>();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || typeof ev.data !== "string" || !ev.data.startsWith('{"__mw":"fido2"')) return;
    let m: any;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.dir === "ack") p.acked = true;
    else if (m.dir === "res") {
      pending.delete(m.id);
      p.resolve(m);
    }
  });

  function send(kind: "create" | "get", options: any, fallbackSupported: boolean, signal?: AbortSignal): Promise<Reply> {
    const id = "p" + ++seq + "-" + Math.random().toString(36).slice(2);
    return new Promise<Reply>((resolve) => {
      const entry = { resolve, acked: false };
      pending.set(id, entry);
      const post = (msg: any) => window.postMessage(JSON.stringify({ __mw: "fido2", id, ...msg }), "*");
      post({ dir: "req", kind, options, fallbackSupported });
      // no extension listening (e.g. right after an update) → behave as if MultiWarden wasn't there
      setTimeout(() => {
        if (!entry.acked && pending.has(id)) {
          pending.delete(id);
          resolve({ fallback: true });
        }
      }, 800);
      if (signal) {
        const onAbort = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          post({ dir: "abort" });
          resolve({ error: { name: "AbortError", message: "The operation was aborted." } });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  function makeError(e: { name: string; message: string }): Error {
    if (e.name === "TypeError") return new TypeError(e.message);
    return new DOMException(e.message, e.name);
  }

  async function waitForFocus(timeout = 5 * 60_000) {
    if (document.hasFocus()) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        window.removeEventListener("focus", on);
        reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      }, timeout);
      const on = () => {
        clearTimeout(t);
        resolve();
      };
      window.addEventListener("focus", on, { once: true });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // option serialisation / result objects

  function mapCreate(pk: any) {
    return {
      rp: { id: pk.rp?.id, name: pk.rp?.name },
      user: { id: b64u(pk.user.id), name: pk.user?.name, displayName: pk.user?.displayName },
      challenge: b64u(pk.challenge),
      pubKeyCredParams: (pk.pubKeyCredParams ?? [])
        .map((p: any) => ({ type: p.type, alg: Number(p.alg) }))
        .filter((p: any) => !isNaN(p.alg)),
      excludeCredentials: (pk.excludeCredentials ?? []).map((c: any) => ({ id: b64u(c.id), type: c.type, transports: c.transports })),
      authenticatorSelection: pk.authenticatorSelection
        ? {
            authenticatorAttachment: pk.authenticatorSelection.authenticatorAttachment,
            residentKey: pk.authenticatorSelection.residentKey,
            requireResidentKey: pk.authenticatorSelection.requireResidentKey,
            userVerification: pk.authenticatorSelection.userVerification,
          }
        : undefined,
      attestation: pk.attestation,
      timeout: pk.timeout,
      extensions: { credProps: !!pk.extensions?.credProps },
    };
  }

  function mapGet(pk: any, mediation?: string) {
    return {
      rpId: pk.rpId,
      challenge: b64u(pk.challenge),
      allowCredentials: (pk.allowCredentials ?? []).map((c: any) => ({ id: b64u(c.id), type: c.type, transports: c.transports })),
      userVerification: pk.userVerification,
      timeout: pk.timeout,
      mediation,
    };
  }

  function attestationCredential(r: any): any {
    const response: any = {
      clientDataJSON: fromB64u(r.clientDataJSON),
      attestationObject: fromB64u(r.attestationObject),
      getAuthenticatorData: () => fromB64u(r.authenticatorData),
      getPublicKey: () => fromB64u(r.publicKey),
      getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
      getTransports: () => r.transports.slice(),
    };
    const ext = r.credProps ? { credProps: r.credProps } : {};
    const cred: any = {
      id: r.id,
      rawId: fromB64u(r.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => ({ ...ext }),
      toJSON: () => ({
        id: r.id,
        rawId: r.id,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: r.clientDataJSON,
          attestationObject: r.attestationObject,
          authenticatorData: r.authenticatorData,
          publicKey: r.publicKey,
          publicKeyAlgorithm: r.publicKeyAlgorithm,
          transports: r.transports,
        },
        clientExtensionResults: ext,
      }),
    };
    try {
      Object.setPrototypeOf(response, w.AuthenticatorAttestationResponse.prototype);
      Object.setPrototypeOf(cred, PKC.prototype);
    } catch {
      /* plain object then */
    }
    return cred;
  }

  function assertionCredential(r: any): any {
    const response: any = {
      clientDataJSON: fromB64u(r.clientDataJSON),
      authenticatorData: fromB64u(r.authenticatorData),
      signature: fromB64u(r.signature),
      userHandle: r.userHandle ? fromB64u(r.userHandle) : null,
    };
    const cred: any = {
      id: r.id,
      rawId: fromB64u(r.id),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => ({
        id: r.id,
        rawId: r.id,
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: r.clientDataJSON,
          authenticatorData: r.authenticatorData,
          signature: r.signature,
          userHandle: r.userHandle ?? undefined,
        },
        clientExtensionResults: {},
      }),
    };
    try {
      Object.setPrototypeOf(response, w.AuthenticatorAssertionResponse.prototype);
      Object.setPrototypeOf(cred, PKC.prototype);
    } catch {
      /* plain object then */
    }
    return cred;
  }

  // ---------------------------------------------------------------------------------------------
  // overrides

  async function create(options?: CredentialCreationOptions): Promise<Credential | null> {
    if (!options || !("publicKey" in options) || !options.publicKey) return nativeCreate(options);
    const pk: any = options.publicKey;
    let mapped;
    try {
      mapped = mapCreate(pk);
    } catch {
      return nativeCreate(options);
    }
    const platform = pk.authenticatorSelection?.authenticatorAttachment === "platform";
    const fallbackSupported = !platform || platformAvailable;
    const r = await send("create", mapped, fallbackSupported, options.signal ?? undefined);
    if (r.result) return attestationCredential(r.result);
    if (r.fallback) {
      await waitForFocus();
      return nativeCreate(options);
    }
    throw makeError(r.error ?? { name: "NotAllowedError", message: "The operation either timed out or was not allowed." });
  }

  async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    if (!options || !("publicKey" in options) || !options.publicKey) return nativeGet(options);
    let mapped;
    try {
      mapped = mapGet(options.publicKey, options.mediation);
    } catch {
      return nativeGet(options);
    }
    if (options.mediation === "conditional") {
      // race: passkeys from MultiWarden (inline menu) vs. the browser's own autofill UI
      const outer = options.signal;
      const ours = new AbortController();
      const theirs = new AbortController();
      const abortAll = () => {
        ours.abort();
        theirs.abort();
      };
      outer?.addEventListener("abort", abortAll, { once: true });
      const mine = send("get", mapped, true, ours.signal).then((r) => {
        if (r.result) return assertionCredential(r.result);
        return new Promise<never>(() => {}); // fallback/error: only the browser can still answer
      });
      const native = nativeGet({ ...options, signal: theirs.signal });
      native.catch(() => {}); // rejections after we won the race are expected (abort)
      try {
        return await Promise.race([mine, native]);
      } finally {
        outer?.removeEventListener("abort", abortAll);
        abortAll();
      }
    }
    const r = await send("get", mapped, true, options.signal ?? undefined);
    if (r.result) return assertionCredential(r.result);
    if (r.fallback) {
      await waitForFocus();
      return nativeGet(options);
    }
    throw makeError(r.error ?? { name: "NotAllowedError", message: "The operation either timed out or was not allowed." });
  }

  try {
    Object.defineProperty(creds, "create", { value: create, configurable: true, writable: true });
    Object.defineProperty(creds, "get", { value: get, configurable: true, writable: true });
  } catch {
    /* read-only in this browser */
  }
})();
