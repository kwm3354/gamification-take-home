# Brief 22: documents sweep

Wave 8. Given to a coding agent (model `claude-opus-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Repository: an assignment prototype of a gamification service for casino operators (NestJS, PostgreSQL, TigerBeetle, React back office and player page, fake casino). Read `CLAUDE.md` first. Do NOT read `CLAUDE.local.md` or `.private/`. You are an editor: make the design documents TRUE against the code as it is now, and plain. You change ONLY these files: `docs/architecture.md`, `docs/scaling-plan.md`, `docs/90-day-plan.md`, `docs/samples.md`, `docs/monitoring-playbook.md`, `docs/img/diagrams.py`, `docs/img/service.svg`, `docs/img/redemption.svg`. Do NOT touch `README.md`, `docs/contracts.md`, `docs/failure-table.md`, `docs/verification.md`, `docs/performance.md`, `docs/ai-log.md` (others are editing them), nor any code.

## Why
The documents were drafted before several changes landed today. A reviewer and then an interviewer will read them, and the author must defend every sentence. Stale or unproven statements cost more than missing ones.

## What changed since the drafts (verify each in the code and in `docs/contracts.md`, which is the binding contract and is current)
- Outbox: jobs are claimed with a LEASE and a claim token in one short statement; handlers (casino calls, ledger calls) run with NO database transaction open; the outcome is written only by the holder of the token (`src/outbox/outbox.ts`). The earlier design ran the handler under a row lock inside a transaction — that was a design mistake found by the load measurement and is described as such in `docs/performance.md`. No text may still describe the row-lock design.
- A redemption request no longer holds a transaction across casino or ledger calls; the "two at a time" limit is gone (`src/store/`).
- Process roles: `ROLE=all|api|worker`; compose runs one `app` (api) and a `worker` service with 2 replicas; workers scale by count (`docker compose up --scale worker=N`). Measured: `docs/performance.md` (last two sections).
- Back office: real sign-in (`admin_users`, scrypt, a token we sign, 30 minutes), roles `platform_admin` / `tenant_admin` / `tenant_viewer`, lockout; NO shared admin key headers anywhere (search all your files for `X-Admin-Key`, `X-Tenant-Id`, `admin key` and remove). 
- Tenant keys: the event signing secret and the player token secret can be replaced from the back office by the tenant's admin; the old key works until a chosen time (0 to 24 h) and can be stopped early; shown once; audited (`docs/contracts.md` "Tenant keys").
- Settings changes as an intent: a tenant admin proposes a wheel; a policy applies it at once if the expected prize is within the limit, otherwise it waits for a platform admin.
- Observability: structured logs with a request id, alerts as SQL, tracing with OpenTelemetry and Jaeger in compose, a monitoring playbook for a daily digest agent.
- The player page's "behind the scenes" control now links to the player's page in the back office; the fake casino control panel (port 30081) was rewritten: faults in plain words, the casino's record, a check.
- Tests being added right now by others (mention only as "see `docs/verification.md`", do not state they exist unless you find the files on `main`): a property test, a real-process kill test, a route-walking tenant isolation test.

## Decisions of the author that the documents must reflect (these are HIS decisions; phrase them as "I" in the first person where the document already speaks so; do not invent reasons he did not give)
- TigerBeetle for the ledger, his reason: it guarantees the ledger is correct, it has headroom far above this load, and it removes most of the work of writing a ledger by hand, which frees time for the product.
- Ports and adapters: one domain, one adapter per casino PLATFORM; his reason: "there are many casinos and one domain logic — classic OOP".
- Coins are RESERVED, not spent, until the casino answers; his reason: coins must not disappear while the casino has not answered.
- One internal model for both platforms: a redemption is an intent; the synchronous platform is the same model with two steps taken at once (create the intent, then confirm it).
- Operator differences are versioned settings (policies), not code; a casino's representative forms the intent to change, a policy decides whether it applies automatically; which policies apply to which casino is decided only by us.
- Tenant isolation: enforced in code and checked by a test that reads the routes and forces a decision for each (two lists: checked and skipped; a route in neither fails). He prefers this to database row-level rules; database-level rules or separate databases only when a client's contract requires it. So in `docs/scaling-plan.md` the "first steps to production" must NOT list database-enforced isolation (row-level security) as step one. His first production steps are now: backups with a tested restore including the ledger; load tests; and the route isolation test kept mandatory in CI. Secrets store and schema migrations are stated as basic hygiene without which production is impossible.
- Kafka at intake: not justified by today's measured numbers; stays in the production plan as an availability measure (accept events while the core is down). A connection pooler belongs to the step with many processes.
- Architecture going forward: a modular monolith, with three things separated when needed: the ledger (already separate), queued event intake with consumers, and a real-time gateway that holds connections (a dedicated server such as Centrifugo). He does not want microservices for their own sake.
- New mechanic example (contests / player-vs-player): designed for n > 1 players from the start; stakes sit on a contest account in the ledger; an unfilled contest is cancelled and stakes go back, unless the business says otherwise; a new event "contest finished".
- MVP: wheel + store, one real platform integration, missions, back office, a presentable widget, a production environment. Team: a product owner, one engineer, a competent QA, all working with AI agents; a designer with domain experience when needed; the widget's source must stay modifiable.
- Incidents: the product owner with agents, through MCP tools on the same entry points the back office uses (read and act); on-call by team agreement, not imposed from day one.
- 90 days: test plan first; the integration is run as a managed project; a pilot with one casino as early as possible (narrow pilot by the end of month 1, wider in month 2, all players and A/B tests in month 3); no promised date; his estimate is that three months are enough for an integration; he states plainly that he is new to this industry.
- The playground (fake casino + player page) is part of the product, first for sales.
- Widget delivery: bundles built per casino and served from a CDN with cache warming; he leans to a mix (look baked per casino, wheel and rewards from the server); A/B tests decide.
- AI automation: daily digests, code review during development, MCP for product analytics and incident resolution. An LLM reads whole objects with read-only access; alerts themselves are deterministic SQL, not an LLM.

## How to work
1. For each of your files: read it fully, then check EVERY factual sentence against the code (`src/`, `src/schema.sql`, `docker-compose.yml`, `test/`) or `docs/contracts.md`. Fix what is false; delete what cannot be checked and does not matter; mark what is a plan as a plan ("not built"). Endpoint paths, header names, status names, table and column names, env variable names, port numbers, counts of tests/alerts/events must match the code exactly — or be removed. Numbers about performance may only be quoted from `docs/performance.md` with its conditions.
2. `docs/samples.md`: every sample request must work against the current API (sign-in with a bearer token for admin calls, current paths). If a compose stack is needed to re-capture, do NOT start one on default ports (the author's demo runs on 30080/30081); you may start your own with `docker compose -p sweep` and env `APP_PORT=36080 FAKE_PORT=36081 PG_PORT=56329 TB_PORT=36009 JAEGER_PORT=36086` (copy the gitignored `docker-compose.override.yml` from `<repo>/` into your worktree first — this CPU needs it), run the samples, tear down with `down -v`. If you cannot run them, check them by reading the controllers and say so in your report.
3. Diagrams: `docs/img/diagrams.py` generates the SVGs (`python3 docs/img/diagrams.py <out_dir>` — read the file for usage). Update the service diagram for: api and worker processes, the outbox lease, back office sign-in, Jaeger; keep it simple and legible. Render to PNG (e.g. `rsvg-convert` or headless Chrome) and LOOK at it: no overlapping text, nothing cut off.
4. Style: plain English, short sentences, no marketing words, no em-dash chains, define a term the first time it is used. Do not mention any company, the task text, the author's other projects, or any AI product by name ("AI agents" is fine). Keep each document's existing structure unless it is wrong. `docs/scaling-plan.md` answers six questions about scaling — keep them as six clearly headed answers, each starting with the answer itself in one or two sentences.
5. At the end of `docs/architecture.md` keep (or add) a short section "What I am least sure about" with the honest weak points (everything outside is simulated; secrets are plain text in the database; tenant isolation has no second lock in the database; compose is proven on a Linux CI runner only; one test is known to flake under load).

## Commit
Commit on your worktree branch in one or two commits; message describes the change; no tool names, no attribution or co-author lines. Do not push. Do not edit `docs/ai-log.md`.

## Report (short)
Per file: what was false and is now fixed (list the notable ones), what you removed, what you could not verify. Then: a numbered list of every sentence in `docs/scaling-plan.md` and `docs/90-day-plan.md` that is YOUR interpretation rather than a stated decision above (so the author can confirm or strike each). Time box: 40 minutes.
````

## The agent's report

````text
I've updated all eight files so they match the code at 9b692dc, and committed them as `378ce10` on the worktree branch (not pushed). I ran the samples again on my own compose stack (`-p sweep`, moved ports, torn down with `down -v`). I also ran the two new playbook queries read-only against the demo database. I did not run `npm run verify`, since only docs changed.

## Per file

**`docs/architecture.md`**
- **Outbox:** the row-lock text is gone. It now describes the lease and claim token, handlers running with no transaction open, and the request running its own job through `claimOne`. The old design is described as the mistake it was, with a pointer to `docs/performance.md`.
- **"one NestJS process"** was false. It now describes the api and worker processes chosen by `ROLE`, with the measured worker times (7.1 s, 3.4 s, 1.8 s) and the conditions they were measured under.
- **Removed false statements:** "No throughput or latency was measured", "a separate worker process was not tried", "Not built: metrics and traces" (traces exist), "19 named events" (there are 24; I removed the count) and "load tests" in the not-built list.
- **Isolation decision:** it said database-level isolation came first. It now gives your current position and says the earlier one changed.
- **Added:** your reasons for TigerBeetle, ports and adapters, and reserving coins; tenant keys; the web app's back-office link; Jaeger; the fake casino control page; a 404 for another tenant's path; two more isolation tests by name. All test names were checked against `test/`.
- **Removed:** fragile line numbers and the "Part C" and "assignment" wording.
- **Added at the end:** "What I am least sure about".

**`docs/scaling-plan.md`**
- **First steps:** row-level security was step one. The first steps are now backups with a tested restore, load tests, and the route isolation test in CI. Secrets store and migrations are stated as basic hygiene.
- **"Designed, not built: the settings-change intent"** was false. The wheel intent, log level per tenant and tenant keys are now listed as built.
- **Added:** Kafka as an availability measure, the connection pooler, the modular monolith with Centrifugo as an example, and the MCP incident path.
- **Removed:** "I have run the gateway split in an earlier project", because it is about your other projects. Also removed "a React app being built, not on main", which was false.
- Each of the six answers now opens with the answer itself.

**`docs/90-day-plan.md`**
- **Pilot stages** are now stated: narrow by the end of month 1, wider in month 2, all players in month 3.
- **First three steps** are replaced with your current ones.
- **"The wheel can be switched off by one setting"** was false; no such switch exists. It is now listed as work to do, with today's nearest option: a grant policy with 0 spins, which has no API yet.
- **Added:** your lean toward mixing what is built per casino and what comes from the server, and MCP and on-call for incidents.

**`docs/samples.md`**
- **Captured again** with the current output. The headers now include `x-request-id` and `x-trace-id`.
- **"insufficient … settled:false"** in the old sample was false. The real answer is now `settled:true`, which matches the contract.
- **Added:** admin sign-in, the audit trail of the lost-answer redemption, alerts, and the 401 and 404 cases.
- The stack ran on ports 36080/36081 and the commands are shown with 30080/30081. The page says so.

**`docs/monitoring-playbook.md`**
- **Sign-in:** the admin endpoints now need a sign-in. There is no read-only role covering all tenants, and the agent must not use `platform_admin`.
- **SQL:** the outbox check now has lease columns, and there is a new `settings_changes` query.
- **Logs:** added `outbox.lease_lost`, `tenant.key_rotated`, `tenant.key_previous_revoked` and `traceId`. A key replacement is now listed as a likely cause of a burst of bad signatures.

**Diagrams:** the service diagram now shows the api and worker processes, the lease, sign-in, and logs and traces going to Jaeger. In the redemption diagram, failure badge 5 was hidden behind a box and now shows. I rendered both with headless Chrome and looked at them; nothing overlaps or is cut off.

**Could not verify:** which test flakes under load, so it is not named. Whether the route-walking, property and kill tests exist: none are on main, so the docs say "being added, see `docs/verification.md`".

## Sentences that are my interpretation, not your stated decision

**`docs/scaling-plan.md`**
1. "A restore that was never run is not a backup, and the ledger is a second store that must be restored to the same point as PostgreSQL."
2. "The load numbers we have come from one busy development machine; production needs its own."
3. "…the test that walks every route … is what keeps a new route from leaking another tenant's data." (my reason for why this is a first step)
4. The pooler is needed "when the sum of their pools approaches what PostgreSQL allows".
5. "The outbox workers already run as separate processes, but they are the same application started with another `ROLE`, not a service of their own."
6. "A console a casino's manager can be given alone, beyond the back office screens above" (listed as designed, not built).
7. In the summary of question 4: "I am new to this industry, and the plan says so." (Your statement, but placing it in the summary was my choice.)
8. "A clear playground also makes estimates more accurate and shows quickly what is exchanged with a platform…" (kept from the earlier draft; I have no record of your decision on it.)
9. Under question 6: "Interface variants for the player page were made with agents." (Logged at 13:10 as "interface variants", but I did not confirm it happened.)

**`docs/90-day-plan.md`**
10. "A switch to turn the wheel off for one casino is part of this work" (month 1).
11. "load tests in the production environment" (the brief says only "load tests").
12. "with agents (and a designer with experience in this field if needed)" (month 2 widget work).
13. Kept from the earlier draft, never stated by you in the brief: "Feedback from production is worth more than a later, larger launch"; month 2 "Before each widening, close the first three production steps"; and the "How we know it is done" lines for each month.

Earlier sentences in `docs/90-day-plan.md` that I did not change (the risks list and "What is not in these 90 days") were also drafted before today. Please read them once.
````
