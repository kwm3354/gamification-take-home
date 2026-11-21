# Brief 21: tenant isolation test

Wave 8. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: NestJS backend (`src/`), PostgreSQL + TigerBeetle, tests in `test/` (vitest). Read `CLAUDE.md` and `docs/verification.md` first. Do NOT read `CLAUDE.local.md` or `.private/`. You own ONE new file `test/tenant-isolation.test.ts` (plus, if needed, a tiny helper added to `test/app.ts`), one row in `docs/failure-table.md`, a short paragraph in `docs/contracts.md` (section on tenants or a new short section "Tenant isolation is checked per route"), and one row in `docs/ai-log.md`. Do NOT change `src/` unless the test finds a real leak; then: keep the failing test, smallest fix, its OWN commit describing the finding. Another person is adding `test/properties.test.ts` and `test/processes.test.ts` right now; do not touch those.

## The design (decided by the author; implement exactly this)
Tenant isolation is enforced in code: every query filters by tenant. The weak point is a NEW route whose query forgets the filter. The test closes that by forcing a decision for every route:

1. The test reads ALL HTTP routes of the running app (method + path pattern) from the framework itself, not from a hand-written list. Find the reliable way for this NestJS version with the adapter in use (see `test/app.ts` `startApp` and `src/main.ts`; e.g. the HTTP adapter's router stack, or Nest's `DiscoveryService`/`RoutesResolver` data). Static file serving (`/app/...`) counts as whatever the framework reports; handle it explicitly.
2. Two lists live in the test file:
   - `CHECKED`: route → how it is checked (a function).
   - `SKIPPED`: route → a one-sentence reason why tenant isolation does not apply (e.g. `GET /health`: no tenant data; `POST /admin/login`: no tenant data before sign-in; static files).
3. A route that is in NEITHER list fails the test with a message that says: "New route <METHOD> <path>: decide — add it to CHECKED with a check, or to SKIPPED with a reason." This is the decision point.
4. A list entry that matches NO live route also fails ("stale entry"), so the lists cannot rot. A route in BOTH lists fails.

