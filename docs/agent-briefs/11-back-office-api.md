# Brief 11: back office api

Wave 5. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You build the server side of a real back office for a working NestJS + PostgreSQL + TigerBeetle prototype (a gamification service for casino operators: deposit -> wheel spin -> coins -> redemption -> the casino platform issues the reward). It has 226 passing backend tests. Today the admin endpoints are protected by a shared key in a header; the owner rejected that: "a leaky admin in the demo is a failure, the player already has cryptographic authentication". You replace it with real sign-in and roles, then add the read endpoints the back office needs, then the settings-change intent. You work in your own git worktree on your own branch.

Others working in parallel, do not touch their files: a frontend agent owns web/**; a fixes agent is changing src/ledger/**, src/domain/coin-ledger.ts, src/wheel/spin.ts, src/store/redemption.ts, src/outbox/outbox.ts, src/tenants/players.ts, src/tenants/player-auth.guard.ts, src/events/deposit.ts, and a few lines of src/admin/resolve.ts and src/audit/audited.ts (request id default). Keep your edits in those last two files small and local so the merge is easy; do not reformat them.

## Read first
CLAUDE.md, docs/contracts.md - ALL of it; the binding sections for you are "Admin and operations", "Back office API", "Changing the wheel: an intent that a policy confirms" and "Admin sign-in and roles" (they are the specification; implement them exactly, including status codes). Then docs/verification.md, src/schema.sql, src/audit/audited.ts, src/admin/* (guard, controller, stuck, resolve, audit-trail), src/alerts/*, src/tenants/* (player-token.ts shows the JWT style to mirror; seed.ts; demo-tenants.ts), src/policies/grant-policy.ts, src/wheel/pick-segment.ts (segment validation), src/store/redemption.ts (`toView`), src/logging/*, src/config.ts, test/app.ts, test/admin.test.ts, test/alerts.test.ts, test/signing.ts, src/fake-casino/server.ts and public/index.html (they use the admin key today).

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (226 tests) before you change anything
```
The CPU has no AVX2; the script swaps in a local TigerBeetle build. The disk is nearly full: do not run docker compose; delete your own /tmp/tb-* directories if a run is killed. Do not stop containers you did not start.

## Commit 1: sign-in and roles (replaces the key headers everywhere)
- Schema: table `admin_users` as in the contract; drop the column `tenants.admin_key` (edit the CREATE TABLE in place: the schema file is the only migration and no database exists yet; keep every statement safe to run twice). Add `admin_users` to the audit allowlist and mask `password_hash` in audit `changes` as "***".
- `src/admin/password.ts` (plain): `hashPassword(password, salt?)` and `verifyPassword(password, stored)` with `crypto.scrypt` (N=16384, r=8, p=1, 32-byte key, 16-byte random salt), format `scrypt$16384$8$1$<salt b64>$<hash b64>`, `timingSafeEqual`, and a fixed dummy hash verified when the email is unknown so both paths cost the same.
- `src/admin/admin-token.ts` (plain): sign and verify HS256 JWTs with node:crypto as the contract says (`aud` "backoffice", 30 minutes, clock injected). Reject alg other than HS256, wrong `aud`, expired, `exp` more than 30 minutes ahead, bad signature (timing-safe). Config: add `adminTokenSecret` to src/config.ts from env `ADMIN_TOKEN_SECRET`; `loadConfig` throws if it is missing or shorter than 32 characters; test/app.ts sets a test value (add only that line and what login helpers need).
- `src/admin/admin-auth.ts`: `POST /admin/auth/login`, `GET /admin/auth/me`, the guard (loads the user on every request; disabled -> 401), a `@CurrentAdmin()` decorator, and `can(admin, action, tenantId)` in ONE plain file `src/admin/permissions.ts` with the table from the contract. Tenant mismatch -> 404; missing right -> 403; no or bad token -> 401. Lockout after five failures in a row for 15 minutes by the injected clock; audit records `admin_login` / `admin_login_failed` (tenantId null for a platform admin or unknown email; never the password; for an unknown email store the email as given, cut to 100 chars).
- Convert every existing admin endpoint (audit, stuck, resolve, alerts) to the new guard and `can`. Resolve needs `tenant_admin` or `platform_admin`. The audit actor becomes `admin/<user id>` from the token. Remove `X-Admin-Key`, `X-Admin-Name` and the old guard completely.
- Seed: demo users from the contract, with demo passwords defined in src/tenants/demo-tenants.ts (plain strings there; hashes computed by the seed; seeding twice changes nothing and writes no second audit rows).
- The fake casino and its control panel page used the admin key: remove `adminKey` from `/control/config` and remove the "Operations" section from src/fake-casino/public/index.html (replace it with one line linking to the back office at `{appUrl}/app/#/admin`); fix test/playground.test.ts and test/fake-casino.test.ts accordingly.
- Tests: update test/admin.test.ts and test/alerts.test.ts to sign in (add a helper `loginAs(running, email)` in a new file test/admin-login.ts). New test/admin-auth.test.ts over real HTTP: login success; wrong password, unknown email, disabled user -> the same 401 body; lockout after five failures and unlock after `clock.advance(15 min)`; a success resets the count; token expiry by the clock; a tampered token; `alg: none`; a PLAYER token on an admin endpoint -> 401 and an ADMIN token on a player endpoint (`/me`) -> 401; a token signed with a tenant's player token secret -> 401; the role table from the contract, every cell (viewer cannot resolve: 403; alpha's manager on beta's path: 404; platform admin on both: 200); a disabled user's still-valid token -> 401; the audit trail shows `admin/<user id>` as the actor of a manual resolution and has login records without any password; `password_hash` is masked in audit; unit tests of password hashing (same password, two salts, different hashes; verify true/false).
Commit when `npm run verify` is green.

## Commit 2: read endpoints of the back office
Everything in the table "Back office API" of the contract except the settings change: overview, redemptions list and detail, players list and detail, events list and detail, spins list, outbox list, audit (`recent=1` form), settings (read), `GET /platform/tenants`. Put the queries in plain files under src/admin/ (one file per resource, e.g. `list-redemptions.ts`), thin controllers. Pagination by `(created_at, id)` or by id where the table has a bigserial; the cursor is an opaque string (base64url of the pair); a malformed cursor or filter value -> 400. `limit` 1..100. Every query has `tenant_id = $1` and a test that proves it. `coinsOutstanding` and player balance come from the ledger port and are null when it throws `LedgerUnavailable` (the page must still load). Expected prize of a wheel = sum(coins * weight) / sum(weight): reuse the function in src/alerts/ if one exists, do not write a second one.
Tests (test/backoffice.test.ts, real HTTP, data created through the real flow with the fake casino as in test/store.test.ts, a few dozen rows by direct inserts through the audit functions where volume is needed): each endpoint returns the documented shape; filters work; pagination walks 120 rows in pages of 50 without a gap or a repeat while new rows are inserted between pages; tenant isolation for every endpoint (beta's manager sees none of alpha's rows and gets 404 for alpha's ids); a viewer can read all of it; detail of a redemption includes its audit rows oldest first and the job row; overview numbers equal counts computed by SQL in the test; the ledger being away gives null, not 500.

## Commit 3: the settings-change intent
Table `settings_changes` and the three calls in "Changing the wheel" plus `GET /platform/settings-changes`, exactly as the contract says. Plain logic in `src/admin/settings-change.ts`: validate, compute the expected prize, decide by the newest ops policy (`maxExpectedPrizeCoins`), create the next `wheel_configs` version through the audit functions (version = max + 1; two concurrent applies must not produce the same version: lock or retry on the unique key, and test it). All in one transaction with the change row. Audit: the change row's create and update rows carry the actor (`admin/<user id>` for a person, `policy/ops-v<N>` for the automatic decision; the automatic apply writes the status update with the policy as actor).
Tests (test/settings-change.test.ts, real HTTP): a wheel within the limit is applied at once (201, new version, `decided_by` the policy) and `GET /wheel` with a player token then shows the new segments; a wheel above the limit waits (202) and `GET /wheel` is unchanged; the tenant's manager cannot approve (403); the platform admin approves -> applied, new version; reject -> rejected, no version; approving twice at once applies once; a second decision -> 409; a viewer cannot propose (403); invalid segments -> 400 (each rule); a spin granted before the change still resolves with its old wheel (same outcome as before the change) and a spin granted after uses the new one; the alert `wheel_expected_prize_high` fires after an approved over-limit wheel; the other tenant's wheel is untouched; everything is in the audit trail with the right actors.

## Rules
- Each commit: `npm run verify` green first. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation checks before you finish (restore each; report which test caught it; fix the tests if one is not caught): (a) make `can` return true for everything; (b) skip the `aud` check; (c) skip the password comparison; (d) drop the tenant filter from the redemptions list; (e) make the settings decision ignore the limit; (f) let a tenant admin approve.
- Domain logic in plain files without Nest decorators; controllers, guards and modules are thin. No `new Date()` / `Date.now()` in src: inject CLOCK. Imports end in `.ts`; injected classes are plain imports, never `import type`. Plain English comments, short sentences. No new npm dependencies.
- Secrets: never log or audit a password, a hash, or a token. The logging tests scan lines for secrets: add the demo passwords and the admin token secret to that scan (test/logging.test.ts) and log `admin.login` (info) { userId, role } and `admin.login_failed` (warn) { reason: "bad_credentials" | "locked" } through the existing Log.
- docker-compose.yml: add `ADMIN_TOKEN_SECRET` with a clearly-demo value of at least 32 characters to the `app` service (one line; another agent may edit other lines of that service). .github/workflows/ci.yml needs no change unless a test needs the env.
- Commit messages: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (real sign-in instead of a key header; a proper back office; settings change as an intent confirmed by policy); agent (the design in the contract and the code)".
- If the contract is wrong or incomplete, take the smallest sensible reading, list it under DEVIATIONS, and do not edit the contract except to correct a statement your code makes false (say which).

## Report back (read by a person who does not read the code; under 45 lines)
Branch and the three commit hashes; total tests; per commit: what it does, what can break, which test catches it (three lines); mutation check results; the demo users and their passwords; an exact curl sequence that signs in and lists redemptions (it goes into the README); DEVIATIONS; anything wrong you noticed elsewhere (do not fix; list); what is not tested.
````

## Follow-up message 1, sent while the agent was working

````text
One addition to commit 1, needed by the frontend agent: `GET /app-config.json` (src/web.ts) must also return `demoAdmins: [{ email, password, role, tenantId }]` with the four demo users, but ONLY when the demo seed is on (`config.seedDemo` true); when it is off, omit the field entirely. This is how the sign-in page offers the demo accounts without passwords in the JavaScript bundle. Take the values from src/tenants/demo-tenants.ts. Add a test for both cases (seed on: four entries; seed off: no field). Say in a comment that this exposes demo passwords on purpose and only in demo mode.
````

## The agent's report

````text
Now logging test, outbox test, audit test.
````
