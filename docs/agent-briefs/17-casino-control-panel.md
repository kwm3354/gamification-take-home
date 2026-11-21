# Brief 17: casino control panel

Wave 7. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: NestJS backend (`src/`), a fake casino as a separate process (`src/fake-casino/`, with a control API and a static control page `src/fake-casino/public/index.html`), a React app in `web/` (player page and back office, served by the main app at `/app/`). Read `CLAUDE.md` first and follow it. Do NOT read `CLAUDE.local.md` or `.private/`.

You own: `src/fake-casino/public/**`, and tests for it (see how `test/playground.test.ts` and `test/fake-casino.test.ts` test the current page / control API). You may add a small read-only endpoint to the fake casino's control API if the page needs data it cannot get now (keep it tiny, add a test). Do not touch `src/outbox/`, `src/store/`, `src/ledger/`, `src/config.ts`, `docker-compose.yml`, `web/` — other people are changing them right now.

## Problem
The control page of the fake casino (opened at http://localhost:30081) is the first draft of a playground. The author's verdict: nothing on it can be understood. It mixes player actions (deposit, spin, redeem — these now live on the real player page in the React app) with fault switches named in code terms ("Call point", "Fault", "Times"), plus a seeded chaos run and a log.

## What to build
Rewrite the page from scratch (plain HTML + CSS + vanilla JS in the one static file, no build step, no external resources). Strictly functional look, readable, same sober style as a back office: system font, clear headings, tables, no decoration. Works at 1440 and 390 px without horizontal page scroll. Plain English, short sentences, no jargon: a reader who has never seen the code must understand every line. Title: "Fake casino: control panel". One intro paragraph: this page stands in for the two casino platforms; it lets you make the casino misbehave and then check that no bonus was issued twice and no coins were lost; play as a player on the player page (link to it — read how the current page learns the app's URL; the React player page is `<app>/app/#/play` and the back office is `<app>/app/#/admin`; give both links).

Three sections only:

### 1. Make the casino misbehave
A list of scenarios, each a row/card with: a plain-words title, one sentence "what the casino will do", one sentence "what our system should do", a control to switch it on for the next N requests (N default 1) for a chosen tenant/platform where that applies, and its current state (armed: N left / off). Cover every fault the control API really supports — read `src/fake-casino/` and `docs/contracts.md` section "Fake casino" for the exact list and semantics (expected: error_500, rate_limit, refuse, lost_request, lost_answer, slow_answer for reward issue calls; for platform B the result callback lost / delivered twice / delayed; maybe faults on the status lookup). Do not invent faults that the API does not have, and do not promise behaviour in "what our system should do" that you have not confirmed from `docs/failure-table.md` or the flow tests in `test/store.test.ts`. Example wording:
- "The casino issues the bonus, but its answer is lost" — "The player gets the bonus in the casino; we never hear back." — "We ask the casino whether the bonus exists, find it, and mark the redemption issued. The player is charged once."
- "The casino does not receive the request" / "The casino answers with an error" / "The casino says: too many requests" / "The casino refuses the bonus" (→ coins go back to the player) / "The casino answers slowly" / "Platform B never sends the result" / "Platform B sends the result twice".
Scenarios that apply only to platform A or only to platform B say so ("Alpha Casino (platform A)", "Beta Casino (platform B)"; read `src/tenants/demo-tenants.ts` for names). One "Switch everything off" button. Keep the button "Deliver platform B's results now" if the API has it, with one sentence explaining when it is needed.

### 2. What the casino really issued
A table of bonuses the fake casino holds (per tenant: player id at the casino, bonus, reference/idempotency key, time, how many times it was requested if the API knows), newest first, with a Refresh button and auto-refresh every few seconds. Heading sentence: "This is the casino's own record. It is the truth the check below compares against."

### 3. Check
One button "Check now" that runs the existing judge/verdict call of the control API (find how the current page does "Check the session's players"; if the check needs a list of players, use all players the casino knows, adding a tiny endpoint if necessary). Show each check as a row with a plain sentence and pass/fail, e.g. "No bonus was issued twice", "Every issued bonus was paid for with coins exactly once", "No player's balance is below zero" — use the real checks the judge performs, worded plainly; do not list checks it does not perform.

Drop from the page: player actions, the seeded chaos run, the raw log. (Leave the control API endpoints themselves in place; tests and scripts use them.)

## Tests
Update `test/playground.test.ts` (or whichever tests cover the page) so they test the new page: the page is served; every scenario on the page maps to a fault the API accepts (arm each one through the same request the page sends and get a 2xx); the check call the page uses returns the shape the page reads. Keep the test style of the file. Mutation check: break one mapping on purpose, see the test fail, restore.

Tests need TigerBeetle: `export TB_BIN=<local-tigerbeetle-build>/tigerbeetle` and run `./scripts/tb-old-cpu.sh` after `npm install` in your worktree if node_modules is fresh (this machine's CPU has no AVX2). `npm run verify` must be green with no skipped ledger tests.

## Look at it
Run the fake casino alone on a free port (not 30080/30081/30086/54329/30009 — the author's demo stack uses them; you may point the page at that running stack's app for links but do not arm faults on the author's stack) or use your own compose project with other ports (`docker compose -p panel` with env `APP_PORT`, `FAKE_PORT`, `PG_PORT`, `TB_PORT`, `JAEGER_PORT` set to free ports in the 34xxx range; copy the gitignored `docker-compose.override.yml` from the main checkout `<repo>/` — it is needed on this CPU; tear the stack down with `down -v` when finished; disk is tight). Drive it in headless Chrome, arm "answer is lost" on platform A, redeem from the player page or by curl, and confirm the page's promise holds (one bonus in section 2, check passes). Take screenshots at 1440 and 390 px and look at them yourself.

## Commit
One or two commits on your worktree branch; message describes the change and how it was checked; no tool names, no attribution or co-author lines. Add one row at the end of the table in `docs/ai-log.md` in the same commit: `| HH:MM | what | Author (the panel keeps only what no other page has: faults in plain words, the casino's record, the check); agent (wording, layout) | how checked |`, time from `date +%H:%M`. Do not push. Update the short mention of the control panel in `README.md` / `docs/samples.md` only if what it says becomes false.

## Report
Short: what the page has now, the list of scenarios with the fault each maps to, what can break and which test catches it, what you saw in the browser, what was not checked. Give the paths of the screenshots.
````

## The agent's report

````text
The control page is rewritten from scratch and committed (`90e1d0d`, not pushed). `npm run verify` is green with 289 tests and no skipped ledger tests.

**The page**
- It is one static file, `src/fake-casino/public/index.html`, titled "Fake casino: control panel". It has an intro paragraph and links to `<app>/app/#/play` and `#/admin`; the app URL comes from `/control/config`.
- Section 1 is "Make the casino misbehave". Each scenario has a plain title, "The casino: …", "Our system: …", a casino selector where it applies, "next N requests" and a Switch on button. The armed state reads "Off" or "Armed: N left (Alpha Casino)". There is also "Switch everything off" and "Deliver platform B's results now".
- Section 2 is "What the casino really issued". It shows time, casino, player, bonus, reference and how many times it was requested, newest first, with Refresh and a refresh every 3 seconds.
- Section 3 is "Check now". It shows six pass/fail lines taken from what the judge really checks: no bonus issued twice, right player, issued means in the casino's record, refused means no bonus, no balance below zero, and coins add up for players with nothing open. A seventh "Waiting" line counts redemptions still waiting for an answer; it is not a failure.
- Player actions, the seeded random run and the raw log are gone from the page.

**Scenarios and the fault each uses**
- Answer lost: `a.grant` or `b.grant` with `lost_answer`.
- Request not received: `lost_request`.
- Error: `error_500`.
- Too many requests: `rate_limit`.
- Refused: `refuse`.
- Slow answer: `slow_answer`, with `delayMs` 5000.
- Look-up fails: `a.find` or `b.find` with `error_500`.
- Platform B never sends the result: `b.callback` with `lost`.
- Platform B sends it twice: `b.callback` with `twice`.
- Platform B sends it late: `b.callback` with `delay`.

The "Our system" wording follows `docs/failure-table.md`. For `lost_request`, `error_500`, `rate_limit`, `slow_answer` and the look-up failure, no flow test covers Beta Casino. Those rows show "Checked by a flow test on Alpha Casino only." when Beta is selected. I left out the find faults `rate_limit`, `lost_request` and `slow_answer`; the API accepts them but nothing confirms the behaviour. The delayed-result wording is my reading of the code, not a test.

**API addition**
I added `GET /control/players`, which lists the players the casino has met and the references they asked for. The check needs it to reach every player's redemptions, including ones that never produced a bonus. It is documented in `docs/contracts.md`, and `README.md` has a one-line update.

**What can break and which test catches it**
- `test/playground.test.ts` arms every scenario for every casino it offers through the page's own request builder. It checks the API accepts each, that the armed list maps back to the scenario, and that every grant and callback fault has a scenario.
- Misspelling a fault name made 3 tests fail. Misspelling a point name made 4 fail. Both were restored.
- The same file checks the shapes of `/control/players` and `/control/state` that the check reads, and that reset clears the players. The verdict logic tests and the static page checks (no external requests, no demo secrets) are kept.
- The shape the page reads from the app's `/me` and `/store/redemptions` is not covered by a test; only the live run exercised it.

**Seen in a browser**
- I used my own compose stack (`panel`, ports 34xxx, torn down with `down -v`).
- I clicked Switch on for "answer is lost" on Alpha through the page. Then I redeemed by curl: the redemption was "submitting", our system looked the bonus up and found it, and the casino's record held one bonus requested once. Check now passed on all lines.
- At 390 and 1440 px there is no horizontal scroll, and I looked at both screenshots. The 1440 px screenshot is `<scratch> On the phone view the section 2 table scrolls inside its own container, so the last columns are cut off until you scroll it.
- Screenshots: `<scratch> `<scratch> plus `<scratch>

**Not checked in the browser**
- Platform B scenarios.
- The "Deliver platform B's results now" button.
- Refused, error and slow scenarios.
- The failure-state messages when the app is unreachable.
- Light theme.
````
