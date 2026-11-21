# Brief 19: tenant keys

Wave 8. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: NestJS backend (`src/`, ESM, `.ts` import extensions), PostgreSQL schema in `src/schema.sql`, TigerBeetle ledger, a fake casino process (`src/fake-casino/`), React app in `web/` (player page and back office). Read `CLAUDE.md`, `docs/verification.md` and in `docs/contracts.md` the sections "Actors and audit", "Our HTTP API", "Platform A", "Platform B", "Back office API", "Admin sign-in and roles" first, and follow them. Do NOT read `CLAUDE.local.md` or `.private/`.

Other people are changing these right now — do not touch them: `src/outbox/`, `src/store/`, `src/ledger/`, `src/config.ts`, `docker-compose.yml`, `src/fake-casino/public/`, all `web/src/*.css` (use existing CSS classes; if you truly need a rule, add at most a few lines at the END of `web/src/admin.css`). In `src/fake-casino/server.ts` and `state.ts` keep your edits to a minimum (put new logic in a NEW file and add only the route lines), because another change is in progress there.

## Problem
Each tenant (casino) has secrets that we use to check what comes in: the **event signing secret** (`webhook_secret`: the casino signs deposit events with it, and platform B signs its reward result notices with it) and the **player token secret** (`player_token_secret`: the casino signs the short-lived player JWT with it). Today they are seeded and can be neither seen nor replaced from the back office. The author's decision: the back office must be able to invalidate a key; the casino's manager does it himself for his own casino. Mechanism (decided): replacing a key is one operation; the new secret is shown once; the old one stays valid until a time the admin chooses — "now" is the invalidation after a leak, up to 24 hours is a planned change without downtime; the old one can also be dropped early; lists show keys masked; everything is audited.

## Build

### Schema (`src/schema.sql`)
On `tenants`, for each of the two secrets add: previous value (nullable), previous-valid-until timestamp (nullable), and rotated-at timestamp (nullable). Name them consistently, e.g. `webhook_secret_prev`, `webhook_secret_prev_until`, `webhook_secret_rotated_at`, `player_token_secret_prev`, `player_token_secret_prev_until`, `player_token_secret_rotated_at`. Check how the schema is applied to an existing database (`migrate` in `src/`): if it is `CREATE TABLE IF NOT EXISTS` only, also add `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ...` lines so an existing database gets the columns.

### Verification accepts the current secret, and the previous one until it expires
Find every place that verifies with these two secrets (`src/events/events.controller.ts`, `src/events/rewards.controller.ts`, `src/integrations/platform-a.ts`, `platform-b.ts`, the player token guard in `src/tenants/`, `src/tenants/tenants.ts` where a tenant row is loaded). Make one small pure function, e.g. `activeSecrets(current, prev, prevUntil, now): string[]` in `src/tenants/`, and make each verification pass if ANY active secret verifies (constant-time compare stays as it is). Use the injected clock (`CLOCK`), not `Date.now()`. If tenants are cached in memory anywhere, a rotation must take effect at once (find out and say what you did).

### Back office API (follow the existing admin controllers, guard, `can()` in `src/admin/permissions.ts`, error shapes and tenant-mismatch → 404 rule exactly)
- `GET  /admin/tenants/:tenantId/keys` → `[{ kind: "event_signing" | "player_token", hint, rotatedAt, previous: { hint, validUntil } | null }]`. `hint` = first 4 chars + "…" + last 4 chars of the secret; never the secret. A previous key whose time has passed is reported as `null`. Allowed: platform_admin, tenant_admin and tenant_viewer of that tenant.
- `POST /admin/tenants/:tenantId/keys/:kind/rotate` body `{ previousValidForSec: number }` (integer 0..86400; anything else → 400) → `201 { kind, secret, hint, previous: { hint, validUntil } | null }`. Generates a new random secret (32 random bytes, base64url, with a readable prefix such as `evs_` / `pts_`), moves the current one to previous with `validUntil = now + previousValidForSec` (with 0 the previous is cleared at once: old key dead immediately). The full secret appears ONLY in this answer. Allowed: platform_admin and tenant_admin of that tenant; tenant_viewer → 403.
- `POST /admin/tenants/:tenantId/keys/:kind/revoke-previous` → `200` with the same shape as one list item; clears the previous secret now. Idempotent. Same permissions as rotate.
Add the permissions to `can()` with its tests. Write through `src/audit/audited.ts` (`update`) in one transaction so the audit row is in the same transaction, with actor `admin/<id>` and the request id; the audit row must NOT contain any secret value (check how masking works in `audited.ts`; extend the masked field list for the new columns; record hints or just "changed"). Emit one structured log line per rotation/revocation in the style of `src/logging/` (event names like `tenant.key_rotated`, `tenant.key_previous_revoked`), no secret in it.

