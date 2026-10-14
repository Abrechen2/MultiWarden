// Organization policies that the client enforces (like the official extension). The policies of the
// sync response are filtered by the same rules as the official clients (organization enabled, uses
// policies, membership accepted, owners/admins exempt where the official client exempts them).
import type { VaultTimeout } from "./types";

export const PolicyType = {
  MasterPassword: 1,
  PasswordGenerator: 2,
  OrganizationDataOwnership: 5,
  DisableSend: 6,
  SendOptions: 7,
  MaximumVaultTimeout: 9,
  DisablePersonalVaultExport: 10,
  ActivateAutofill: 11,
  RemoveUnlockWithPin: 14,
  RestrictedItemTypes: 15,
  UriMatchDefaults: 16,
} as const;

export interface GeneratorPolicy {
  /** "password" or "passphrase": the only type the generator may create */
  overrideType?: "password" | "passphrase";
  minLength: number;
  useUpper: boolean;
  useLower: boolean;
  useNumbers: boolean;
  minNumbers: number;
  useSpecial: boolean;
  minSpecial: number;
  minNumberWords: number;
  capitalize: boolean;
  includeNumber: boolean;
}

export interface TimeoutPolicy {
  type?: "immediately" | "custom" | "onSystemLock" | "onAppRestart" | "never" | null;
  minutes: number;
  action?: "lock" | "logOut" | null;
  orgName: string;
}

/** Effective policies of one account (only the ones that apply to the user). */
export interface AccountPolicies {
  generator?: GeneratorPolicy;
  /** items must be saved to an organization (no personal vault) */
  dataOwnership?: { orgIds: string[] };
  maxTimeout?: TimeoutPolicy;
  disableExport?: boolean;
  removePin?: boolean;
  /** item types hidden/blocked; allowOrgIds: organizations that still allow the type */
  restrictedTypes?: { type: number; allowOrgIds: string[] }[];
  uriMatch?: number;
  activateAutofill?: boolean;
  /** "Remove Send": no new Sends, no edits (deleting stays possible) */
  disableSend?: boolean;
  /** "Send options": the e-mail address may not be hidden from recipients */
  disableHideEmail?: boolean;
}

function exempt(type: number, org: any): boolean {
  const isOwner = org.type === 0;
  const isAdmin = org.type === 0 || org.type === 1;
  switch (type) {
    case PolicyType.MaximumVaultTimeout:
      return isOwner;
    case PolicyType.MasterPassword: // the server applies it to owners and admins too
    case PolicyType.PasswordGenerator:
    case PolicyType.RemoveUnlockWithPin:
    case PolicyType.RestrictedItemTypes:
      return false;
    case PolicyType.OrganizationDataOwnership:
      return isAdmin;
    default:
      return isAdmin || !!org.permissions?.managePolicies;
  }
}

/** Enabled policies of a type that apply to the user (camelCase sync data). */
export function applicablePolicies(sync: any, type: number): { orgId: string; orgName: string; data: any }[] {
  const orgs = new Map<string, any>((sync?.profile?.organizations ?? []).map((o: any) => [o.id, o]));
  return (sync?.policies ?? [])
    .filter((p: any) => p.type === type && p.enabled)
    .filter((p: any) => {
      const o = orgs.get(p.organizationId);
      if (!o) return false;
      if (o.enabled === false || o.usePolicies === false || o.isProviderUser) return false;
      if (o.status != null && o.status < 1) return false;
      return !exempt(type, o);
    })
    .map((p: any) => ({ orgId: p.organizationId, orgName: orgs.get(p.organizationId)?.name ?? "", data: p.data ?? {} }));
}

const num = (v: any) => (typeof v === "number" && isFinite(v) ? v : 0);

export function mergeGeneratorPolicies(list: (GeneratorPolicy | undefined)[]): GeneratorPolicy | undefined {
  let acc: GeneratorPolicy | undefined;
  for (const p of list) {
    if (!p) continue;
    if (!acc) {
      acc = { ...p };
      continue;
    }
    acc = {
      // "password" wins (like the official client), otherwise the first override
      overrideType: acc.overrideType === "password" ? "password" : (p.overrideType ?? acc.overrideType),
      minLength: Math.max(acc.minLength, p.minLength),
      useUpper: acc.useUpper || p.useUpper,
      useLower: acc.useLower || p.useLower,
      useNumbers: acc.useNumbers || p.useNumbers,
      minNumbers: Math.max(acc.minNumbers, p.minNumbers),
      useSpecial: acc.useSpecial || p.useSpecial,
      minSpecial: Math.max(acc.minSpecial, p.minSpecial),
      minNumberWords: Math.max(acc.minNumberWords, p.minNumberWords),
      capitalize: acc.capitalize || p.capitalize,
      includeNumber: acc.includeNumber || p.includeNumber,
    };
  }
  return acc;
}

