# Cleanup Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help clean up duplicate logins across all accounts by showing dated evidence of which password is current, recording login outcomes, and adding a "Aufräumen" tab — released as 1.6.0.

**Architecture:** Pure logic in `src/shared/` (duplicate keys, evidence/recommendation, cleanup checks) and `src/background/login-attempt.ts` (outcome classification), each with offline tests. A small local store (`src/background/login-outcomes.ts`) plus one RPC feeds evidence to the popup. The notification service gets a separate attempt tracker that reuses the existing `collectFrames()` page probe and the existing notification bar with a new `confirmLogin` kind.

**Tech Stack:** TypeScript, Preact, MV3 (Firefox + Chromium builds via `build.mjs`), offline tests via `tests/run-node.sh`, DOM test via Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-cleanup-assistant-design.md` — read it first; this plan does not repeat its rules.

## Global Constraints

- Code, comments, commits in English; commit style `<type>: <description>` ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- UI strings: German literal through `t()` / `tk()`; add the key with translations to **all three** of `src/shared/locales/en.json`, `es.json`, `fr.json` (they are kept complete). `node scripts/i18n-check.mjs --keys` must report no missing keys.
- Public repo: tests and docs use documentation addresses only (`10.0.0.5`, `example.de`), never homelab hosts.
- Never store passwords, hashes or derivatives for this feature. Never remove an item without a user confirmation; removal = existing `deleteItem` RPC (trash).
- Every security-relevant test must fail on the unchanged code first (run it before implementing).
- Unchanged: Bitwarden data model / server API; `matchesForUrl` semantics.
- Release: version `1.6.0` in `package.json`; `npx tsc --noEmit`, all offline tests, the DOM test pass; sign with `node ../MultiWarden-local/tools/amo-sign.mjs --sign .`, publish with `node ../MultiWarden-local/tools/publish-update.mjs . <xpi>`, push Forgejo `--all`/`--tags`, copy to Unraid-2 `Download`.

## Review Focus

1. Duplicate group containing an item with an **empty password** — it is its own variant, never "reused", never recommended over a non-empty one by password date alone. → test in Task 3.
2. **Read-only items** (`edit === false`, e.g. read-only collections) — never in a bulk removal list, no trash button. → test in Task 3.
3. Password **changed by a sync after a success record** — the record is ignored (rev mismatch) and pruned. → test in Task 2.
4. Login form inside a **cross-origin iframe** or a page whose top frame is unreachable — outcome is `unknown`, never `success`. → test in Task 5.
5. **"Alle Konten" while one account is locked** — only unlocked items appear; nothing from the locked account is grouped or removed. → test in Task 1 (`unlockedOnly`) and covered by the UI using `app.vault.items` of unlocked accounts.

---

### Task 1: Duplicate keys — port rule, untrimmed secrets, cross-account grouping

**Files:**
- Modify: `src/shared/duplicates.ts` (`hostsOf`, `duplicateKeys`, `compareGroup`, `findDuplicates`, file header comment)
- Test: `tests/duplicates-compare.test.ts` (extend)

**Interfaces:**
- Produces: `findDuplicates(items: ItemView[], mode?: DuplicateMode): DuplicateGroup[]` — now accepts items of several accounts; `sameSharedItem(a: ItemView, b: ItemView): boolean` (same `organizationId` and `id`, both non-empty) exported from `src/shared/duplicates.ts`.

- [ ] **Step 1: Write the failing tests** (in `tests/duplicates-compare.test.ts`, using the file's existing item helper)
  - `IP logins on different ports are not duplicates`: two logins user `admin`, URIs `http://10.0.0.5:8080` and `http://10.0.0.5:5765` → `findDuplicates(...)` has 0 groups.
  - `IP logins on the same port are duplicates`: `http://10.0.0.5:8080` and `https://10.0.0.5:8080/login` → 1 group.
  - `domain logins still group across ports`: `https://nas.example.de:8443`, `https://nas.example.de:5001` → 1 group.
  - `passwords differing only in whitespace differ`: passwords `"pw"` and `"pw "` → `compareGroup` entry `password` has `same === false`; group `samePassword === false`.
  - `non-secret fields are still trimmed`: names `"Mail"` and `"Mail "` → `name` entry `same === true`.
  - `cross-account duplicates group`: same login in accounts `a` and `b` → 1 group with both `accountKey`s.
  - `shared org item seen by two accounts is one item`: items `{accountKey:"a", id:"x", organizationId:"o"}` and `{accountKey:"b", id:"x", organizationId:"o"}` → 0 groups; with a third personal copy in `a` → 1 group of 2 items (one of the shared pair + the copy).
  - `unlockedOnly`: the caller passes only unlocked items; assert `findDuplicates([])` is `[]` (documents the contract; the filter lives in the UI).
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/duplicates-compare.test.ts` — expected: the new port, whitespace, cross-account and shared-item checks FAIL.
- [ ] **Step 3: Implement**
  - `hostsOf`: for hosts where `isPortScopedHost(hostname)` is true use `host` incl. port from `parseUrl` (`u.host`, default port dropped by `URL`), otherwise the hostname as today.
  - `compareGroup`: do not `trim()` values of getters with `secret: true`.
  - `findDuplicates`: before grouping, drop items for which an earlier item satisfies `sameSharedItem`; update the header comment (no longer "ONE account").
- [ ] **Step 4: Run** the same command — expected `ALL PASSED`.
- [ ] **Step 5: Commit** `fix(duplicates): port-aware keys, exact secrets, groups across accounts`

### Task 2: Login outcome store and evidence RPC

**Files:**
- Create: `src/background/login-outcomes.ts`
- Modify: `src/shared/types.ts` (settings), `src/shared/messages.ts` (RPC types), `src/background/index.ts` (RPC handlers), `src/background/vault-service.ts` (account removal list ~line 1066)
- Test: `tests/login-outcomes.test.ts` (new)

**Interfaces:**
- Produces:
  - `export interface OutcomeRecord { at: number; ok: boolean; rev: string }`
  - `export function itemRev(i: ItemView): string` — `i.login?.passwordRevisionDate ?? i.revisionDate ?? ""`.
  - `export class LoginOutcomes { constructor(store: { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void>; remove(k: string | string[]): Promise<void> }); record(item: ItemView, ok: boolean, now?: number): Promise<void>; forAccount(accountKey: string, items: ItemView[]): Promise<Record<string, OutcomeRecord>>; clear(accountKey?: string): Promise<void> }` — storage key `loginOutcome:<accountKey>`; `forAccount` returns only records whose `rev === itemRev(current item)` and writes back the pruned map when it dropped any.
  - Settings (`Settings` in `src/shared/types.ts`, defaults next to `promptSave`): `trackLoginOutcome: boolean` (default `true`), `askLoginOutcome: boolean` (default `true`).
  - RPC `usageEvidence: { req: Record<string, never>; res: { lastUsed: Record<string, Record<string, number>>; outcomes: Record<string, Record<string, OutcomeRecord>> } }` — unlocked accounts only.
  - RPC `clearLoginOutcomes: { req: Record<string, never>; res: { ok: true } }`.
- [ ] **Step 1: Write the failing tests** with an in-memory store: `record then forAccount returns it`; `record keeps only the latest per item`; `a password change (different passwordRevisionDate) hides and prunes the record` (assert the stored map no longer has the id); `fallback rev uses revisionDate`; `clear(account) removes only that account`; `clear() removes all`; `stored value contains no password` (JSON of the store does not contain the item's password string).
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/login-outcomes.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement** `login-outcomes.ts`; wire the two RPCs in `index.ts` (`usageEvidence` reads `svc.lastUsed` per unlocked account and `outcomes.forAccount` with that account's vault items); add `"loginOutcome:" + key` to the `local.remove` list on account removal; add settings defaults.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit` — expected `ALL PASSED`, no type errors.
- [ ] **Step 5: Commit** `feat: store login outcomes per item, evidence RPC`