### Fake casino must be able to receive the new key (demo only)
The fake casino signs events and player tokens with the secrets it has in its own state (`src/fake-casino/state.ts`, `deposit.ts`, `platform-b.ts`, `server.ts` line ~351). Add a control endpoint in the existing control API style (read `server.ts` for the path convention and CORS): set a tenant's `webhookSecret` and/or `tokenSecret` — e.g. `PUT <control prefix>/tenants/:tenantId/secrets` body `{ webhookSecret?, tokenSecret? }` → 204. This stands for "the casino's engineer pastes the new key into the casino's configuration". Test it in `test/fake-casino.test.ts`.

### Back office screen (`web/`)
In the Settings area of the back office (see `web/src/sections/`, `web/src/admin/`), add a "Keys" block for the tenant: a table (Key, Hint, Replaced at, Previous key: hint and valid until, or "none"), per key a "Replace" control with a choice for the old key: "Stops working now (use after a leak)", "Keeps working 1 hour", "Keeps working 24 hours", and a confirm step that states the consequence in one sentence ("Events signed with the old key will be rejected from now on."). After success show the new secret once in a panel with a Copy button and the sentence "This is the only time the key is shown. Put it into the casino's configuration now." When a previous key exists show "Stop the old key now" (revoke-previous). In demo mode only (when `/app-config.json` gives `fakeCasinoUrl`, see how `web/` reads it) the panel also has a button "Give this key to the demo casino", which calls the fake casino endpoint above, so the demo keeps working after a rotation; say next to it that in real life the casino's engineer does this by hand. tenant_viewer sees the table without controls (see `web/src/admin/roles.ts`). Update `web/dev/mock-server.mjs` and add a fixture/type test in the style of `web/src/fixtures/shapes.test.ts`.

### Docs
`docs/contracts.md`: a short section "Tenant keys" (the three endpoints, the rule "current, plus previous until its time", who may do it, what is audited). `docs/failure-table.md`: rows "A casino's event signing key leaked" and "A planned key change" with the test names. Add to the contract an honest note: the secrets are stored in the database as plain text because HMAC needs the raw value; in production they belong in a secrets store or encrypted at rest. Not built: replacing the wheel secret and the platform API key — say so in one line.

## Tests (write the failing test first; use the existing helpers `test/app.ts` `startApp` with the FakeClock, `test/signing.ts`, the fake casino `test/fake.ts`)
New file `test/tenant-keys.test.ts`, flow tests through HTTP:
1. Rotate event signing with 0: a deposit signed with the old secret → rejected exactly as a bad signature is today; signed with the new one → accepted. Same for a platform B tenant (both deposit event and reward result notice).
2. Rotate with 3600: both old and new accepted; advance the fake clock past one hour: old rejected, new accepted.
3. Rotate with 3600 then revoke-previous: old rejected at once; revoke again → 200.
4. Player token: same three cases against `GET /me` (or the endpoint the guard protects).
5. Rotating one tenant's key does not change the other tenant; rotating one kind does not change the other kind.
6. Permissions: tenant_viewer → 403 on rotate/revoke, can list; tenant_admin of the other tenant → 404; no token → 401; platform_admin can.
7. Validation: `previousValidForSec` of -1, 86401, 1.5, a string → 400; unknown kind → 404 or 400 (match the existing style).
8. No secret anywhere: after a rotation, scan every `audit_log` row and every captured log line for the old secret, the new secret (taken from the 201 answer) — none found; `GET keys` never contains them.
9. Two rotations at the same time (Promise.all) → both succeed one after another or one gets a clean conflict; afterwards exactly one current secret, and the answer that returned a secret which is NOT current must not have been a 201 with a working key unless that key is the previous one and still valid — state precisely what you chose and test it.
10. Unit tests for `activeSecrets`.
Mutation checks (required): (a) make verification ignore the expiry of the previous secret — test 2 must fail; (b) make rotate keep the old secret when 0 is given — test 1 must fail; (c) remove masking — test 8 must fail. Restore each. Report what you saw.

