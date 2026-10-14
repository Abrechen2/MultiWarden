// Websites where MultiWarden never offers to save logins (and does not handle passkeys).
import { local } from "./store";

const KEY = "neverDomains";

export async function neverDomains(): Promise<string[]> {
  return ((await local.get<string[]>(KEY)) ?? []).slice().sort();
}

export async function addNeverDomain(host: string) {
  const h = host.toLowerCase();
  const list = await neverDomains();
  if (!list.includes(h)) await local.set(KEY, [...list, h]);
}

export async function removeNeverDomain(host: string) {
  await local.set(
    KEY,
    (await neverDomains()).filter((d) => d !== host.toLowerCase()),
  );
}

export async function isNeverDomain(host: string): Promise<boolean> {
  return (await neverDomains()).includes(host.toLowerCase());
}
