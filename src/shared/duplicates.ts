// Duplicate check over the items passed in – one account or several (callers pass unlocked accounts only).
import { CipherType, ItemView } from "./types";
import { isPortScopedHost, parseUrl } from "./uri";

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
    const parsed = parseUrl(u.uri.trim());
    if (!parsed) continue;
    const hostname = parsed.hostname.toLowerCase();
    // IPs, localhost and single-label hosts: every port is its own service (same rule as URI matching)
    const h = isPortScopedHost(hostname) ? parsed.host.toLowerCase() : hostname;
    out.add(h.replace(/^www\./, ""));
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

/** One compared field of a duplicate group. */
export interface FieldDiff {
  /** "name", "username", "password", "totp", "uris", "notes", "folder", "passkeys", "card:<k>", "identity:<k>", "field:<name>" … */
  key: string;
  same: boolean;
  /** secrets are never handed to the UI as values, only as variants */
  secret: boolean;
  /** per item (group order): the value to show, undefined for secrets and empty values */
  values: (string | undefined)[];
  /** per item: index of the distinct value in order of first appearance, -1 = empty */
  variants: number[];
}

/** Card / identity / extra keys that hold secrets (shown only as variants). */
const SECRET_KEY = /number|ssn|iban|pin|code|cvv|password|secret|private/i;
const HIDDEN_FIELD = 1; // FieldType.Hidden

type Getter = { key: string; secret: boolean; get: (i: ItemView) => string };

function gettersFor(items: ItemView[], folderName: (i: ItemView) => string): Getter[] {
  const g: Getter[] = [{ key: "name", secret: false, get: (i) => i.name }];
  const keysOf = (pick: (i: ItemView) => Record<string, string | undefined> | undefined) =>
    [...new Set(items.flatMap((i) => Object.keys(pick(i) ?? {})))].sort();
  switch (items[0].type) {
    case CipherType.Login:
      g.push(
        { key: "username", secret: false, get: (i) => i.login?.username ?? "" },
        { key: "password", secret: true, get: (i) => i.login?.password ?? "" },
        { key: "totp", secret: true, get: (i) => i.login?.totp ?? "" },
        {
          key: "uris",
          secret: false,
          get: (i) => [...new Set((i.login?.uris ?? []).map((u) => u.uri.trim()).filter(Boolean))].sort().join(", "),
        },
        { key: "passkeys", secret: false, get: (i) => (i.login?.passkeys ? String(i.login.passkeys) : "") },
      );
      break;
    case CipherType.Card:
      for (const k of keysOf((i) => i.card)) g.push({ key: "card:" + k, secret: k === "number" || k === "code", get: (i) => i.card?.[k] ?? "" });
      break;
    case CipherType.Identity:
      for (const k of keysOf((i) => i.identity)) g.push({ key: "identity:" + k, secret: SECRET_KEY.test(k), get: (i) => i.identity?.[k] ?? "" });
      break;
    case CipherType.SshKey:
      for (const k of keysOf((i) => i.sshKey)) g.push({ key: "ssh:" + k, secret: k === "privateKey", get: (i) => i.sshKey?.[k] ?? "" });
      break;
    case CipherType.SecureNote:
      break;
    default:
      for (const k of keysOf((i) => i.extra)) g.push({ key: "extra:" + k, secret: SECRET_KEY.test(k), get: (i) => i.extra?.[k] ?? "" });
  }
  // notes often carry secrets (recovery codes …)
  g.push({ key: "notes", secret: true, get: (i) => i.notes ?? "" });
  for (const name of [...new Set(items.flatMap((i) => i.fields.map((f) => f.name)))].sort()) {
    const field = (i: ItemView) => i.fields.find((f) => f.name === name);
    g.push({
      key: "field:" + name,
      secret: items.some((i) => field(i)?.type === HIDDEN_FIELD),
      get: (i) => field(i)?.value ?? "",
    });
  }
  g.push({ key: "folder", secret: false, get: folderName });
  return g;
}

/**
 * Field-by-field comparison of a duplicate group: what is the same in all entries and what differs.
 * Fields empty in every entry are left out; differing fields come first. Secret values are not
 * returned, only which entries share the same value (variants).
 */
export function compareGroup(items: ItemView[], folderName: (i: ItemView) => string): FieldDiff[] {
  if (!items.length) return [];
  const out: FieldDiff[] = [];
  for (const { key, secret, get } of gettersFor(items, folderName)) {
    // secrets are compared exactly: a trailing space is a different password
    const raw = items.map((i) => (secret ? get(i) : get(i).trim()));
    if (raw.every((v) => !v)) continue;
    const distinct: string[] = [];
    const variants = raw.map((v) => {
      if (!v) return -1;
      let idx = distinct.indexOf(v);
      if (idx < 0) idx = distinct.push(v) - 1;
      return idx;
    });
    out.push({
      key,
      same: variants.every((v) => v === variants[0]),
      secret,
      values: raw.map((v) => (secret || !v ? undefined : v)),
      variants,
    });
  }
  return [...out.filter((d) => !d.same), ...out.filter((d) => d.same)];
}

/** The same shared (organization) item as seen through two accounts: same organization and id. */
export function sameSharedItem(a: ItemView, b: ItemView): boolean {
  return !!a.organizationId && a.organizationId === b.organizationId && !!a.id && a.id === b.id;
}

/**
 * Groups of duplicate entries (at least two each). Deleted entries and entries that could not be
 * decrypted are ignored. Logins are duplicates when they have the same username on the same website
 * (host without "www."; with the port on IP / localhost / single-label hosts); in mode "sitePassword" the password must match as well.
 * Items may come from several accounts; a shared item seen by two accounts counts once.
 */
export function findDuplicates(items: ItemView[], mode: DuplicateMode = "site"): DuplicateGroup[] {
  const live = items
    .filter((i) => !i.deletedDate && !i.decryptError)
    .filter((i, idx, all) => !all.slice(0, idx).some((e) => sameSharedItem(e, i)));
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