Tests need TigerBeetle on this CPU: after `npm install` in your worktree run `./scripts/tb-old-cpu.sh` and `export TB_BIN=<local-tigerbeetle-build>/tigerbeetle`. `npm run verify` must be green with NO skipped files, and `npm run verify:web` green. Do not start docker compose on the default ports (the author's demo stack runs there); a compose run is not required.

## Commits
Commit at green points on your worktree branch: (1) schema + verification with previous secret + tests, (2) back office API + fake casino endpoint + tests + docs, (3) screen. Messages describe the change and how it was checked; no tool names, no attribution or co-author lines. Each commit that changes `src/` or `test/` adds a row at the END of the table in `docs/ai-log.md`: `| HH:MM | what | Author (the back office can invalidate a key; the casino's manager does it for his own casino; old key valid until a chosen time); agent (details) | how checked, test names |`, time from `date +%H:%M`. Do not push.

## Report (short, plain)
What was built; what can break and which test catches it; mutation check results; what you chose in test 9; whether tenants are cached; what was not tested (e.g. the screen in a real browser).
````

## The agent's report

````text
Key replacement is built and committed in three commits on the worktree branch, none pushed. `npm run verify` is green with 21 test files and 303 tests, none skipped. `npm run verify:web` is green. The screen was never opened in a browser.

**What was built**
- **Verification** accepts the current secret, plus the previous one until its time. This is one pure function, `activeSecrets`, in `src/tenants/active-secrets.ts`, using the injected clock. Platform A, platform B (events and reward result notices) and the player token check all use it. A bad signature gets the same 401 as before.
- **Schema:** the `tenants` columns are `webhook_secret_prev`, `webhook_secret_prev_until`, `webhook_secret_rotated_at`, and the same three for `token_secret`. The real column is `token_secret`, not `player_token_secret`. Plain `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` lines give an existing database the columns.
- **Back office API:** the list shows hints only. Rotate takes `previousValidForSec` (0 to 86400, anything else is a 400) and returns the new secret once. Revoke-previous is idempotent. There is a new `manage_keys` permission (tenant_admin and platform_admin) in `can()`, with its test. Writes go through audited `update` in one transaction. The `*_prev` columns are masked in the audit trail, and there is one log line per change (`tenant.key_rotated`, `tenant.key_previous_revoked`) with no secret.
- **Route path:** I used `/admin/:tenantId/keys...`, not `/admin/tenants/:tenantId/keys`, to match every other admin call. This is written in `docs/contracts.md` and the ai-log.
- **Fake casino:** `PUT /control/tenants/:tenantId/secrets` returns 204 and is tested in `test/fake-casino.test.ts`. The new logic is in `src/fake-casino/secrets.ts`. In the old files I added two route lines in `server.ts`, one optional argument in `platform-b.ts`, and `PUT` in the CORS methods.
- **Screen:** the Keys block is in Settings (`web/src/sections/Keys.tsx`), with the table, the Replace choice, the confirm sentence, the one-time panel with Copy, "Stop the old key now", and the demo-casino button. The demo button shows when `/app-config.json` gives `fakeCasinoUrl`. Viewers see the table without controls. `web/dev/mock-server.mjs` serves the same shapes, and fixtures were captured from the real server. The placeholder secret in the rotate fixture is not real.
- **Docs:** a "Tenant keys" section in `docs/contracts.md`, including the plain-text storage note and "not built: wheel secret and platform API key". Four rows in `docs/failure-table.md`. Rows in `docs/ai-log.md`.

**Mutation checks** (all restored):
- **Expiry of the previous secret ignored:** tests 2a, 2b and 4b fail, plus 3 `activeSecrets` unit tests.
- **Old secret kept when 0 is given:** my first version kept the value but left the end time at "now", and no test failed. The expiry rule already kills it, so that mutation changes nothing. With the end time set to now plus one hour, 1a, 1b, 4a, 5 and 9 fail.
- **Masking removed:** test 8 fails.

**Test 9, concurrent rotations:** the tenant row is locked by `update`, so the two requests run one after the other and both answer 201. The one that ran last is current. The one that ran first is its previous key, valid for the time the second call asked for. If the second call asked for 0, the first caller's key is dead at once. The secret from before both is gone. The test checks this with real signed requests, for both `3600/3600` and `0/0`.

**Tenant caching:** none. `findTenant` reads the database on every request, so a rotation takes effect immediately.

**What can break, and the test that catches it**
- Expiry ignored: 2a, 2b, 4b.
- 0 not killing the old key: 1a, 1b, 4a.
- Secret leaking into the audit trail or a log: 8.
- A role gap: 6 and the role table in `test/admin-auth.test.ts`.

**Not tested**
- The screen in a real browser: the Keys component has no render test, and only its pure helpers and the fixture shapes are tested.
- The Copy button and the demo-casino button against the real fake casino from the page.
- The `/app-config.json` path in the screen. The mock server returns a `fakeCasinoUrl` that points at the mock itself.
- Running it under docker compose.

**Commits**
- `d928a43`: verification with the previous secret.
- `d26392e`: API, fake casino endpoint, docs.
- `f6cacc8`: screen.
````
