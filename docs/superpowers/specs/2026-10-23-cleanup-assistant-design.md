# Cleanup assistant: which duplicate is the current one

Date: 2026-10-23 · Status: approved 2026-10-23 · Target: next release (1.6.0)

## Intent

With several accounts in one combined vault, the same login often exists more than once — in one
account or across accounts — with different passwords. Today the duplicate check (Tools →
Duplikate) shows *that* passwords differ, but not *which one is current*, and its only bulk action
("Nur neuesten behalten") keeps the entry with the newest `revisionDate`, which also changes when a
note or folder is edited. The user wants help to clean up: see which entry is actually in use / works,
and remove the rest safely.

No signal proves that a password works today. The feature therefore shows **evidence with dates** and
gives a cautious recommendation; it never declares an entry safe to delete.

## Goals

1. Fix two defects in the duplicate check:
   - `duplicateKeys()` uses `hostnameOf()` and ignores the port. Since 1.5.2 matching treats a port on IPs /
     localhost / single-label hosts as a separate service (`isPortScopedHost` in `src/shared/uri.ts`), so
     `10.0.0.5:8080` and `10.0.0.5:5765` with the same username must not be duplicates. Normal domains keep
     grouping by hostname (port ignored), consistent with matching.
   - `compareGroup()` trims every value; for secret fields (password, TOTP, card number/code, private key,
     secret custom fields) leading/trailing whitespace is significant. Compare secrets untrimmed.
2. Duplicates **across accounts**: the account selector of the duplicate tool gets an "Alle Konten" choice.
   Groups may then span accounts; every entry shows its account (colour/initials/label) and, where set, its
   organization. Items are identified by `(accountKey, id)` everywhere (they already are via `itemKey`).
3. **Evidence per entry** in login groups whose passwords differ (`samePassword === false`):
   - "Passwort geändert {date}" from `login.passwordRevisionDate` (fallback: `creationDate`, labelled as such).
   - "Hier zuletzt ausgefüllt {date}" from `lastUsed` (this device only; wording must say so).
   - "Anmeldung erfolgreich {date}" / "Anmeldung fehlgeschlagen {date}" from the new login-outcome record (goal 5).
   - "Veraltet: Passwort steht im Verlauf von „{name}“" when this entry's password equals a `passwordHistory`
     entry of another group member (comparison in memory only).
4. **Recommendation** "vermutlich aktuell" for at most one password variant per duplicate group, derived by
   fixed rules (below). A bulk button "Bereinigen" removes only what strong evidence marks as redundant;
   its confirmation lists every entry that goes to the trash, with account names, and every field that exists
   only in an entry being removed (from `compareGroup`: non-empty in that entry, empty or different in the kept one —
   e.g. TOTP, passkeys, notes, custom fields, attachments). "Nur neuesten behalten" (revisionDate) is replaced by
   "Bereinigen" with the stricter rules below.
5. **Login outcome tracking** (new signal), stored locally per item: when a submitted login form's
   username + password exactly equal those of a matching item (same rules as `matchesForUrl`), MultiWarden
   observes the outcome and records success or failure.
6. **Ask only when unclear**: if the outcome cannot be determined *and* the submitted item belongs to a group of
   matching items for that site + username with differing passwords (in any unlocked account), the notification
   bar asks "Hat die Anmeldung mit „{name}“ geklappt?" — Ja / Nein / Nicht mehr fragen (per site). Never for
   items without such a conflict; at most once per item and password.
7. **Cleanup checks** — a new Tools tab "Aufräumen" (all unlocked accounts by default, account selector like the
   other tools), each check a collapsible section with a count, entries clickable to open the item:
   - Logins without any website, or with a website that does not parse (`parseUrl` fails) or has a non-web,
     non-app scheme.
   - Websites on IP / localhost / single-label hosts **without explicit port** — hint only: "Gilt nur für Port
     80/443. Läuft der Dienst auf einem anderen Port, die Adresse ergänzen." Never guess a port.
   - Logins not filled on this device for 12 months or never (label: "Auf diesem Gerät seit … nicht genutzt" /
     "Auf diesem Gerät nie genutzt") — informational, no bulk action.
   - Passwords reused **across accounts** (the password report covers reuse within one account; this section
     lists only groups that span ≥ 2 accounts). Compared in memory, never persisted.

## Non-goals

- Proving that a password works, or testing passwords against a site automatically. Never submit a stored
  password by ourselves.
- Site-specific login-success detection rules.
- Automatic deletion, archiving or merging. Every removal is a user action with confirmation, into the trash.
- Merging two entries into one (could come later).
- Syncing outcome records between devices or to the server.

## Anti-goals (failure even if it works)

- The working password ends up in the trash because the UI suggested it was safe.
- Prompts on normal logins: the question must stay rare (only goal 6 conditions).
- Any password, hash, or derivative written to storage for this feature.

## Recommendation rules (goal 4)

Within a duplicate group, items with the same password form a *variant*. One variant at most is
recommended ("vermutlich aktuell"), decided in this order (direct observation beats inference):

1. **Login outcomes.** If exactly one variant has the newest success record, and no failure newer than it,
   it wins. A variant whose latest record is a failure is *outdated*.