## How a CHECKED route is checked
Set up once: both demo tenants (`alpha-casino`, `beta-casino`, see `src/tenants/demo-tenants.ts`) each with real data made through the public flow: players, deposits/events, spins (some used), redemptions (issued, and one stuck if cheap), audit rows, outbox rows, a settings change, a wheel version, keys. Reuse helpers from existing tests (`test/store.test.ts`, `test/backoffice.test.ts`, `test/admin.test.ts`, `test/signing.ts`, `test/admin-login.ts`, `test/fake.ts`); look at the existing isolation tests there (store test 18, backoffice "tenant isolation", admin tests) and reuse their ideas — but this test is the systematic one.
Collect ALPHA's identifiers: every uuid/id of alpha's rows (player ids, external player ids, event ids, spin ids, redemption ids, audit ids if distinguishable, settings-change ids, item ids, tenant id where it must not appear) — gather them from the database by `tenant_id`, so new tables with a `tenant_id` column are picked up automatically where possible (query `information_schema.columns` for tables having `tenant_id` and collect their primary keys; say which tables were found).
Kinds of check (write small reusable check builders):
- **list route** (returns a collection for the caller's tenant): call it as BETA's actor (beta's tenant admin for back office routes; a beta player's token for player routes), follow pagination to the end if the route pages, and assert the whole response text contains NONE of alpha's identifiers; and assert it is not empty for beta where beta has data (otherwise the check proves nothing).
- **item route** (takes an id in the path): call it as BETA's actor with ALPHA's id → 404 (or the documented refusal; match what the contract says), and with beta's own id → 200.
- **tenant-in-path route** (`/admin/:tenantId/...`): beta's tenant admin calling alpha's tenant path → 404 per the contract; also run the list/item check inside beta's own path with alpha's ids.
- **write route** (POST/PUT that changes something): as BETA's actor against ALPHA's object or path → refused, and afterwards alpha's row is unchanged (compare the row before/after) and no audit row was written for alpha by that call.
- **inbound casino routes** (events, reward result notices): a request signed with BETA's secret but addressed to ALPHA's tenant path (and the reverse) is refused and creates no row; a correctly signed beta event naming a player external id that exists in alpha does not touch alpha's player (same external id in two tenants are two players).
- **platform-admin-only routes** (cross-tenant by design, e.g. `/platform/...`): tenant admins get 403/404; mark in CHECKED with that check, not in SKIPPED.
Every route must end up in exactly one list. If a route cannot be checked cheaply, it does NOT go to SKIPPED silently: put it in CHECKED with the best check you can, or in SKIPPED with the honest reason "not checked: <why>" and list it in your report.

## Prove the test works (required, restore after each; report what the test printed)
(a) Remove the tenant filter from one list query in `src/admin/` (e.g. the redemptions list) → the test must fail naming that route. (b) Remove the tenant check from one item lookup on the player API in `src/store/` or `src/wheel/` → fail. (c) Add a dummy route to any controller → fails with the "decide" message. (d) Rename a CHECKED entry's path → fails as stale.

## Running
This machine's CPU has no AVX2: after `npm install` in your worktree run `./scripts/tb-old-cpu.sh` and `export TB_BIN=<local-tigerbeetle-build>/tigerbeetle`. `npm run verify` must be green with no skipped files. Keep the new file under ~20 s. Disk is tight; do not start extra servers beyond the test setup. Do not start docker compose.

## Commit
One commit for the test (plus one per leak found). Message describes the change and how it was checked; no tool names, no attribution or co-author lines. Row at the END of the table in `docs/ai-log.md`: `| HH:MM | what | Author (the design: the test reads the routes; two lists, checked and skipped; a route in neither fails the test and forces a decision; he prefers this to database row rules); agent (kinds of check, stale-entry rule) | how checked, mutation results |`, time from `date +%H:%M`. Do not push.

## Report (short, findings first)
Leaks found or "none"; number of routes: checked / skipped (list the skipped with reasons, and any "not checked"); mutation results; tables with `tenant_id` found; run time.
````

## The agent's report

````text
**Leaks found:** none. The test passed on the first full run against unmodified `src/`, and I changed nothing in `src/`.

**Commit:** `ff07458`, not pushed. `npm run verify` is green: 23 files, 355 tests, none skipped. It also contains the `docs/contracts.md` section, the `docs/failure-table.md` row and the `docs/ai-log.md` row (15:36).

**How the test works:** it reads the routes from the Express 5 router stack (`app.getHttpAdapter().getInstance().router.stack`). The test file is `test/tenant-isolation.test.ts` and I did not touch `test/app.ts`.

**Routes:** 30 checked, 4 skipped, 0 "not checked". Every checked route runs the beta-actor check. For routes with `:tenantId` in the path, it also calls alpha's path as beta's manager and expects a 404.

Skipped:
- `GET /health`: no tenant data.
- `POST /admin/auth/login`: no tenant data before sign-in.
- `MIDDLEWARE web`: static files under `/app/` and `/app-config.json`. The static handler is not a route in the stack, so the test reports it as a named middleware layer. Any other new named middleware also fails with the "decide" message.
- `ALL /{*path}`: Nest middleware for every path (request id, tracing).

**Tables with `tenant_id`:** 12 found by `information_schema`: `admin_users`, `audit_log`, `grant_policies`, `inbound_events`, `ops_policies`, `outbox`, `players`, `redemptions`, `settings_changes`, `spins`, `store_items`, `wheel_configs`. This yielded 34 alpha identifiers: primary keys, plus external player ids, external event ids, platform refs, admin emails and alpha's secrets.

**Mutation results (each restored):**
- **(a)** Tenant filter removed from the redemptions list query. `GET /admin/:tenantId/redemptions` failed with "shows alpha's players.id (…)".
- **(b)** Two variants:
  - Tenant check removed from `findRedemption` in `src/store`. The resolve route and the rewards webhook failed ("expected 200 to be 404").
  - First try on the spin lookup in `src/wheel`: removing only the SQL check changed nothing, because the later update re-checks tenant and player. I removed both checks. `POST /wheel/spins/:spinId/spin` then failed ("alpha's spin used by a beta player: expected 200 to be 404").
- **(c)** Dummy `GET dummy` route added to a controller. The test failed with "New route GET /admin/:tenantId/dummy: decide — add it to CHECKED with a check, or to SKIPPED with a reason."
- **(d)** A CHECKED entry renamed to `spinz`. The test failed with "Stale entry GET /admin/:tenantId/spinz: no live route matches it" plus the "decide" message for `spins`.

**Allowed change on alpha's side:** a request signed with the wrong secret and addressed to alpha's path is audited under alpha as `webhook_rejected`. That is existing contract behaviour. The test allows only that audit row and no other change, and the new `docs/contracts.md` section says so.

**Run time:** the file alone takes about 14 s (a cold first run took about 30 s). The full verify run takes 32 s.

**Environment:** `./scripts/tb-old-cpu.sh` needs `TB_OLDCPU_DIR=<local-tigerbeetle-build>` in a worktree, because its default path points to the wrong place there.
````
