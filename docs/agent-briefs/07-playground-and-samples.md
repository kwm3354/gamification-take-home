# Brief 07: playground and samples

Wave 3. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You build a browser playground for a working prototype, and a page of sample requests and responses. The prototype is a gamification service for casino operators (NestJS + PostgreSQL + TigerBeetle): a casino platform sends a deposit event -> the player gets a Wheel of Fortune spin -> the prize is coins in a ledger -> the player redeems coins in a bonus store -> we ask the casino platform to issue the reward -> the status is tracked. Two simulated platforms: A answers at once, B accepts and reports later by webhook. A fake casino process plays both and can inject faults. All of that exists and has 153 passing tests. You work in your own git worktree on your own branch. Another agent works in parallel on admin endpoints and alerts (src/admin, src/alerts, src/schema.sql, src/store, src/tenants, docs/contracts.md); do not touch those.

## Read first
CLAUDE.md, docs/contracts.md (all; especially "Our HTTP API", "Fake casino", the two platform sections, "Redemption"), docs/failure-table.md, src/fake-casino/* (all of it: the control API you will call from the page, the faults, how `GET /` serves `public/index.html`), src/tenants/demo-tenants.ts, test/judge.ts (the rules the page's verdict must mirror), src/main.ts, package.json (the `build` script), Dockerfile, docker-compose.yml, test/fake-casino.test.ts and test/fake.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle
npm run verify      # must be green (153 tests) before you change anything
```
The CPU has no AVX2, so the official TigerBeetle image and npm client crash here. For docker compose on THIS machine a gitignored `docker-compose.override.yml` is needed in your worktree root (create it; `.gitignore` already lists it):
```
services:
  tigerbeetle:
    image: tigerbeetle-oldcpu:0.17.9
  app:
    volumes:
      - <local-tigerbeetle-build>/node-client/x86_64-linux-gnu/client.node:/app/node_modules/tigerbeetle-node/dist/bin/x86_64-linux-gnu/client.node:ro
```
Run compose under your own project name so you do not collide with anyone: `docker compose -p playground up -d --build --wait`, and `docker compose -p playground down -v` when done. Host ports 30080 (app) and 30081 (fake casino) and 54329/30009 must be free; if another compose project of this repo holds them, wait a minute and retry, do not stop it. Do not stop any container you did not start.

## Files you own (create or edit only these)
- src/fake-casino/public/index.html (one file: HTML + CSS + plain JavaScript, no build step, no framework, no CDN, no external requests of any kind).
- src/fake-casino/** only as far as serving the page needs (e.g. a `GET /control/config` that returns `{ appUrl: <public app url for the browser>, tenants: [{ id, name, platform }] }`; the browser needs the app's address as seen from the HOST, so add env `PUBLIC_APP_URL` to main.ts, default `http://localhost:30080`). Do not change platform behaviour or faults.
- src/main.ts: add `app.enableCors()` with a one-line comment (the page is served from the fake casino's origin and calls our API from the browser; the demo allows any origin, a real deployment would list the operators' origins).
- package.json `build` script and, if needed, the Dockerfile: `public/` must end up in `dist/fake-casino/public/`.
- docker-compose.yml: only env for the fake-casino service if needed (`PUBLIC_APP_URL`).
- test/playground.test.ts (see Tests), docs/samples.md, README.md ONLY the section "Run it" (add the two lines that tell a reader to open the page), docs/ai-log.md (append rows).
No new npm dependencies.

## The page
It plays the casino and the player. Model: a sandbox page with numbered sections top to bottom and a request log at the bottom where every entry is labelled with who made the call. Calm, dense, readable; system font; works at 1280 px wide; light and dark via `prefers-color-scheme`; no emoji. Keyboard reachable; buttons are `<button>`.
1. **Context**: tenant (Alpha Casino on platform A / Beta Casino on platform B, from /control/config), player id (prefilled random, editable). A line that says in words what differs between the two platforms.
2. **Player**: balance (available / reserved), spins (available / used with prize), redemptions made in this session with status. A "refresh" button; the panel also refreshes after every action.
3. **Steps**, each a button with a one-line description of what it does, enabled only when it makes sense:
   - "Deposit 20.00" (the casino sends a signed deposit event to us), "Send the same deposit again" (same event id), "Deposit with a bad signature".
   - "Spin" (uses the oldest available spin), "Spin twice at once" (two parallel POSTs for one spin; show that both answers are the same).
   - Store: list of items with price; "Redeem" per item (a fresh Idempotency-Key per click), "Redeem the same request again" (same key), "Redeem twice at once" (two parallel POSTs with one key).
   - Platform B only: "Deliver platform B's answers now" (/control/b/deliver).
4. **Faults**: for the tenant's platform, a row per call point (grant, find, and callback on B) with a dropdown of the faults that point supports and a "times" number, "Arm" and "Clear all". Show what is armed now (GET /control/faults). One sentence explains `lost_answer`: "the casino does the work, we never get the answer".
5. **Run many players**: number of players (default 30, max 200), a seed, a fault rate slider (0-40 %) applied through /control/chaos to the grant/find/callback points with a sensible mix (lost_answer, lost_request, error_500, rate_limit, refuse, and on B callback lost/twice); "Run". For each player: deposit, token, spin, then redeem the cheapest item if the balance allows. Show progress. Then poll until every redemption is final and settled or 60 s passed; turn chaos off before the final polling so recovery can finish; show how many are still not final (that is a visible state, not an error).
6. **Verdict**: after a run, and on demand for the session's players: the rules from test/judge.ts computed IN THE PAGE from what an outside observer can see: the fake casino's /control/state (grants) and our public API with the players' tokens (/me, /store/redemptions/:id). Lines like "Rewards issued twice: 0", "Issued by us but not by the casino: 0", "Issued by the casino but refused by us: 0", "Balances below zero: 0", "Coins that do not add up (settled players): 0", each green at 0 and red otherwise with the ids. Say in one line what the verdict trusts (the casino and the balances) and what it does not (our own status alone).
7. **Operations** (endpoints another agent is adding now; the page must work without them and show "not available yet" on 404): with the tenant's admin key from /control/config (add `adminKey` there; it is a demo): "Alerts" (`GET {app}/admin/{tenantId}/alerts` -> `{ at, policyVersion, alerts: [{ code, severity, subject, value, limit, detail }] }`), "Stuck redemptions" (`GET {app}/admin/{tenantId}/redemptions/stuck` -> `{ limitSec, items: [{ id, status, settled, playerExternalId, costCoins, ageSec, platformRef, lastPlatformCall }] }`) with per item "Resolve as issued" / "Resolve as refused" (`POST {app}/admin/{tenantId}/redemptions/{id}/resolve` body `{ outcome, note }`, headers `X-Admin-Key`, `X-Admin-Name: playground`; ask for the note in an inline text field, never with prompt()), and "Audit trail" for a spin or redemption id (`GET {app}/admin/{tenantId}/audit?entityId=` -> `[{ id, at, actor, action, entityType, entityId, changes, requestId }]`) shown as a small timeline.
8. **Request log**: newest first, each entry: time, who -> whom ("casino -> us", "player -> us", "us -> casino" taken from /control/state `requests`, "admin -> us", "page -> fake casino control"), method and path, status, and an expandable raw request and response body (pretty JSON). A "copy as curl" button per entry. Keep at most 300 entries. No alert()/confirm()/prompt() anywhere.
Never put secrets in the page source: tokens come from /control/token at run time; the admin key from /control/config.
Player tokens last 10 minutes: get a fresh one when a call answers 401 and repeat the call once.

## docs/samples.md
"Sample requests and responses", produced by ACTUALLY running the stack (`docker compose -p playground up ...`) and capturing real curl output, not written by hand. Use a small script you keep in the scratch area (not committed) or commit it as scripts/samples.sh if it is short and clean (then README may mention it only if you ran it). Cover, with the exact curl command and the real response body for each: a signed deposit for platform A and for platform B (show the headers and the body the casino sends; use /control/deposit and also show the raw request as received, from /control/state or by building it in the script), a duplicate deposit, a bad signature (401), a token, `GET /me`, `GET /wheel`, a spin and its repeat, `GET /store/items`, a redemption on A (issued at once) and on B (submitting, then issued after the casino's webhook; show the webhook body), a repeated redemption with the same Idempotency-Key, not enough coins, and a redemption that survives a lost answer (arm `lost_answer` at a.grant, redeem, show "submitting", wait, show "issued", and show from /control/state that there is ONE grant). State at the top the date, that it was captured on the development machine with a local TigerBeetle build, and the commit hash. Do not invent any output.

## Tests (test/playground.test.ts)
No browser is available in CI, so test what can break without one:
1. The fake serves the page: `GET /` is 200 text/html and contains the section headings; `GET /control/config` has the tenants, the app url and admin keys.
2. Static checks on the file: no `http://` or `https://` URLs other than in text explaining localhost defaults, no `alert(`, `confirm(`, `prompt(`, no secret strings from demo-tenants.ts, every `id` referenced by `getElementById`/`querySelector('#...')` exists in the markup.
3. CORS: start the app (`startApp`) and send a browser-style preflight `OPTIONS /me` with `Origin` and `Access-Control-Request-Headers: authorization, idempotency-key, content-type, x-admin-key, x-admin-name`; the answer allows them. Note that test/app.ts builds the app itself, so if `enableCors` lives only in main.ts this test cannot see it: say so in your report as "needs a one-line change in test/app.ts by the owner" and instead test main.ts by a static check that it calls enableCors, plus the real compose check below.
4. The page's verdict logic: put the verdict rules in one pure function inside the page's script, clearly delimited by `/* verdict:start */` and `/* verdict:end */`; the test extracts that block, evaluates it (`new Function`), and feeds it hand-made cases: clean, a double grant, issued without a grant, a negative balance, coins that do not add up. It must flag exactly the bad ones.
Then check the page for real, by hand, against the compose stack: open it with a headless browser if one is installed (`npx playwright` is NOT installed; check `which chromium chromium-browser google-chrome`), run through the happy path on both tenants, and take a screenshot to the scratch area. If no browser is available, exercise the same calls the page makes with curl from the host origin (including a preflight), and say plainly in the report: "the page was not opened in a browser". Either way run "Run many players" at least once for each tenant with faults on (through a browser, or by a script that makes the same calls) and report the verdict numbers you actually saw.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting (the HTML file is outside biome's paths).
- Plain English in the page, short sentences, sentence case, no marketing words. The page is a tool, not a showcase.
- Commit on your branch when green, in two commits (the page with its tests and build change; the samples). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (a playground page with a fault panel and a verdict); agent (the layout)". Write in the row whether the page was opened in a real browser or not.

## Report back (read by a person who does not read the code; under 40 lines)
Branch and commit hashes; what the page has, section by section in one line each; whether it was opened in a real browser, and the path of the screenshot if any; the verdict numbers from the "run many players" runs for each tenant (players, fault rate, seed, how many redemptions issued / refused / still not final after 60 s, every verdict line); anything in the service that looked wrong while you used it (this is the first time the whole thing is used like a person would: report every surprise precisely, with ids); DEVIATIONS; what is not tested.
````

## The agent's report

````text
The playground page and the sample requests page are done, on branch `worktree-agent-a4638351a8a11a3dd`. I did not push or merge. There are two commits:
- `f421dd8`: the page, the tests and the build change.
- `545d6de`: `docs/samples.md` and its row in `docs/ai-log.md`.

`npm run verify` was green (167 tests) before the page commit.

**The page** (`src/fake-casino/public/index.html`, one file, no external requests). Sections, top to bottom:
1. Context: tenant, player id, a note on how platform A and B differ.
2. Player: balance, spins, and this session's redemptions with status.
3. Steps: deposit, repeat deposit, bad signature, spin, spin twice at once, redeem, repeat the redeem, redeem twice at once, deliver B's answers. Each button is enabled only when it makes sense.
4. Faults: per-call-point dropdown plus "times", Arm, Clear all, and what is armed now.
5. Run many players: N, seed and fault-rate slider, progress, chaos turned off before the final wait of up to 60 s.
6. Verdict: computed in the page from the casino's record and the balances.
7. Operations: alerts, stuck redemptions with resolve, and the audit trail.
8. Request log: 300 entries, expandable, "copy as curl".

**Real browser:** yes. Headless Chrome 146 was driven over the DevTools protocol, because the Playwright browser is not installed. It showed no script errors. Screenshots are in the scratchpad:
- `<scratch>/playground-top.png`
- `.../playground-ops.png`
- `.../run-alpha-casino.png`
- `.../run-beta-casino.png`

**Happy path in the browser, both tenants:**
- Deposit: accepted.
- Same deposit again: `duplicates: 1`.
- Bad signature: 401.
- Spin twice at once: identical answers, prize paid once.
- Operations: the admin endpoints were not in my worktree, so the page showed "Not available yet".

**Many-players runs** (30 players, 3 deposits each, fault rate 25 %, stack in compose):

| | Alpha (platform A), seed 7 | Beta (platform B), seed 11 |
|---|---|---|
| Redemptions made | 19 | 20 |
| Issued / refused / not final after waiting | 17 / 2 / 0 | 20 / 0 / 0 |
| Wait | 2 s | 4 s |

- Every verdict line was 0 on both runs: issued twice, wrong player, issued by us but not by the casino, issued by the casino but refused by us, balances below zero, coins that do not add up.
- The faults really fired. On Alpha: `a.find` error_500 x4, rate_limit x3, lost_request x1, and `a.grant` error_500, lost_answer, rate_limit x1 each plus refuse x2. On Beta: `b.find` error_500 x3, rate_limit x2, and `b.grant` error_500 and lost_answer x1 each. Two B callbacks were delivered twice.
- The Beta verdict covers both tenants' players (60 players, 39 redemptions, 37 grants), because it spans the whole session.

**Samples:** `docs/samples.md` was captured from a clean compose stack on the development machine and holds all the requested cases. One thing is derived, not captured: the B webhook body. It goes from the casino container to the app container, so I show the casino's callback record and say the body shape comes from `platform-b.ts`.

**Preflight:** a browser-style OPTIONS against the running app allowed all five requested headers.

**Surprises in the service:**
- A redemption with status `insufficient` shows `settled: false` forever, for example `d8b38a15-d107-42ad-88ef-8e79582deda7`. The judge treats it as quiet, but anything that filters on "not settled" would catch it.
- On B the first POST answers `submitting` with a `platformRef`, which is correct.
- An unsigned deposit returns Nest's default `{"message":"Unauthorized","statusCode":401}` rather than a shaped error body.

**Deviations:**
- I added `POST /control/faults/clear`. "Clear all" needed it; the existing `/control/reset` would also wipe the grants the verdict reads.
- I changed `test/fake-casino.test.ts`, which was not in my file list. One test asserted that `GET /` answers 404 ("no page yet"), which is now wrong. It now expects 200.
- The run has a "Deposits each" field, default 3. With 1 deposit only about 20 % of players can afford the cheapest item (100 coins).
- The page cannot see `settled`, so it counts a player as settled when all redemptions are final and reserved coins are 0. A prize credit that is still pending could show briefly as "coins do not add up".
- `docker-compose.override.yml` is gitignored. The sample script is kept outside the repo.

**Not tested:**
- The operations section against the real endpoints, since it was only seen on 404. Their response shapes follow the task text.
- "Copy as curl" (the clipboard) and the light theme.
- The window width other than 1280.
- The CORS preflight in `vitest`, because `test/app.ts` builds the app itself. The owner needs a one-line change in `test/app.ts` to call `enableCors` for that test to see it. For now there is a static check that `main.ts` calls it, plus the manual compose check above.
````