2. **History.** A variant whose password appears in another member's `passwordHistory` is *outdated* — unless
   rule 1 picked it. If two variants each appear in the other's history (password changed back), history
   decides nothing.
3. **Password date.** Among the variants not outdated: the unique newest `passwordRevisionDate` wins.
4. Otherwise: no recommendation ("Unklar – bitte selbst prüfen").

Within a variant (identical passwords) the entry to keep is: the one with a success record, then most recent
`lastUsed`, then newest `revisionDate`. `lastUsed` and `revisionDate` never decide between variants.

**Bulk button "Bereinigen"** (replaces "Nur neuesten behalten"; *my call, conservative per the anti-goal*): it
only removes entries backed by strong evidence — (a) identical copies inside a variant (all but the entry to
keep), and (b) whole variants that are *outdated* by rule 1 or 2. A variant that merely loses on rule 3 is never
bulk-removed; it keeps its per-entry trash button. If nothing qualifies, the button is not shown. The
confirmation lists every entry that goes to the trash with its account, and every field that exists only in an
entry being removed (goal 4).

**Groups without differing passwords** (same password, and card / identity / note / SSH groups; *my call*):
the bulk button removes identical copies using the within-variant order above (`lastUsed`, then `revisionDate`)
with the same confirmation listing unique fields. Evidence lines are shown only for login groups with
differing passwords.

**Same item seen through two accounts** (*my call*): two unlocked accounts in one organization see the same
cipher as `(accountA, id)` and `(accountB, id)`. Items with the same `organizationId` and `id` are one item: they
never form a duplicate group with each other, never count as cross-account reuse, and are listed once (under the
first account in sort order).

## Login outcome detection (goal 5)

Hooks into the existing capture flow in `src/background/notify.ts` (`capture()` → navigation → `maybeShow()`),
but as a separate tracker; the save/update prompt logic stays unchanged.

- **Gating** (*my call*): the tracker is gated only by its own setting, not by `promptSave` / `promptUpdate`, so
  `capture()`'s early return for disabled prompts must be split. Never-domains and pages blocked for autofill
  (content-side `blocked()`) get neither silent recording nor the question.
- **Attempt**: at capture (password present, no `newPassword`), find matching items whose username
  (case-insensitive, trimmed) and password (exact) equal the submission. None → no tracking. Keep the attempt
  in `session` storage per tab: `{ host, items: [(accountKey, id, passwordRevisionDate)], at, step }`.
- **Observation**: after the next completed load of the tab, or after the SPA delay when no navigation started
  (same timing as `maybeShow`), ask the top frame's content script for its page state: does it show a visible,
  fillable password field (`isPasswordField` + `isVisible`), a visible TOTP field (`isTotpField`)?
  - Same host, password field visible again → **failure**.
  - TOTP field visible → **pending**: keep the attempt, observe the next load (max. 5 minutes from capture);
    if the user then leaves the TOTP page without a password field appearing → success.
  - Same registrable domain or a navigation away from the login page with no password and no TOTP field →
    **success**.
  - Anything else (tab closed, other site, timeout, content script unreachable) → **unknown**.
- **Unknown** + goal 6 conditions → show the question in the notification bar (new `kind: "confirmLogin"`).
  Answer Ja/Nein records success/failure; "Nicht mehr fragen" stores the host in a separate never-ask list.
  If the save/update prompt is due for the same submission, it wins and no outcome question is shown.
- **Record**: `chrome.storage.local` key `loginOutcome:<accountKey>` → `{ [itemId]: { at, ok, rev } }` where
  `rev` is the item's `passwordRevisionDate` (or `revisionDate` if missing) at the time. A record whose `rev`
  differs from the current item is ignored and pruned (password changed, also by sync). Only the latest record
  per item is kept. No passwords or hashes.
- **Settings**: "Anmelde-Ergebnis merken (für den Duplikat-Check)" (default on) and "Bei unklaren Einträgen
  nachfragen" (default on); a button "Gespeicherte Anmelde-Ergebnisse löschen". Records of an account are
  removed when the account is removed, like `lastUsed`.

## Constraints

- Code, comments and commits in English; UI strings German first with English mirror in
  `src/shared/locales/en.json` (other locale files: add the key only where the existing workflow does).
- The fork is public: no homelab details (hostnames, IPs other than documentation ranges) in code, tests or docs.
- Every new security-relevant test must fail on the unfixed code first (positive control).
- Offline tests (`tests/run-node.sh`) for: duplicate key port rule, untrimmed secrets, cross-account grouping,
  recommendation rules, outcome classification (pure function over page state + attempt), record invalidation.
  DOM test (`tests/content-dom.test.ts`) for the content-side page-state probe.
- `npx tsc --noEmit`, all offline tests and the DOM test pass before release; version 1.6.0; signed and
  published via `amo-sign.mjs` + `publish-update.mjs`.

## Left to the builder

- Exact component structure of the new "Aufräumen" tab and how sections collapse.
- Message names between background and content script for the page-state probe.
- Styling of evidence lines and the recommendation pill (follow existing `pill` / `muted small` patterns).
- Whether the cross-account reuse section shares code with `PasswordReport.tsx`.
