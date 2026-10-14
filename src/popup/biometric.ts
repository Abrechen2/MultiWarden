// Biometric unlock (Windows Hello, Touch ID, security keys) via the WebAuthn PRF extension.
// The PRF output of the credential is sent to the background, which derives the key that
// wraps the user keys. Nothing secret is stored in the popup.
import { b64decode, b64encode, randomBytes } from "../crypto/utils";
import { t } from "../shared/i18n";

const params = new URLSearchParams(location.search);
/** a WebAuthn step that a popout window should start right away ("unlock" | "enable") */
let pending = params.get("bio");

export function takePendingBio(kind: "unlock" | "enable"): boolean {
  if (pending !== kind) return false;
  pending = null;
  return true;
}

export function bioSupported(): boolean {
  return typeof PublicKeyCredential !== "undefined" && !!navigator.credentials?.get;
}

/**
 * The toolbar popup closes as soon as the system dialog of the authenticator takes the focus,
 * which would cancel the request. In the popup the step therefore runs in a separate window.
 */
export function inActionPopup(): boolean {
  try {
    return (chrome.extension?.getViews?.({ type: "popup" }) ?? []).includes(window as any);
  } catch {
    return false;
  }
}

export async function openBioWindow(kind: "unlock" | "enable") {
  await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?popout=1&bio=" + kind),
    type: "popup",
    width: 420,
    height: 680,
  });
  window.close();
}

function friendly(e: any): Error {
  const name = e?.name ?? "";
  if (name === "NotAllowedError" || name === "AbortError") return new Error(t("Abgebrochen oder Zeit abgelaufen"));
  if (name === "SecurityError") return new Error(t("Der Browser erlaubt diese Anmeldung für Erweiterungen nicht."));
  return e instanceof Error ? e : new Error(String(e));
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | undefined {
  const r = (cred.getClientExtensionResults() as any)?.prf?.results?.first;
  return r ? new Uint8Array(r as ArrayBuffer) : undefined;
}

/** Create a new credential with PRF support and return its PRF output for a fresh salt. */
export async function bioCreate(): Promise<{ credentialId: string; salt: string; prf: string }> {
  if (!bioSupported()) throw new Error(t("Dieser Browser unterstützt WebAuthn hier nicht."));
  const salt = randomBytes(32);
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "MultiWarden" },
        user: { id: randomBytes(16), name: "MultiWarden", displayName: t("MultiWarden – Entsperren") },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
        timeout: 120000,
        attestation: "none",
        extensions: { prf: { eval: { first: salt } } } as any,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  const ext = (cred.getClientExtensionResults() as any)?.prf;
  if (!ext?.enabled && !ext?.results) throw new Error(t("Dieser Authenticator unterstützt die Entsperrung nicht (PRF fehlt)."));
  const credentialId = b64encode(new Uint8Array(cred.rawId));
  const saltB64 = b64encode(salt);
  // most authenticators only evaluate the PRF on assertion
  const first = prfFirst(cred);
  const prf = first ? b64encode(first) : await bioGet(credentialId, saltB64);
  return { credentialId, salt: saltB64, prf };
}

/** Ask the authenticator for the PRF output of an existing credential. */
export async function bioGet(credentialId: string, salt: string): Promise<string> {
  if (!bioSupported()) throw new Error(t("Dieser Browser unterstützt WebAuthn hier nicht."));
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: "public-key", id: b64decode(credentialId) }],
        userVerification: "required",
        timeout: 120000,
        extensions: { prf: { eval: { first: b64decode(salt) } } } as any,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  const first = prfFirst(cred);
  if (!first) throw new Error(t("Dieser Authenticator unterstützt die Entsperrung nicht (PRF fehlt)."));
  return b64encode(first);
}
