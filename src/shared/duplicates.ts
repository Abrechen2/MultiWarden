// Duplicate check within the items of ONE account (callers pass that account's items only).
import { CipherType, ItemView } from "./types";
import { hostnameOf } from "./uri";

export type DuplicateMode = "site" | "sitePassword";

export interface DuplicateGroup {
  key: string;
  type: CipherType;
  /** e.g. "example.com · alex" */
  label: string;
  items: ItemView[];
  /** logins: all entries of the group have the same password */
  samePassword?: boolean;
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();

function hostsOf(item: ItemView): string[] {
  const out = new Set<string>();
  for (const u of item.login?.uris ?? []) {
    if (!u.uri.trim()) continue;
    const h = hostnameOf(u.uri.trim());
    if (h) out.add(h.replace(/^www\./, ""));
  }
  return [...out];
}

/** Keys under which an item counts as the same entry; items sharing one key are duplicates. */
export function duplicateKeys(item: ItemView, mode: DuplicateMode): string[] {
  switch (item.type) {
    case CipherType.Login: {
      const user = norm(item.login?.username);
      const pw = mode === "sitePassword" ? "\u0000" + (item.login?.password ?? "") : "";
      const hosts = hostsOf(item);
      if (!hosts.length) return [`login|name:${norm(item.name)}|${user}${pw}`];
      return hosts.map((h) => `login|${h}|${user}${pw}`);
    }
    case CipherType.Card: {
      const digits = (item.card?.number ?? "").replace(/\D/g, "");
      return [digits ? `card|${digits}` : `card|name:${norm(item.name)}`];
    }
    case CipherType.Identity: {
      const id = item.identity ?? {};
      const who = [norm(id.firstName), norm(id.lastName), norm(id.email)].join("|");
      return [who.replace(/\|/g, "") ? `identity|${who}` : `identity|name:${norm(item.name)}`];
    }
    case CipherType.SecureNote:
      return [`note|${norm(item.name)}|${(item.notes ?? "").trim()}`];
    case CipherType.SshKey: {
      const k = item.sshKey?.keyFingerprint || item.sshKey?.publicKey;
      return [k ? `ssh|${k.trim()}` : `ssh|name:${norm(item.name)}`];
    }
    default: {
      const extra = Object.entries(item.extra ?? {})
        .filter(([, v]) => v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${norm(v)}`)
        .join("&");
      return [`t${item.type}|${norm(item.name)}|${extra}`];
    }
  }
}

function groupLabel(items: ItemView[], key: string): string {
  const first = items[0];
  switch (first.type) {
    case CipherType.Login: {
      const parts = key.split("|");
      const site = parts[1].startsWith("name:") ? first.name : parts[1];
      return [site, first.login?.username].filter(Boolean).join(" · ");
    }
    case CipherType.Card: {
      const n = (first.card?.number ?? "").replace(/\D/g, "");
      return [first.card?.brand, n ? "*" + n.slice(-4) : first.name].filter(Boolean).join(" ");
    }
    case CipherType.Identity: {
      const id = first.identity ?? {};
      return [[id.firstName, id.lastName].filter(Boolean).join(" "), id.email].filter(Boolean).join(" · ") || first.name;
    }
    default:
      return first.name;
  }
}

/**
 * Groups of duplicate entries (at least two each). Deleted entries and entries that could not be
 * decrypted are ignored. Logins are duplicates when they have the same username on the same website
 * (host without "www."); in mode "sitePassword" the password must match as well.
 */
export function findDuplicates(items: ItemView[], mode: DuplicateMode = "site"): DuplicateGroup[] {
  const live = items.filter((i) => !i.deletedDate && !i.decryptError);
  const parent = live.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const firstByKey = new Map<string, number>();
  const keyOf = new Map<number, string>();
  live.forEach((item, idx) => {
    for (const k of duplicateKeys(item, mode)) {
      const j = firstByKey.get(k);
      if (j == null) firstByKey.set(k, idx);
      else {
        parent[find(idx)] = find(j);
        if (!keyOf.has(j)) keyOf.set(j, k);
        keyOf.set(idx, k);
      }
    }
  });
  const groups = new Map<number, number[]>();
  live.forEach((_, idx) => {
    const r = find(idx);
    groups.set(r, [...(groups.get(r) ?? []), idx]);
  });
  const out: DuplicateGroup[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const members = idxs
      .map((i) => live[i])
      .sort((a, b) => (b.revisionDate ?? "").localeCompare(a.revisionDate ?? "") || a.name.localeCompare(b.name));
    const key = keyOf.get(idxs.find((i) => keyOf.has(i))!) ?? "";
    const g: DuplicateGroup = { key, type: members[0].type, label: groupLabel(members, key), items: members };
    if (g.type === CipherType.Login)
      g.samePassword = members.every((m) => (m.login?.password ?? "") === (members[0].login?.password ?? ""));
    out.push(g);
  }
  return out.sort((a, b) => a.type - b.type || a.label.localeCompare(b.label));
}
