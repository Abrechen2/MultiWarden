// Organization policies: which apply (official exemption rules), merging and their effects.
import "./chrome-stub";
import { accountPolicies, applicablePolicies, clampTimeout, isRestricted, mergeTimeoutPolicies, timeoutAllowed } from "../src/shared/policies";
import { applyPassphrasePolicy, applyPasswordPolicy, DEFAULT_PASSPHRASE, DEFAULT_PASSWORD, policyMode } from "../src/shared/generator";

let failed = 0;
const check = (n: string, ok: boolean, info: any = "") => {
  console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(info)));
  if (!ok) failed++;
};

const org = (id: string, type: number, extra: any = {}) => ({ id, name: "Org " + id, type, status: 2, enabled: true, usePolicies: true, ...extra });
const pol = (orgId: string, type: number, data: any = null, enabled = true) => ({ organizationId: orgId, type, data, enabled });

// member (type 2) of A and B, admin (type 1) of C, owner (type 0) of D
const sync = {
  profile: { organizations: [org("A", 2), org("B", 2), org("C", 1), org("D", 0), org("E", 2, { enabled: false })] },
  policies: [
    pol("A", 2, { minLength: 16, useUpper: true, minNumbers: 2, overridePasswordType: "passphrase", minNumberWords: 5 }),
    pol("B", 2, { minLength: 24, useSpecial: true, minSpecial: 3, overridePasswordType: "password", capitalize: true }),
    pol("C", 5),
    pol("A", 9, { type: "custom", minutes: 30, action: null }),
    pol("B", 9, { type: "custom", minutes: 15, action: "logOut" }),
    pol("D", 9, { type: "immediately", minutes: 0 }),
    pol("C", 10),
    pol("A", 14),
    pol("A", 15, null),
    pol("C", 16, { uriMatchDetection: 3 }),
    pol("E", 11),
    pol("A", 11, null, false),
  ],
};
const p = accountPolicies(sync);

// generator: applies to everyone, strictest values; "password" wins as override
check("generator merged", p.generator?.minLength === 24 && p.generator.useUpper && p.generator.useSpecial && p.generator.minNumbers === 2 && p.generator.minSpecial === 3, p.generator);
check("generator override: password wins", p.generator?.overrideType === "password", p.generator);
check("generator passphrase minimums", p.generator?.minNumberWords === 5 && p.generator.capitalize, p.generator);
// data ownership: admins exempt
check("data ownership: admin of C exempt", !p.dataOwnership, p.dataOwnership);
// maximum timeout: owner of D exempt, strictest of A/B (15 min), log out wins
check("max timeout: strictest member policy, owner exempt", p.maxTimeout?.minutes === 15 && p.maxTimeout.type === "custom" && p.maxTimeout.action === "logOut", p.maxTimeout);
// export / uri match: admin exempt (canManagePolicies)
check("export policy: admin exempt", !p.disableExport);
check("uri match: admin exempt", p.uriMatch === undefined);
// pin + restricted types apply to everyone
check("remove PIN applies", !!p.removePin);
check("restricted types default to cards", p.restrictedTypes?.length === 1 && p.restrictedTypes[0].type === 3, p.restrictedTypes);
check("orgs without the policy still allow cards", JSON.stringify(p.restrictedTypes?.[0].allowOrgIds) === JSON.stringify(["B", "C", "D", "E"]), p.restrictedTypes);
check("personal card hidden", isRestricted(p, 3, null));
check("card of org A hidden", isRestricted(p, 3, "A"));
check("card of org B visible", !isRestricted(p, 3, "B"));
check("logins unaffected", !isRestricted(p, 1, null));
check("disabled org / disabled policy ignored", !p.activateAutofill);

// master password requirements apply to owners and admins too (like the server)
const mpOwner = applicablePolicies({ profile: { organizations: [org("O", 0)] }, policies: [pol("O", 1, { minLength: 20 })] }, 1);
check("master password policy applies to owners", mpOwner.length === 1 && mpOwner[0].data.minLength === 20, mpOwner);

