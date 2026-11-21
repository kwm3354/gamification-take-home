# Brief 14: back office against real server

Wave 6. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Two agents built the two halves of a back office from one written specification, without seeing each other's work: the server side (NestJS, src/admin/**) with tests, and the screen (React, web/**) checked only against a mock server. Both are merged on main. Your job: run them together for the first time, find every mismatch, fix it, and prove the whole thing works in a real browser against the real server. You work in your own git worktree on your own branch.

Context: a gamification backend for casino operators (deposit event -> wheel spin -> coins in a TigerBeetle ledger -> redemption -> the casino platform issues the reward), with a fake casino process, a player page (our widget inside a mock casino site) and a back office with sign-in and roles. Other agents are working in parallel: one adds OpenTelemetry tracing (src/tracing/**, src/db.ts, src/main.ts, src/integrations/http.ts, src/outbox/outbox.ts, compose, package.json), one measures performance against the owner's running stack on the default ports. Do not touch src/tracing, src/db.ts, src/outbox, src/integrations, package.json dependencies; keep edits to src/main.ts and docker-compose.yml out of your work unless a mismatch forces one line.

## Read first
CLAUDE.md; docs/contracts.md sections "Our HTTP API", "Admin and operations", "Back office API", "Changing the wheel", "Admin sign-in and roles" (the specification both halves were built from; where the two halves disagree, the specification decides; where the specification is silent, the SERVER's tested behaviour decides and the screen adapts); src/admin/** (controllers and the query files: the real response shapes); web/src (api client, admin pages, router, types); web/dev/mock-server.mjs (what the screen assumed); src/web.ts (`/app-config.json`, `demoAdmins`); test/backoffice.test.ts, test/admin-auth.test.ts, test/settings-change.test.ts (the server's behaviour as tested); docs/samples.md; README.md "Run it".

The screen's author listed where he guessed (these are the likely mismatches; check each against the real server): the item shape of `changes[]` in `GET /admin/{t}/settings` and of `GET /platform/settings-changes` (camelCase of the columns? bare array or `{ items }`? numbers or strings?); the shape of audit `changes` (`[{field, from, to}]` or an object?); `lastPlatformCall` in the stuck list; audit with `recent=1` (`{ items, nextCursor }` with `cursor` per row?) versus with `entityId` (bare array?); `reward` in the redemption detail; whether `playerId` filters take our uuid; the values of the events `kind` filter; outbox row state; whether the server's `expectedPrizeCoins` agrees with the page's own computation; `/platform/tenants` for non-platform roles; `demoAdmins` in `/app-config.json`.

## Machine setup (first, exactly)
```
npm ci && npm run web:install
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle
npm run verify && npm run verify:web     # both green before you change anything (270 backend tests, 99 web tests)
```
The CPU has no AVX2 (the script swaps in a local TigerBeetle client build; run it again after any npm install). The disk is nearly full and the machine is busy: do not install a browser or new dependencies; clean up after yourself. Create a gitignored `docker-compose.override.yml` in your worktree root:
```
services:
  tigerbeetle:
    image: tigerbeetle-oldcpu:0.17.9
  app:
    volumes:
      - <local-tigerbeetle-build>/node-client/x86_64-linux-gnu/client.node:/app/node_modules/tigerbeetle-node/dist/bin/x86_64-linux-gnu/client.node:ro
```
The owner's stack runs on the default ports and a measurement is running against it: do NOT stop, rebuild or use it. Use your own project and ports: `APP_PORT=33080 FAKE_PORT=33081 PG_PORT=57329 TB_PORT=33009 docker compose -p integ up -d --build --wait`, and `docker compose -p integ down -v` at the very end. Rebuild that project after each round of fixes. Chrome is installed (`which google-chrome chromium chromium-browser`); drive it headless over the DevTools protocol with a small script in the scratch area (not committed), as earlier agents did; the Playwright browser is not installed.

## What to do
1. Bring up your stack. Create data the real way: through the fake casino's control API (deposits, tokens) and the player API (spins, redemptions) on BOTH tenants, including: a redemption that is issued, one refused (fault `refuse`), one "insufficient", and one stuck in `submitting` on platform B (grant accepted, callback fault `lost`, and `b.find` failing: see how test/admin.test.ts makes one; note the stuck list also needs the age limit: the ops policy limit is 300 s by the real clock in compose, so either wait is impossible: instead insert an ops policy version 2 with `pendingAgeLimitSec: 10` through SQL for the demo tenant in YOUR stack only, and say so).
2. With curl first: sign in as each of the four demo users and call every back office endpoint; write down the real response shapes next to what the screen expects. This list is your work plan and goes into your report.
3. Fix every mismatch. Prefer fixing the screen. Fix the server only where it deviates from the specification or where its shape is plainly unusable; then add or adjust a server test. Update web/dev/mock-server.mjs to return exactly the real shapes (it stays as a development aid), and add web unit tests that pin the shapes the screen parses, using response bodies captured from the real server as fixtures (web/src/fixtures/*.json, captured, not hand-written; strip nothing but tokens).
4. In the real browser against the real server, for EACH of the four users: sign in (also a wrong password; also five wrong passwords and see the lock message, then use another user because the lock lasts 15 minutes by the real clock); walk every section; filters; "Load more" where there is enough data; open details. As `manager@alpha.demo`: resolve the stuck redemption... on beta use `manager@beta.demo` (the stuck one is on platform B); propose a wheel within the limit (see it applied; then open the PLAYER page for that tenant and see the new wheel segments); propose one above the limit (see it waiting). As `viewer@alpha.demo`: no resolve or propose controls; a direct call gets 403. As `ops@demo.local`: switch tenants; approve the waiting change; see the new wheel version; then check the Alerts section shows `wheel_expected_prize_high`. Audit: the resolve and the change show `admin/<user id>` actors; find a way for the screen to show the user's email or name next to an `admin/<uuid>` actor if the server gives it cheaply (if not, leave the id and say so). Sign out. A token that expires or is bad returns to sign-in.
5. Player page against the real server on both tenants: first open inside the casino frame, deposit from the casino's bar, spin, win, redeem, "In your casino account" (Beta shows "On its way" first). Fix: wheel labels on the left half of the wheel are upside down; make every label readable (flip the text for segments whose angle would turn it upside down). Check 4, 8 and 12 segments by proposing wheels through the back office.
6. Screenshots of every back office section and of the player page at 1440 and 390 px into the scratch area; LOOK at them (read the image files) and fix overlap, clipping, misalignment, unreadable text. No console errors except the 401/403/404 you trigger on purpose.
7. Stale text left by the auth change: docs/architecture.md (search for `X-Admin-Key`, `admin_key`, `X-Admin-Name`) and docs/img/diagrams.py (the card that says "admin API with the tenant's key"): make them true (sign-in, signed token, roles), regenerate the SVGs with `python3 docs/img/diagrams.py docs/img` and look at the rendered result (render with headless Chrome as the diagrams' author did) to be sure nothing overlaps. README "Run it": the addresses of the three pages, the four demo users with passwords in a small table, and the curl sign-in example; only what you ran.
8. Leftovers the server agent noticed: `web/src/state.ts`, `web/src/actions.ts` and any other file that still mentions `adminKey`: remove dead code.

## Rules
- `npm run verify` and `npm run verify:web` must pass before each commit. Never make a test pass with a sleep, a retry or a skip.
- Commit on your branch in small commits, one per kind of fix (e.g. "Screen reads the real shape of settings changes", "Wheel labels readable on the left half", "Docs: back office auth"). Each message: what was wrong, how it was found (the real response, the screenshot), the fix, how it was checked. No tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Agent (found by running the two halves together)".
- TypeScript strict; no `any` without a comment; no dead code; plain English in UI text and comments; no secrets in the bundle.
- If something in the server looks like a real defect (not a shape mismatch), write a failing server test first, then fix, as its own commit.

## Report back (read by a person who does not read the code; under 40 lines)
Branch and commit hashes; the mismatch list: for each, what the screen expected, what the server sent, which side was fixed; real defects found on either side; what each of the four users was seen doing in the real browser; screenshot directory; whether the lock after five wrong passwords was seen in the browser; anything still wrong; what is not tested.
````

## The agent's report

````text
The two halves work together. Almost nothing needed fixing on the server, and I fixed the few real mismatches on the screen. I ran all four users in a real headless Chrome against my own stack and looked at the screenshots. `npm run verify` (271 tests) and `npm run verify:web` (108 tests) were green on the last code change. The docs commit changed no code, so verify was not re-run after it. The stack is torn down.

**Branch and commits** (`worktree-agent-ab8f7f2bb9332fa7d`, nothing pushed):
- `719dadf` Audit rows and settings changes name the admin behind an `admin/<id>` actor
- `33a3cff` Screen reads the real shapes of the server answers
- `415fecf` Wheel labels readable on the left half after a spin
- `1b85228` Docs: back office sign-in, roles and demo users

**Mismatches found:**
1. **Events `kind` filter:** the screen offered free text, the server accepts only `deposit_succeeded` and `ignored` and answers 400 to anything else. The screen now shows a list of those two.
2. **Ignored events:** the server sends `playerId` and `playerExternalId` as null, which broke the player link. The screen now shows a dash.
3. **Audit and outbox ids:** these are numbers, the screen typed them as strings. Fixed on the screen.
4. **Admin actors:** both sides showed only `admin/<uuid>`. The server now also sends `actorEmail` on audit rows and `proposedByEmail`/`decidedByEmail` on settings changes, null for players, the system and policies. I wrote that server test first and saw it fail. The screen shows the email.
5. **Wheel editor at phone width:** the label input was too narrow. Fixed in the CSS.
6. **No mismatch on the other points the screen's author listed:** `changes[]` is camelCase with numbers, the queue at `/platform/settings-changes` is a bare array, audit `changes` is mixed (a `[{field, from, to}]` list for table rows, a plain object for platform calls), `lastPlatformCall` is `{call, error}`, `reward` is as the screen reads it, `playerId` filters take our uuid, and `/platform/tenants` and `demoAdmins` match. The server's `expectedPrizeCoins` agrees with the page's own computation on every stored wheel, and a test now pins that.
7. **Left as is:** the outbox "State" column is derived from the browser clock, because the server does not send a state. It would be a small server change if you want it exact.

**Real defects found:**
- **Wheel labels upside down after a spin:** the flip was fixed per slice at start, so after a spin the left half was upside down. It is now decided where the slice rests and applied when the wheel stops. I checked 4, 8 and 12 segments in screenshots after real spins, plus a unit test.
- **Server:** no defects beyond the missing emails.

**Fixtures and mock:** 35 response bodies captured from the real server are in `web/src/fixtures/`, with only the sign-in token replaced. `shapes.test.ts` type-checks them against the types the screen reads. `web/dev/mock-server.mjs` now returns the real shapes.

**What each user was seen doing:**
- **`manager@beta.demo`:** a wrong password was refused. They walked every section and filter, used Load more on events, spins and audit, opened details, and resolved the stuck redemption (it became `issued`, platform ref `manual`). The audit trail shows their email.
- **`manager@alpha.demo`:** proposed a wheel within the limit and it applied at once as version 3. A wheel above the limit waited. They got "Not allowed" on the waiting-changes page.
- **`viewer@alpha.demo`:** no propose or resolve controls, and direct calls got 403. A tampered token returned to the sign-in page with "Your session ended".
- **`ops@demo.local`:** approved the waiting change and saw the new wheel version. Alerts showed `wheel_expected_prize_high`, and the tenant switch and sign-out worked.
- **Player pages on both tenants:** the page opens inside the casino frame, and deposit, spin, win and redeem all worked. On Beta the status went "On its way" then "In your casino account". The new wheel segments from the back office appeared on the player page.

**Lock after five wrong passwords:** seen in the browser. After five failures the correct password was also refused. This was `manager@alpha.demo`, and the lock lasts 15 minutes.

**Console errors:** only the 401s and 403s I triggered on purpose.

**Screenshots:** `<scratch>/shots/`. They cover every back office section on both tenants at 1440 and 390 px, with no horizontal overflow. They also cover the player page and the wheels with 4, 8 and 12 segments.

**Docs and cleanup:**
- **Docs:** `docs/architecture.md`, the service diagram (SVG regenerated and rendered) and README "Run it" are updated, with the four demo users and a curl sign-in that I ran.
- **`adminKey` cleanup:** `web/src/state.ts` and `actions.ts` already had no `adminKey`, so there was nothing to remove.
- **Stuck demo:** for the stuck redemption I inserted ops policy version 2 with `pendingAgeLimitSec: 10` by SQL, in my stack only.
- **Rebuild once:** I rebuilt the app image once after the server change.
- **`docker-compose.override.yml`:** it is still in the worktree and is gitignored.

**Still wrong or untested:**
- On the player page at 390 px with a 12-segment wheel, the centre "No spin yet" pill covers part of the inner labels.
- On the ops policy table in Settings, the long parameters line scrolls sideways instead of wrapping.
- Not tested: token expiry by the real 30-minute clock (I used a tampered token instead), and the Alpha manager's behaviour after the lock ends.
````