### Task 3: Evidence and recommendation (pure)

**Files:**
- Create: `src/shared/dup-evidence.ts`
- Test: `tests/dup-evidence.test.ts` (new)

**Interfaces:**
- Consumes: `DuplicateGroup`, `compareGroup`, `FieldDiff` (Task 1), `OutcomeRecord` (Task 2; import the type only).
- Produces:
  - `export interface Evidence { lastUsed: Record<string, Record<string, number>>; outcomes: Record<string, Record<string, OutcomeRecord>> }` (same shape as the `usageEvidence` RPC result).
  - `export interface ItemEvidence { passwordChanged?: string; passwordChangedIsCreation: boolean; lastUsed?: number; outcome?: OutcomeRecord; supersededBy?: ItemView }`
  - `export interface GroupAssessment { evidence: Map<ItemView, ItemEvidence>; recommended: ItemView | null; unclear: boolean; outdated: Set<ItemView>; keep: ItemView[]; removable: ItemView[]; uniqueFieldsOf: (removed: ItemView) => string[] }`
  - `export function assessGroup(group: DuplicateGroup, ev: Evidence, folderName: (i: ItemView) => string): GroupAssessment`
- Rules: exactly the spec section "Recommendation rules" and "Bulk button" — rule 1 outcomes, rule 2 history (two-way history decides nothing), rule 3 unique newest `passwordRevisionDate`; within a variant keep order success record → `lastUsed` → `revisionDate`. `removable` = identical copies within variants (all but the variant's keep item) + all items of variants outdated by rule 1 or 2; never an item with `edit === false`; never the `recommended` item. For groups with `samePassword !== false` (incl. non-login types) `recommended` is the keep item and `removable` the other copies; `evidence` is empty. `uniqueFieldsOf(x)` = `fieldLabel` keys of `compareGroup([x, keepOfItsGroup])` where `x` has a value and differs (return field keys; the UI maps them to labels).
- [ ] **Step 1: Write the failing tests** (names → expectation):
  - `newest password date recommends but does not remove` → `recommended` is the newer variant; `removable` excludes the older variant.
  - `password in other entry's history marks outdated and removable`.
  - `two-way history decides nothing` → falls through to rule 3.
  - `success record beats history` → variant with newer success wins although its password is in the other's history; the other is outdated.
  - `latest failure outdates a variant`.
  - `tie on password date gives no recommendation` → `recommended === null`, `unclear === true`, `removable` only identical copies.
  - `identical copies keep the most recently used`.
  - `read-only items are never removable`.
  - `empty password is its own variant and never wins on date alone` (Review Focus 1).
  - `unique fields of a removed copy` → copy with TOTP and the kept one without → `["totp"]`.
  - `non-login groups keep newest revision and offer the rest`.
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/dup-evidence.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement** `assessGroup`.
- [ ] **Step 4: Run** — expected `ALL PASSED`.
- [ ] **Step 5: Commit** `feat(duplicates): evidence and a cautious recommendation per group`

### Task 4: Duplicates UI — all accounts, evidence, "Bereinigen"

**Files:**
- Modify: `src/popup/views/Tools.tsx` (`DuplicatesTool`), `src/popup/views/tool-account.tsx` (all-accounts option), `src/popup/views/dup-compare.tsx` (evidence line component), popup CSS file that holds `.dup-group` styles, locales.

**Interfaces:**
- Consumes: `findDuplicates` (Task 1), `usageEvidence` RPC (Task 2), `assessGroup` (Task 3), `fieldLabel` (existing).
- Produces: `ALL_ACCOUNTS = "*"` constant exported from `tool-account.tsx`; `AccountSelect` gets prop `allowAll?: boolean` rendering the option `t("Alle Konten")` first.
- [ ] **Step 1:** `useToolAccount` / `AccountSelect`: `allowAll` option; Duplicates tool uses it and defaults to `ALL_ACCOUNTS` when more than one account is unlocked. Intro text replaced by `t("Sucht doppelte Einträge in einem oder allen entsperrten Konten.")`.
- [ ] **Step 2:** Load evidence once via `call("usageEvidence", {})` (reload after a trash action); `assessGroup` per group.
- [ ] **Step 3:** Per item: account chip (existing account colour/initials pattern from the vault list) when the group spans accounts; evidence line (`muted small`) built from `ItemEvidence`: `t("Passwort geändert {date}")` or `t("Angelegt {date}")` when `passwordChangedIsCreation`; `t("Auf diesem Gerät zuletzt ausgefüllt {date}")`; `t("Anmeldung erfolgreich {date}")` / `t("Anmeldung fehlgeschlagen {date}")`; `t("Veraltet: Passwort steht im Verlauf von „{name}“")`. Pills: `t("vermutlich aktuell")` on `recommended`; group subtitle `t("Unklar – bitte selbst prüfen")` when `unclear`. Remove the `neuester` pill and "Nur neuesten behalten".
- [ ] **Step 4:** Button `t("Bereinigen")` (`data-testid="dup-clean"`) only when `removable.length > 0`; confirm dialog lists each removable item as `„{name}“ ({account})` and below it, if any, `t("Nur in diesem Eintrag: {fields}")` from `uniqueFieldsOf`; ok label `t("In den Papierkorb")`, `danger: true`; then the existing `trash()` (generalised to take `{accountKey, id, name}[]` since items may come from several accounts).
- [ ] **Step 5: Verify:** `npx tsc --noEmit`; `node scripts/i18n-check.mjs --keys` reports nothing missing; `npm run build` succeeds; manual check in the built popup is not possible offline — note it for the final review.
- [ ] **Step 6: Commit** `feat(duplicates): all accounts, evidence and a safer clean-up button`

### Task 5: Outcome classification (pure)

**Files:**
- Create: `src/background/login-attempt.ts`
- Test: `tests/login-attempt.test.ts` (new)

**Interfaces:**
- Produces:
  - `export interface Attempt { host: string; site: string; items: { accountKey: string; itemId: string }[]; at: number; sawTotp: boolean }` (`site` = `baseDomain(url)`).
  - `export interface PageState { url: string; topFrame: CollectResult | null; frames: CollectResult[] }`
  - `export type Outcome = "success" | "failure" | "pending" | "unknown"`
  - `export const ATTEMPT_TTL = 5 * 60_000`
  - `export function classifyOutcome(a: Attempt, s: PageState | null, now: number): Outcome`
- Rules (from spec "Observation"): `null` state, `topFrame === null`, or `now - a.at > ATTEMPT_TTL` → `unknown`; other site (`baseDomain(s.url) !== a.site`) → `unknown`; any frame of the same site with `hasPassword` → `failure`; any frame with `hasTotp` → `pending`; else → `success` when the URL differs from the login page or `a.sawTotp`, otherwise `success` only if the top frame has no `hasUsername` either, else `unknown`.
- [ ] **Step 1: Write the failing tests:** `password field again → failure`; `totp page → pending`; `after totp, no fields → success`; `navigated away, no fields → success`; `same URL, username field still there → unknown`; `other site → unknown`; `top frame unreachable → unknown` (Review Focus 4); `cross-origin iframe with password field on another site → not failure` (frames of other sites are ignored); `expired attempt → unknown`.
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/login-attempt.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `classifyOutcome`. Note: `CollectResult` has no per-frame URL besides `url`/`origin` — use `origin` for the frame's site.
- [ ] **Step 4: Run** — expected `ALL PASSED`.
- [ ] **Step 5: Commit** `feat: classify the outcome of a login attempt`

### Task 6: Attempt tracking and the "Hat die Anmeldung geklappt?" question

**Files:**
- Modify: `src/background/notify.ts`, `src/background/index.ts` (construct `LoginOutcomes`, pass `collectFrames`; RPC handler), `src/shared/messages.ts` (`NotificationData.kind` adds `"confirmLogin"`, field `confirmItem?: { name: string; accountLabel: string; accountColor: string }`; RPC `notifyOutcome`), `src/notification/index.tsx` (render the new kind), `src/background/never-domains.ts` (separate list), `src/popup/views/Settings.tsx` (two switches + clear button), locales.
- Test: `tests/notify-outcome.test.ts` (new)

**Interfaces:**
- Consumes: `LoginOutcomes`, `itemRev` (Task 2); `classifyOutcome`, `Attempt`, `PageState`, `ATTEMPT_TTL` (Task 5); `collectFrames(tabId)` from `src/background/autofill.ts`; `findDuplicates` (Task 1).
- Produces:
  - `NotificationService` constructor gains `outcomes: LoginOutcomes` and `probe: (tabId: number) => Promise<PageState | null>` via the existing `hooks` object (`hooks.probe`).
  - RPC `notifyOutcome: { req: { token: string; answer: "yes" | "no" | "never" }; res: { ok: true } }`.
  - `addNeverAskDomain(host)` / `isNeverAskDomain(host)` in `never-domains.ts`, storage key `neverAskOutcome`.
- Behaviour (spec "Gating", "Attempt", "Observation", "Unknown"): split `capture()` so the attempt is recorded when `settings.trackLoginOutcome` is on even if both prompts are off; never on never-domains (save list) — blocked pages already never reach `capture`. Attempt items = `matchesForUrl(url)` filtered to exact username (case-insensitive, trimmed) and exact password. Store attempt in `session` under `"attempt:" + tabId`. Observe at the same moments `maybeShow` runs (after load complete; after `SHOW_DELAY` when no navigation): `classifyOutcome(attempt, await hooks.probe(tabId), Date.now())`; `success`/`failure` → `outcomes.record(item, ok)` for every attempt item, drop attempt; `pending` → set `sawTotp`, keep; `unknown` → if `settings.askLoginOutcome`, host not in never-ask, no save/update prompt is due for this submission, the item has a conflict (another unlocked matching login with same username and different password — use `findDuplicates` over `matchesForUrl(url)` in `"site"` mode and check the item's group has `samePassword === false`), and no record exists yet for this item+rev → show the bar with `kind: "confirmLogin"`; else drop.
- [ ] **Step 1: Write the failing tests** with a stub `VaultService` (pattern: `Object.create(VaultService.prototype)` as in `tests/autofill-hardening.test.ts`), in-memory `session`/`local` from `tests/chrome-stub.ts`, and a stub probe:
  - `success is recorded silently` (probe returns a page without fields, URL changed) → record ok, no notification sent.
  - `failure is recorded` (probe shows password field).
  - `unknown + conflict asks` → `dataFor(token).kind === "confirmLogin"`.
  - `unknown without conflict does not ask`.
  - `answer yes records success, no records failure, never adds the host and records nothing`.
  - `tracking works with both save prompts off`.
  - `never-domain: nothing recorded, nothing asked`.
  - `save prompt due wins over the question` (submitted password not saved yet → kind `save`/`update`, no confirmLogin).
  - `trackLoginOutcome off: nothing recorded`.
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/notify-outcome.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the tracker in `notify.ts`, `hooks.probe` in `index.ts` (frames from `collectFrames(tabId)`, top frame = `frameId === 0`, `url` from `chrome.tabs.get`), the bar UI (question text `t("Hat die Anmeldung mit „{name}“ geklappt?")`, buttons `t("Ja")`, `t("Nein")`, `t("Nicht mehr fragen")`), Settings switches `t("Anmelde-Ergebnis merken (für den Duplikat-Check)")`, `t("Bei unklaren Einträgen nachfragen")` and button `t("Gespeicherte Anmelde-Ergebnisse löschen")` → `clearLoginOutcomes`.
- [ ] **Step 4: Run** the test, `npx tsc --noEmit`, `node scripts/i18n-check.mjs --keys`, and the DOM test `CHROMIUM_PATH=… bash tests/run-node.sh tests/content-dom.test.ts` (the notification bar is untouched on the content side; must stay green) — expected all green.
- [ ] **Step 5: Commit** `feat: learn whether a login worked, ask only for conflicting entries`

### Task 7: "Aufräumen" tab

**Files:**
- Create: `src/shared/cleanup.ts`, `src/popup/views/Cleanup.tsx`
- Modify: `src/popup/views/Tools.tsx` (tab list: `"cleanup"` after `"duplicates"`, label `t("Aufräumen")`), locales
- Test: `tests/cleanup.test.ts` (new)

**Interfaces:**
- Consumes: `parseUrl`, `isPortScopedHost` (`src/shared/uri.ts`), `sameSharedItem` (Task 1), `Evidence` (Task 3), `usageEvidence` RPC (Task 2), `ALL_ACCOUNTS`/`AccountSelect` (Task 4).
- Produces (all pure, active logins only — not deleted, not archived, no `decryptError`):
  - `export function withoutWebsite(items: ItemView[]): ItemView[]` — no URI, or every URI fails `parseUrl`, or has a scheme other than http/https/androidapp/iosapp.
  - `export function portlessLocalUris(items: ItemView[]): { item: ItemView; uri: string }[]` — http(s) URIs whose host is port-scoped and that have no explicit port.
  - `export const STALE_MS = 365 * 24 * 60 * 60 * 1000`
  - `export function staleOnThisDevice(items: ItemView[], lastUsed: Evidence["lastUsed"], now: number): { item: ItemView; lastUsed?: number }[]`
  - `export function reusedAcrossAccounts(items: ItemView[]): ItemView[][]` — groups of logins with the same non-empty password spanning ≥ 2 accounts, shared org items counted once.
- [ ] **Step 1: Write the failing tests:** one per function incl. `https://10.0.0.5` flagged, `https://10.0.0.5:8443` not, `https://example.de` not; `androidapp://com.example` not "without website"; `never used → stale`, `used 13 months ago → stale`, `used last month → not`; `reuse within one account only → not listed`; `shared org item in two accounts → not reuse`; `empty passwords never reused`.
- [ ] **Step 2: Run** `bash tests/run-node.sh tests/cleanup.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `cleanup.ts`, then `Cleanup.tsx`: account selector with `allowAll` (default all), one collapsible section per check with count (`t("Ohne gültige Website")`, `t("IP-Adressen ohne Port")` + hint `t("Gilt nur für Port 80/443. Läuft der Dienst auf einem anderen Port, die Adresse ergänzen.")`, `t("Auf diesem Gerät lange nicht genutzt")` with rows `t("Auf diesem Gerät seit {date} nicht genutzt")` / `t("Auf diesem Gerät nie genutzt")`, `t("In mehreren Konten gleiches Passwort")`); rows open the item (`app.go({ name: "item", key: itemKey(i) })`); no bulk actions.
- [ ] **Step 4: Run** the test, `npx tsc --noEmit`, `node scripts/i18n-check.mjs --keys`, `npm run build` — expected green.
- [ ] **Step 5: Commit** `feat: cleanup tab with website, port, usage and reuse checks`

### Task 8: Release 1.6.0

**Files:**
- Modify: `package.json` (version), `../MultiWarden-local/CLAUDE.local.md` (features, versions, tests list) then copy to the working copy.

- [ ] **Step 1: Verify everything:** `npx tsc --noEmit`; offline tests `crypto policies hardening autofill-hardening clickjacking copy-item duplicates-compare uri-match login-outcomes dup-evidence login-attempt notify-outcome cleanup` each `ALL PASSED`; DOM test `ALL PASSED`; `node scripts/i18n-check.mjs --keys` clean.
- [ ] **Step 2:** Final whole-branch review (fresh reviewer) of `git diff 304ee50..HEAD`; fix CRITICAL/HIGH findings.
- [ ] **Step 3:** Bump to `1.6.0`, commit `chore: release 1.6.0`.
- [ ] **Step 4:** Sign, publish, push both remotes, copy to Unraid-2 (commands in Global Constraints); verify `updates.json` shows 1.6.0 and the downloaded xpi hash matches.
- [ ] **Step 5:** Update and push the notes in `MultiWarden-local`.
