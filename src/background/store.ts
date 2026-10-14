// Thin typed wrappers around chrome.storage.

export const local = {
  async get<T>(key: string): Promise<T | undefined> {
    const r = await chrome.storage.local.get(key);
    return r[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(keys: string | string[]): Promise<void> {
    await chrome.storage.local.remove(keys);
  },
};

const hasSession = typeof chrome !== "undefined" && !!chrome.storage?.session;
const memSession = new Map<string, unknown>();

export const session = {
  async get<T>(key: string): Promise<T | undefined> {
    if (!hasSession) return memSession.get(key) as T | undefined;
    const r = await chrome.storage.session.get(key);
    return r[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    if (!hasSession) {
      memSession.set(key, value);
      return;
    }
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(keys: string | string[]): Promise<void> {
    if (!hasSession) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => memSession.delete(k));
      return;
    }
    await chrome.storage.session.remove(keys);
  },
};

export async function restrictSessionAccess(): Promise<void> {
  // Keep session storage (decrypted keys) away from content scripts.
  try {
    await chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    /* default is trusted-only anyway */
  }
}
