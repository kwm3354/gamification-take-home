# Brief 03: audit tenants intake

Wave 1. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You implement the entry side of a multi-tenant NestJS + PostgreSQL prototype: the audit write path, tenants and player identity, and the intake of deposit events from two casino platforms up to the point where a player owns a wheel spin. You work in your own git worktree on your own branch. Two other agents work in parallel on other files (the coin ledger and outbox; a fake casino). You do not use the ledger or the fake.

## Read first
CLAUDE.md, docs/contracts.md (binding; all of it, especially "What must never happen", "Shape", "Tenants and demo data", "Actors and audit", "Our HTTP API", "Platform A", "Platform B"), docs/verification.md, src/schema.sql, src/domain/casino-platform.ts (the port you implement the inbound half of), src/tenants/demo-tenants.ts, src/config.ts, src/clock.ts, src/clock.module.ts, src/db.ts, src/db.module.ts, src/main.ts, src/app.module.ts, src/health/*, test/app.ts, test/health.test.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green before you change anything
```
(The CPU has no AVX2; the script swaps in a local TigerBeetle build so the app can boot in tests.) Docker is running; tests start their own PostgreSQL. Do not stop containers you did not start.

## Files you own (create or edit only these)
- src/audit/audited.ts (plain functions, no Nest): `create`, `update`, `remove`, `record` exactly as in the contract, each taking a `pg.PoolClient` that is inside a transaction (use `transaction()` from src/db.ts at the call sites).
- src/tenants/**: `tenants.ts` (plain: `findTenant(db, id)`, row type `Tenant` in camelCase), `seed.ts` (`seedDemo(db, clock, fakeCasinoUrl)`: idempotent; creates the two tenants, wheel config version 1 and the store items from demo-tenants.ts through the audit functions with actor `system/seed`; running it twice changes nothing and writes no second audit rows), `player-token.ts` (plain: verify an HS256 JWT with node:crypto), `player-auth.guard.ts` + a `@CurrentPlayer()` param decorator (Nest), `me.controller.ts` (`GET /me`), `players.ts` (plain: `findOrCreatePlayer(tx, ctx, tenantId, externalId)`), `tenants.module.ts` (edit: wire it; run seedDemo in `onApplicationBootstrap` when CONFIG.seedDemo is true; export what other modules need, at least the guard). Do not edit demo-tenants.ts.
- src/integrations/**: `platform-a.ts` and `platform-b.ts`, one plain class per platform implementing `CasinoPlatform`: write `parseEvents` and `parseRewardNotice` fully; `issueReward` and `findReward` are added by a later agent, so make them throw `new Error("not implemented yet")` with a one-line comment. `platforms.ts`: the registry providing the token `PLATFORMS`. `integrations.module.ts` (edit): `@Global()`, provide and export PLATFORMS.
- src/events/**: `events.controller.ts` (`POST /webhooks/:tenantId/events`), `deposit.ts` (plain: what a succeeded deposit does), `events.module.ts` (edit).
- test/intake.test.ts, test/audit.test.ts, test/signing.ts (test helper that signs platform events and player tokens; written independently of src/integrations so a bug in the adapter is not mirrored in the test).
- docs/ai-log.md: append ONE row at the end (see Rules).
Do not edit docs/contracts.md, src/schema.sql, src/domain/**, src/app.module.ts, src/main.ts, test/app.ts, src/ledger/**, src/outbox/**, src/wheel/**, src/store/**, package.json or anything else. No new npm dependencies (JWT and HMAC are done with node:crypto). If the contract is wrong or incomplete, do not edit it: take the smallest sensible reading and list it under DEVIATIONS in your report.

## Details beyond the contract
Audit (`src/audit/audited.ts`):
- Allowed tables: players, inbound_events, spins, redemptions, store_items, wheel_configs, tenants. Any other table name throws (the name is interpolated into SQL, so the allowlist is also the injection guard). Column names come from the row object keys; validate them against `^[a-z_][a-z0-9_]*$`.
- Rows are passed and returned in snake_case exactly as in the schema (no mapping layer here).
- `create(tx, ctx, table, row, options?: { onConflict?: "nothing" })`: INSERT ... RETURNING *. With `onConflict: "nothing"` it uses `ON CONFLICT DO NOTHING` and returns null (and writes no audit row) when the row already existed; this is how event dedup works. Audit `changes` for a create: one entry per column of the returned row, `{ field, from: null, to: value }`.
- `update`: `SELECT * ... WHERE id = $1 FOR UPDATE`, call `change(current)`, if it returns null or an empty object or values equal to the current ones: write nothing, return null. Otherwise UPDATE only those columns, RETURNING *, and write one audit row with only the fields that differ. Compare values by their JSON form so jsonb, bigint-as-string and Date compare sanely.
- `remove`: SELECT FOR UPDATE, DELETE, audit `changes` = one entry per column `{ field, from: value, to: null }`. Nothing to delete: no audit row.
- `record`: writes an audit row for a fact that is not a row change.
- Secrets must not land in the audit trail: for table `tenants` the fields webhook_secret, token_secret, wheel_secret, admin_key, platform_key are written as "***" in `changes`.
- `at` comes from a `now: Date` in the context: extend `AuditContext` with `now: Date` (the caller passes `clock.now()`); note this under DEVIATIONS as an addition.
- `entity_id` is the row's `id` as text.

Player token (`player-token.ts`): split on ".", require header alg HS256, read `iss` WITHOUT trusting it, load that tenant, recompute HMAC-SHA256 over `header.payload` with the tenant's `token_secret`, compare with `timingSafeEqual` (guard against different lengths), then check `exp` (seconds) against the clock and reject `exp` more than 15 minutes ahead, and require a non-empty `sub`. Any failure is 401 with a body that does not say which check failed. The guard puts `{ tenant, player }` on the request; the player row is found or created (actor `player/<external id>` for that create). Nothing in a controller may take a tenant id or player id from the body or query.

`GET /me`: `{ playerId, tenantId, spins: [{ id, status, coins }] }` for this player only, newest first. (`balance` is added by a later agent; leave it out.)

Platform A `parseEvents`: headers arrive lower-cased (`x-alpha-timestamp`, `x-alpha-signature`). Missing header, non-numeric timestamp, timestamp more than 300 s from `now`, or a signature that does not match `hex(HMAC-SHA256(webhookSecret, timestamp + "." + rawBody))` (timing-safe) -> `InvalidSignature`. Then JSON.parse; not an object, or missing/ill-typed fields (`event_id` non-empty string, `type` string, and for `deposit.succeeded`: `player_id` non-empty string, `amount_minor` positive integer, `currency` 3 letters, `occurred_at` parseable) -> `InvalidPayload`. `deposit.succeeded` -> DepositSucceeded; any other type -> IgnoredEvent with `why`. Returns an array of one. `parseRewardNotice` throws NotSupported.
Platform B `parseEvents`: `x-beta-auth` must equal `base64(HMAC-SHA256(webhookSecret, rawBody))`, else InvalidSignature. Body: `transactions` must be a non-empty array, each with a non-empty `txnId`; an entry with kind DEPOSIT and state COMPLETED must have `customer.id` (non-empty string), `amount` matching `^\d+(\.\d{1,2})?$` and > 0 (convert to minor units WITHOUT floating point: split on the dot), `currencyCode` 3 letters, `completedAt` a number of unix seconds; one bad entry makes the whole batch InvalidPayload (nothing is processed). Other kinds/states -> IgnoredEvent. `parseRewardNotice`: same signature rule; body `{ requestId, externalRef, state, reason? }`; GRANTED -> issued (platformRef = requestId), DECLINED -> refused (reason or "declined"); anything else InvalidPayload.

`POST /webhooks/:tenantId/events` (events.controller.ts): unknown tenant -> 404. Use `req.rawBody` (a Buffer; the app is created with rawBody: true). If it is missing, answer 400. Call the tenant's adapter. InvalidSignature -> 401 and one audit `record` (tenant id from the path, actor "unknown", action "webhook_rejected", entityType "webhook", entityId = a fresh uuid, changes `{ reason: "bad signature", bytes: <length> }`; do not store the body). InvalidPayload -> 400 and a `record` with action "webhook_invalid" and actor `platform/<tenantId>`. Then for each event, each in ITS OWN transaction: `findOrCreatePlayer` (deposits only), `create` the inbound_events row with `onConflict: "nothing"`; null means duplicate -> count it and do nothing else. For an accepted deposit, in the same transaction, `create` one spin with the tenant's newest wheel config (highest version). Ignored events are stored with kind "ignored" and no player. Answer 200 `{ accepted, duplicates, ignored }`. Actor for these writes: `platform/<tenantId>`. Take a request id from the header `x-request-id` or make a uuid, and pass it into the audit context.
Player creation under concurrency: two first deposits of the same new player at once must both succeed with one player row (INSERT ... ON CONFLICT DO NOTHING then SELECT, in `findOrCreatePlayer`).

## Tests - real HTTP against the whole app (`startApp()` from test/app.ts), real PostgreSQL, no mocks
`startApp()` returns undefined when no TigerBeetle is available; skip then, like test/health.test.ts. Call `seedDemo(running.db, running.clock, "http://127.0.0.1:1")` in beforeAll. Sign events and tokens with test/signing.ts using the secrets from demo-tenants.ts and the app's clock (`running.clock.now()`), not the real time.
test/intake.test.ts, at least:
1. Platform A happy path: 200 `{accepted:1,...}`, one player, one inbound event, one spin `available`, visible in `GET /me` with a valid token.
2. Duplicate deposit, sequential: second call 200 with `duplicates: 1`, still one spin.
3. Duplicate deposit, 10 identical requests at once (Promise.all): exactly one spin, the sum of `accepted` over the answers is 1.
4. Platform B batch of three (one completed deposit, one failed deposit, one withdrawal): accepted 1, ignored 2; "20.00" becomes 2000 minor units in `normalized`; sending the batch again: duplicates 3.
5. Bad signature (A and B): 401, no rows in players/inbound_events/spins, one audit row `webhook_rejected`.
6. A: stale timestamp -> 401. A body altered after signing -> 401.
7. Signed but invalid payload (A missing player_id; B amount "20.001"; B batch with one bad entry processes nothing): 400.
8. Unknown tenant -> 404.
9. Tenant isolation: an event signed with alpha's secret posted to /webhooks/beta-casino/events -> 401. The same external player id "p-1" in both tenants gives two player rows; alpha's token sees only alpha's spin in /me; a token whose `iss` is alpha but signed with beta's token secret -> 401.
10. Token: missing, garbage, expired, exp 2 hours ahead, alg "none", empty sub -> 401 each. After `running.clock.advance(11 * 60_000)` a 10-minute token stops working.
11. Two tenants' first deposits for a new player at once: no error, one player row each.
test/audit.test.ts (freshDb from test/harness.ts and the functions directly), at least: create writes one audit row with every column; update writes only changed fields and returns before/after; update with a `change` that returns null writes nothing; two concurrent `update` calls that both try `available -> used` on one spin: exactly one returns a result (this is the guard later code relies on); remove writes the old values; `UPDATE audit_log ...` and `DELETE FROM audit_log` both raise; `UPDATE wheel_configs` raises; a table outside the allowlist throws; tenant secrets appear as "***"; a failed transaction leaves neither the row nor the audit row; seedDemo twice gives two tenants and no extra audit rows.

## Rules
- `npm run verify` (typecheck, biome, all tests) must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation check before you finish: (a) remove `onConflict: "nothing"` handling so duplicates insert or throw: a test must fail; (b) skip the signature comparison in platform A: a test must fail; (c) remove `FOR UPDATE` from `update`: the concurrent-update test must fail (if it does not fail reliably, make the test deterministic, e.g. hold the first transaction open while the second starts). Restore each. Report which test caught each.
- Domain rules stay in plain files without Nest decorators; controllers, guards and modules are thin. Imports use `.ts` extensions. Injected classes are plain imports, never `import type` (biome's useImportType is off for that reason). No `new Date()` / `Date.now()` in src: inject `CLOCK`. Plain English comments, short sentences.
- Commit on your branch when green (one to three commits). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md row appended at the end, same commit: `| HH:MM | what | Agent | how it was checked |`, time from `date +%H:%M`.

## Report back (read by a person who does not read the code; under 45 lines)
Branch and commit hashes; for audit, identity and intake three lines each: what it does, what can break, which test catches it; results of the three mutation checks; DEVIATIONS from or additions to the contract; what the next agent must know to (1) add a player endpoint behind the guard, (2) change a row with audit inside a transaction, (3) add the outbound half of an adapter; what is not tested.
````

## The agent's report

````text
Branch `worktree-agent-a92843bcad2800c2d`, commit `b69bbef`. `npm run verify` is green (25 tests, 22 of them new). Nothing was pushed or merged.

**Audit** (`src/audit/audited.ts`)
- **What it does:** `create`, `update`, `remove` and `record` write the change and its audit row in the caller's transaction. Only the 7 allowed tables are accepted, column names are validated, tenant secrets are written as `***`, and `update` locks the row with `FOR UPDATE`.
- **What can break:** two callers racing on one row, a secret leaking into the trail, or a table name being used for SQL injection.
- **Tests:** `test/audit.test.ts` (11 tests), including a deterministic concurrent-update test, the append-only triggers, the allowlist, secret masking and rollback.

**Identity** (`src/tenants/**`)
- **What it does:** `seedDemo` is idempotent and writes no second audit rows. HS256 tokens are checked with the tenant's `token_secret`. The guard puts `{tenant, player}` on the request, and `GET /me` returns only that player's spins.
- **What can break:** a forged `iss`, an `alg: none` token, a wrong expiry, or two first deposits of one new player at once.
- **Tests:** `test/intake.test.ts` tests 9, 10 and 11, plus the seed test in `audit.test.ts`.

**Intake** (`src/events/**`, `src/integrations/**`)
- **What it does:** adapters A and B parse and verify events. `POST /webhooks/:tenantId/events` runs each event in its own transaction, and a unique key deduplicates repeats, so a repeat creates no spin. Rejected webhooks are audited without storing the body.
- **What can break:** the same deposit arriving at once, a bad or stale signature, a half-valid batch, or a cross-tenant event.
- **Tests:** `test/intake.test.ts` tests 1 to 9 and 11.

**Mutation checks**
- **(a) Removed `ON CONFLICT DO NOTHING`:** 5 tests failed. They were intake tests 2, 3, 4 and 11 and the seed-twice test.
- **(b) Skipped the platform A signature compare:** intake tests 5 and 6 failed.
- **(c) Removed `FOR UPDATE` from `update`:** the concurrent-update test failed. The first version of that test hung under this mutation, so I made it wait for any lock wait on `spins`. It now fails cleanly.
- All three mutations are restored.

**Deviations and additions**
- `AuditContext` has an extra `now: Date`. It is defined in `audited.ts`.
- `create` returns `Row | null`, and `Row` is exported.
- `src/integrations/hmac.ts` is a new shared helper for HMAC comparison and JSON checks.
- The `raw` column of `inbound_events` holds the whole request body. For a platform B batch, each event row stores the entire batch.
- A non-JSON body after a valid signature gives 400 and a `webhook_invalid` audit row.
- A missing `x-alpha-*` header counts as an invalid signature.
- The guard writes an audit row (`player/<id>`) only when it creates the player.
- `GET /me` shows `coins` as `null` for an unused spin.

**For the next agent**
1. **A player endpoint:** add `@UseGuards(PlayerAuthGuard)` and `@CurrentPlayer() auth: PlayerAuth`. `auth.tenant.id` and `auth.player.id` come from the token. `TenantsModule` exports the guard, and the controller's module needs to import `TenantsModule`.
2. **A row change with audit:** inside `transaction(db, tx => ...)`, call `update(tx, {tenantId, actor, requestId, now: clock.now()}, "spins", id, cur => cur.status === "available" ? {...} : null)`. A null result means someone else got there first. Pass snake_case columns, and bigint columns come back as strings.
3. **The outbound half of an adapter:** fill in `issueReward` and `findReward` in `platform-a.ts` and `platform-b.ts`. They currently throw "not implemented yet". The registry is injected with `@Inject(PLATFORMS)`.

**Not tested**
- `x-request-id` propagation into the audit row.
- `parseRewardNotice` for platform B and `NotSupported` for platform A. The `/webhooks/:tenantId/rewards` route is not built.
- Platform A events of another `type` (the ignored path on A).
- Seeding at boot through `config.seedDemo`.
- A missing `rawBody` returning 400.
````
