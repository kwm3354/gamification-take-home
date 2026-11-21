# Brief 04: wheel and grant policy

Wave 2. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You implement the Wheel of Fortune of a NestJS + PostgreSQL + TigerBeetle prototype, plus one small configurable policy for granting spins. You work in your own git worktree on your own branch. Another agent works in parallel on the bonus store and redemptions (src/store, the outbound half of src/integrations, test/store.test.ts, test/judge.ts); do not touch those.

## Read first
CLAUDE.md, docs/contracts.md (binding; all of it, especially "What must never happen", "Shape", "Actors and audit", "Outbox", "Our HTTP API", "Wheel outcome"), docs/verification.md, src/schema.sql, src/domain/coin-ledger.ts, src/audit/audited.ts, src/outbox/outbox.ts and outbox.module.ts, src/ledger/ledger.module.ts, src/tenants/* (guard, `@CurrentPlayer()`, me.controller.ts, seed.ts, demo-tenants.ts), src/events/* (deposit.ts, events.controller.ts), src/config.ts, src/clock.module.ts, test/app.ts, test/fake.ts, test/signing.ts, test/intake.test.ts (the style to follow), src/fake-casino/server.ts (only to see the control API: /control/deposit, /control/token).

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (75 tests) before you change anything
```
The CPU has no AVX2; the script swaps in a local TigerBeetle build. Run it again after any npm install. Docker is running. Do not stop containers you did not start.

## Recipes from the agents before you
- Player endpoint: `@UseGuards(PlayerAuthGuard)` and `@CurrentPlayer() auth: PlayerAuth`; `auth.tenant.id`, `auth.player.id` come from the token. The controller's module imports `TenantsModule`.
- Row change with audit: inside `transaction(db, tx => ...)` call `update(tx, { tenantId, actor, requestId, now: clock.now() }, "spins", id, cur => cur.status === "available" ? { ... } : null)`. A null result means someone else got there first. Columns are snake_case; bigint columns come back as strings.
- Tokens: `@Inject(DB)`, `@Inject(CLOCK)`, `@Inject(COIN_LEDGER)`, `@Inject(OUTBOX)`, `@Inject(CONFIG)`. Injected classes are plain imports, never `import type`. Imports end in `.ts`.
- In CI all test files share ONE TigerBeetle server and the demo tenants use fixed ledger numbers 1 and 2. So tests must never assert an absolute tenant-wide ledger total, and must use fresh player ids (`randomUUID()`-based external ids) per test; per-player balances are then exact.

## Part 1: spin
Files you own: src/wheel/** (`pick-segment.ts` plain pure function; `spin.ts` plain domain logic; `wheel.controller.ts`; `wheel.module.ts`), src/tenants/me.controller.ts (add `balance`), test/wheel.test.ts.
- `pickSegment(wheelSecret, spinId, segments)` exactly as the contract says. Use BigInt for the 8-byte value. Validate: at least one segment, weights positive integers; throw otherwise.
- `POST /wheel/spins/:spinId/spin` (guarded). Steps:
  1. In one transaction: `update` the spin with a `change` that returns null unless the row's tenant_id and player_id equal the token's AND status is "available"; on success set status "used", segment_index, coins, used_at, and `outbox.enqueue(tx, { tenantId, kind: "spin_credit", refId: spinId })`.
  2. If the update returned null: load the spin by id + tenant + player. Not found -> 404 (never reveal that a spin of another player or tenant exists). Found and "used" -> this is a repeat: make sure the job exists if `credited_at` is null (enqueue again in a small transaction), and return the stored result.
  3. After commit, if `config.inlineJobs` is true, run the credit step directly (the same function the outbox handler calls) and swallow `LedgerUnavailable` (the queued job will retry). The answer never waits on the ledger being healthy.
  4. Answer 200 `{ spinId, segmentIndex, label, coins }`, identical for every repeat. `coins` is a number in JSON here (prizes are small); balances are strings.
- The credit step `creditSpin(spinId)`: load the spin; if `credited_at` is set, done; call `coins.creditPrize({ ledgerNo, playerId, spinId, coins })` (playerId = our player uuid); then `update` the spin setting `credited_at` (actor `system/outbox`). Register it in the module's `onModuleInit` as `outbox.handle("spin_credit", ...)` returning "done". A segment with 0 coins is not allowed by the validator, so every spin credits something.
- The spin uses the wheel config row it was granted with (`wheel_config_id`) and the tenant's `wheel_secret`. Actor for the player's update: `player/<player id>`.
- `GET /wheel` (guarded): newest config of the token's tenant: `{ version, segments: [{ label, coins }] }` (no weights).
- `GET /me`: add `balance: { available, reserved }` as strings from `coins.balance`. If the ledger is unavailable answer 200 with `balance: null` (the page must still load).

## Part 2: grant policy (a configurable rule for "how many spins does a deposit give")
The product owner decided: grant conditions are parameters in versioned settings, and adding a condition later must be cheap. Build the smallest honest version.
Files you own for this: src/policies/grant-policy.ts (new, plain), src/events/deposit.ts (edit), src/tenants/seed.ts and src/tenants/demo-tenants.ts (edit: add the demo policy), src/schema.sql (edit, see below), src/audit/audited.ts (only to add `grant_policies` to the allowlist), docs/contracts.md (add a short section "Grant policy" and fix the lines this changes; keep the rest untouched), test/grant-policy.test.ts (new), and the existing tests in test/intake.test.ts / test/audit.test.ts only where the schema change forces an edit.
- Schema: new table `grant_policies (id uuid pk default gen_random_uuid(), tenant_id text not null references tenants(id), version integer not null, params jsonb not null, created_at timestamptz not null default now(), unique (tenant_id, version))`, append-only with the same trigger as wheel_configs. In `spins`: add `ordinal integer NOT NULL DEFAULT 1` and `grant_policy_id uuid REFERENCES grant_policies(id)`, and replace the UNIQUE on `source_event_id` with `UNIQUE (source_event_id, ordinal)`. The schema file is the only migration and no database exists yet, so edit the CREATE TABLE statements in place; keep every statement safe to run twice.
- `params` type: `{ minAmountMinor: number; currencies: string[] | null; spinsPerDeposit: number }` (`currencies: null` = any). A validator with hard limits: minAmountMinor integer >= 0; spinsPerDeposit integer 0..10; currencies null or a non-empty list of 3-letter codes. Seed version 1 for both demo tenants: `{ minAmountMinor: 1, currencies: null, spinsPerDeposit: 1 }`.
- Decision point, a pure function: `spinsForDeposit(deposit: DepositSucceeded, params): { spins: number } | { spins: 0; reason: string }` (reasons: "below_minimum", "currency_not_allowed", "zero_spins"). Write it so that the next condition is one more small check in one obvious place; put a three-line comment at the top saying how to add a condition (extend params + validator, add the check, add a test row).
- `deposit.ts`: after storing the inbound event, load the tenant's newest grant policy, call `spinsForDeposit`, create that many spins (ordinal 1..n, each with `grant_policy_id`), all in the same transaction as the event. When 0 spins: the event is still stored and counted as accepted, and one audit `record` is written (action "spin_not_granted", entityType "inbound_event", entityId = the event row id, changes `{ reason, grantPolicyId }`). A duplicate event still creates nothing.
- test/grant-policy.test.ts: a table-driven unit test of `spinsForDeposit` and the validator; and through HTTP (`startApp`, `seedDemo`, then insert a version 2 policy for one tenant with `create` from audited.ts): min amount 5000 -> a 20.00 deposit gives no spin and the audit row; `spinsPerDeposit: 2` -> two spins with ordinals 1 and 2 and DIFFERENT outcomes possible (their ids differ), and the same deposit sent again adds none; currencies ["EUR"] -> a USD deposit gives none; the other tenant is unaffected; a spin granted under version 1 keeps `grant_policy_id` of version 1 after version 2 appears.

## Tests for part 1 (test/wheel.test.ts) - whole app over real HTTP, real PostgreSQL, real TigerBeetle, the fake casino as the event source
Start the fake with test/fake.ts pointing at the app's url; `seedDemo(running.db, running.clock, fake.url)`. Send deposits with the fake's `/control/deposit` and get tokens from `/control/token` (the fake signs with the real clock; the app in tests runs on a FakeClock that starts at the real time and stands still, which is fine as long as you do not move it far; if a check needs a moved clock, sign with test/signing.ts instead). Cover at least:
1. Happy path on platform A and on platform B: deposit -> /me shows one available spin and balance 0 -> spin -> 200 with a segment from the table -> /me shows the spin used and `available` equal to the prize.
2. Concurrent spin requests: 20 identical POSTs at once for one spin: all 200 with the same body, the ledger balance equals exactly one prize.
3. Repeat after the fact: a second POST later returns the same body, balance unchanged.
4. Determinism: `pickSegment` unit cases (known secret + spin id -> stable index; over 20,000 random spin ids the share of each segment is within 2 percentage points of its weight; changing the secret changes outcomes). The HTTP result equals `pickSegment` computed in the test from the seeded secret, the spin id and the seeded segments.
5. The client cannot choose: a body `{ "segmentIndex": 3, "coins": 500 }` in the POST changes nothing.
6. Crash between PostgreSQL and the ledger: start an app with `config: { inlineJobs: false }`; spin -> 200; balance still 0 and `credited_at` null; then `outbox.runDue()` -> balance equals the prize; running it again changes nothing.
7. Ledger away at spin time: this needs the credit to fail while PostgreSQL works. Build the app normally, then make the credit step fail once by wrapping the injected ledger in the test (`running.app.get(COIN_LEDGER)`; replace its `creditPrize` with a function that throws `LedgerUnavailable` the first time and delegates afterwards). The spin still answers 200; after `running.clock.advance(2000)` and `runDue()` the balance is right.
8. Someone else's spin: player B of the same tenant, and a player of the other tenant, both get 404 and the spin stays available.
9. Wheel config version: insert version 2 with different segments after a spin was granted; the old spin still resolves with version 1's table; a new deposit's spin uses version 2.
10. No token / bad token -> 401. Unknown spin id / malformed id -> 404.
11. Audit: the spin has rows create (actor platform/...), update available->used (actor player/...), update credited_at (actor system/outbox), readable through SQL on audit_log by entity id.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation checks before you finish; restore each and report which test caught it; fix the tests if one is not caught: (a) make the spin `change` ignore the status check (always proceed); (b) make `creditSpin` skip the `credited_at` early return AND derive nothing new, i.e. just confirm repeats are harmless: instead mutate the ledger id to include a random suffix in a local experiment by calling creditPrize with `spinId + "-x" + Math.random()` -> the concurrency/repeat tests must fail; (c) make the 404 check ignore tenant/player; (d) make `spinsForDeposit` ignore `minAmountMinor`.
- Domain logic in plain files without Nest decorators; controllers and modules are thin. No `new Date()` / `Date.now()` in src. Plain English comments, short sentences.
- Commit on your branch when green, as two commits: the spin, then the grant policy (each with verify green). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`. For the policy row, "who decided" is "Author (grant conditions are versioned parameters); agent (the shape)".

## Report back (read by a person who does not read the code; under 45 lines)
Branch and commit hashes; for the spin and for the grant policy: what it does, what can break, which test catches it (three lines each); mutation check results; DEVIATIONS from or additions to the contract; for each of these likely change requests say which file changes and roughly how many lines: "two spins for a deposit of 100 or more", "at most 3 spins per player per day", "only EUR deposits count", "a new wheel segment"; what is not tested.
````

## The agent's report

````text
Both parts are built and committed on branch `worktree-agent-a7f7edb0e550944d7`. `npm run verify` is green on each commit: 93 tests after the spin, 123 after the grant policy.

- `372b1f6` Wheel of fortune
- `09d4b2c` Grant policy

## Spin
- **What it does:**
  - A spin is used under the database row lock, and the credit job is queued in the same transaction.
  - The prize is credited with a ledger id derived from the spin id, inline when possible and by the outbox otherwise.
  - A repeat returns the stored result, and `/me` answers with `balance: null` if the ledger is away.
- **What can break:** a crash after the commit leaves the spin used but not credited. The queued job repairs this. The ledger being away at spin time gives the same result.
- **Which test catches it:** in `test/wheel.test.ts`, test 6 covers the crash, test 7 the ledger being away, tests 2 and 2b the races, and test 3 repeats and the outbox job after an inline credit. There are 18 tests in total.

## Grant policy
- **What it does:** `grant_policies` is append-only and versioned. `spinsForDeposit` is a pure function. `validateGrantParams` enforces the hard limits. Each spin stores `grant_policy_id` and `ordinal`. Zero spins still stores the event, counts it as accepted and writes a `spin_not_granted` audit record.
- **What can break:** a tenant with no policy row makes intake throw. The seed creates version 1 for both demo tenants.
- **Which test catches it:** `test/grant-policy.test.ts` has 30 tests, covering the table-driven unit cases, the validator limits, and HTTP with versions 2 to 4 for one tenant while the other is unaffected.

## Mutation checks
- **(a) No status check in the spin update:** the first version of the tests missed it, because the frozen clock hides the extra write. I added test 2b, where requests are blocked on the row lock while another use commits. Now 2b catches it, and so do test 2, test 3 and test 3's audit-count check when the outer status guard is also removed.
- **(b) Random suffix on the ledger id, no `credited_at` early return:** the first version missed it. I changed test 3 to run the outbox job after the inline credit, and it now catches it.
- **(c) 404 check ignores tenant and player:** caught by test 8.
- **(d) `spinsForDeposit` ignores `minAmountMinor`:** 3 tests fail.

## Deviations and additions
- `src/schema.sql`: added `grant_policies`, `spins.ordinal` and `spins.grant_policy_id`, and changed the unique key to `(source_event_id, ordinal)`.
- `test/audit.test.ts`: two small edits forced by the schema change (the audit field list and the seed count).
- `docs/contracts.md`:
  - new "Grant policy" section;
  - `/me` balance may be `null`;
  - never-happen rule 1 now refers to the policy;
  - ordinals give independent outcomes.
- The player's audit actor is `player/<our player uuid>`, as your brief said. The token guard uses the external id for its own player create row, so the two differ.
- Currency codes in a policy must be upper-case.
- Two `docs/ai-log.md` rows were added.

## Likely change requests
- **Two spins for a deposit of 100 or more:** about 10 to 15 lines in `src/policies/grant-policy.ts`. Add a `bonusAmountMinor` param and its validator check, plus one test row. This needs a small tweak to the "one more check" shape, because it changes the count rather than refusing.
- **At most 3 spins per player per day:** it needs history. It is about 25 lines in `src/events/deposit.ts` for a count query, plus a param and a check in the policy file. The pure function would take a `spinsToday` argument.
- **Only EUR deposits count:** no code change. Insert a new policy version with `currencies: ["EUR"]`, which is one row.
- **A new wheel segment:** no code change. Insert a new `wheel_configs` version. The weights must stay positive integers.

## Not tested
- A real process kill. Test 6 stands for the crash with `inlineJobs: false`.
- A policy row inserted with invalid params. The validator is unit-tested, but intake would throw on a bad row.
- Distribution of outcomes across many policy versions.
- The `docker compose` path.
- The new `docs/contracts.md` section was not reviewed against the other agent's store work.
````