// member policies for exempt types
const member = accountPolicies({
  profile: { organizations: [org("X", 2), org("Y", 4, { permissions: { managePolicies: true } })] },
  policies: [pol("X", 5), pol("X", 10), pol("X", 16, { uriMatchDetection: 1 }), pol("X", 11), pol("Y", 10), pol("X", 15, [3, 5])],
});
check("member: data ownership", JSON.stringify(member.dataOwnership?.orgIds) === '["X"]', member.dataOwnership);
check("member: export disabled", !!member.disableExport);
check("member: uri match", member.uriMatch === 1);
check("member: activate autofill", !!member.activateAutofill);
check("explicit restricted types", member.restrictedTypes?.map((r) => r.type).join() === "3,5", member.restrictedTypes);
// Send: "Remove Send" (6) and "Send options" (7) apply to members, admins/owners are exempt
const sendMember = accountPolicies({ profile: { organizations: [org("S", 2)] }, policies: [pol("S", 6), pol("S", 7, { disableHideEmail: true })] });
check("remove Send applies to members", sendMember.disableSend === true && sendMember.disableHideEmail === true, sendMember);
const sendAdmin = accountPolicies({ profile: { organizations: [org("S", 1)] }, policies: [pol("S", 6), pol("S", 7, { disableHideEmail: true })] });
check("Send policies: admins exempt", !sendAdmin.disableSend && !sendAdmin.disableHideEmail, sendAdmin);
const sendOpts = accountPolicies({ profile: { organizations: [org("S", 2)] }, policies: [pol("S", 7, { disableHideEmail: false })] });
check("Send options without hide-email restriction", !sendOpts.disableHideEmail && !sendOpts.disableSend, sendOpts);

const invited = accountPolicies({ profile: { organizations: [org("Z", 2, { status: 0 })] }, policies: [pol("Z", 10)] });
check("invited (not accepted) membership ignored", !invited.disableExport);

// timeout clamping (official rules mapped to MultiWarden)
const custom = { type: "custom" as const, minutes: 15, orgName: "A" };
check("clamp: never → policy minutes", clampTimeout("never", custom) === 15);
check("clamp: 60 → 15", clampTimeout(60, custom) === 15);
check("clamp: 5 stays", clampTimeout(5, custom) === 5);
check("clamp: immediately stays", clampTimeout(0, custom) === 0);
check("clamp: restart → minutes", clampTimeout("restart", custom) === 15);
check("immediately policy", clampTimeout(240, { type: "immediately", minutes: 0, orgName: "" }) === 0);
check("onAppRestart: never → restart", clampTimeout("never", { type: "onAppRestart", minutes: 0, orgName: "" }) === "restart");
check("onAppRestart: 60 stays", clampTimeout(60, { type: "onAppRestart", minutes: 0, orgName: "" }) === 60);
check("option check", timeoutAllowed(15, custom) && !timeoutAllowed(30, custom) && !timeoutAllowed("never", custom));
const merged = mergeTimeoutPolicies([{ type: "onAppRestart", minutes: 0, orgName: "a" }, custom, undefined]);
check("merge: custom minutes stricter than restart", merged?.minutes === 15 && merged.type === "custom", merged);

// generator options raised to the policy
const g = p.generator!;
const pw = applyPasswordPolicy({ ...DEFAULT_PASSWORD, length: 10, upper: false, special: false, minSpecial: 0 }, g);
check("password options raised", pw.length === 24 && pw.upper && pw.special && pw.minSpecial === 3 && pw.digits && pw.minDigits === 2, pw);
const pp = applyPassphrasePolicy({ ...DEFAULT_PASSPHRASE, words: 3, capitalize: false }, g);
check("passphrase options raised", pp.words === 5 && pp.capitalize, pp);
check("mode forced", policyMode("passphrase", g) === "password" && policyMode("username", g) === "username");

console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