/** The strictest of several maximum session timeout policies ("log out" wins as action). */
export function mergeTimeoutPolicies(list: (TimeoutPolicy | undefined)[]): TimeoutPolicy | undefined {
  const rank = (x: TimeoutPolicy) =>
    x.type === "immediately" ? 0 : x.type === "custom" || x.type == null ? 1 + x.minutes : x.type === "never" ? 1e9 : 1e8;
  let out: TimeoutPolicy | undefined;
  for (const p of list) {
    if (!p) continue;
    if (!out) {
      out = { ...p };
      continue;
    }
    const keep = rank(out) <= rank(p) ? out : p;
    out = { ...keep, action: out.action === "logOut" || p.action === "logOut" ? "logOut" : (out.action ?? p.action ?? null) };
  }
  return out;
}

export function accountPolicies(sync: any): AccountPolicies {
  const out: AccountPolicies = {};
  const gen = applicablePolicies(sync, PolicyType.PasswordGenerator).map(({ data: d }): GeneratorPolicy => {
    const t = String(d.overridePasswordType ?? d.defaultType ?? "").toLowerCase();
    return {
      overrideType: t === "password" || t === "passphrase" ? t : undefined,
      minLength: num(d.minLength),
      useUpper: !!d.useUpper,
      useLower: !!d.useLower,
      useNumbers: !!d.useNumbers,
      minNumbers: num(d.minNumbers),
      useSpecial: !!d.useSpecial,
      minSpecial: num(d.minSpecial),
      minNumberWords: num(d.minNumberWords),
      capitalize: !!d.capitalize,
      includeNumber: !!d.includeNumber,
    };
  });
  out.generator = mergeGeneratorPolicies(gen);

  const own = applicablePolicies(sync, PolicyType.OrganizationDataOwnership);
  if (own.length) out.dataOwnership = { orgIds: own.map((p) => p.orgId) };

  // strictest maximum session timeout
  out.maxTimeout = mergeTimeoutPolicies(
    applicablePolicies(sync, PolicyType.MaximumVaultTimeout).map((p) => ({
      type: p.data.type ?? null,
      minutes: num(p.data.minutes),
      action: p.data.action ?? null,
      orgName: p.orgName,
    })),
  );

  if (applicablePolicies(sync, PolicyType.DisablePersonalVaultExport).length) out.disableExport = true;
  if (applicablePolicies(sync, PolicyType.RemoveUnlockWithPin).length) out.removePin = true;
  if (applicablePolicies(sync, PolicyType.ActivateAutofill).length) out.activateAutofill = true;
  if (applicablePolicies(sync, PolicyType.DisableSend).length) out.disableSend = true;
  if (applicablePolicies(sync, PolicyType.SendOptions).some((p) => p.data?.disableHideEmail)) out.disableHideEmail = true;

  const uri = applicablePolicies(sync, PolicyType.UriMatchDefaults);
  const m = uri.map((p) => p.data.uriMatchDetection).find((v) => typeof v === "number");
  if (m != null) out.uriMatch = m;

  // restricted item types (default: cards)
  const restr = applicablePolicies(sync, PolicyType.RestrictedItemTypes);
  if (restr.length) {
    const typesOf = (d: any): number[] => (Array.isArray(d) ? d : Array.isArray(d?.restrictedTypes) ? d.restrictedTypes : [3]);
    const all = Array.from(new Set(restr.flatMap((p) => typesOf(p.data))));
    const orgs: any[] = sync?.profile?.organizations ?? [];
    out.restrictedTypes = all.map((type) => ({
      type,
      allowOrgIds: orgs
        .filter((o) => {
          const p = restr.find((x) => x.orgId === o.id);
          return !p || !typesOf(p.data).includes(type);
        })
        .map((o) => o.id),
    }));
  }
  return out;
}

/** Item hidden by the "restricted item types" policy. */
export function isRestricted(p: AccountPolicies | undefined, type: number, organizationId: string | null | undefined): boolean {
  const r = p?.restrictedTypes?.find((x) => x.type === type);
  if (!r) return false;
  return organizationId ? !r.allowOrgIds.includes(organizationId) : true;
}

/** The vault timeout allowed by a maximum session timeout policy (official rules, mapped to MultiWarden). */
export function clampTimeout(current: VaultTimeout, p: TimeoutPolicy | undefined): VaultTimeout {
  if (!p) return current;
  switch (p.type) {
    case "immediately":
      return 0;
    case "custom":
    case null:
    case undefined:
      if (current === 0) return 0;
      if (typeof current === "number") return Math.min(current, p.minutes || current);
      return p.minutes || current;
    case "onSystemLock":
    case "onAppRestart":
      return current === "never" ? "restart" : current;
    default:
      return current;
  }
}

/** Is a timeout option allowed by the policy? */
export function timeoutAllowed(v: VaultTimeout, p: TimeoutPolicy | undefined): boolean {
  return clampTimeout(v, p) === v;
}
