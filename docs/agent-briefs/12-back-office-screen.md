# Brief 12: back office screen

Wave 5. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You rebuild the back office screen of an existing React app as a proper, strictly functional admin tool with real sign-in, and you reframe the player page as a widget on a casino's site. The backend is a NestJS gamification service for casino operators (deposit -> wheel spin -> coins -> redemption -> the casino platform issues the reward). You work in your own git worktree on your own branch. A backend agent is building the endpoints you call RIGHT NOW from the same specification, so they do not exist in your worktree yet: you build against the specification with a small mock, and the integration is checked after both branches merge.

Do not touch anything outside web/** except: README.md ("Run it" section only) and docs/ai-log.md (append rows). Not src/**, not test/**, not docs/contracts.md.

## Read first
CLAUDE.md; docs/contracts.md sections "Our HTTP API", "Admin and operations", "Back office API", "Changing the wheel: an intent that a policy confirms", "Admin sign-in and roles" (the specification of every call you make: shapes, status codes, roles); all of web/src (App.tsx, store.ts, state.ts, api.ts, actions.ts, pages/AdminPage.tsx, pages/PlayPage.tsx, components/*, the CSS files, the tests); web/package.json and vite config; docs/samples.md for real response bodies.

## Machine setup
```
npm ci && npm run web:install
npm run verify:web        # must be green before you change anything
```
The disk is nearly full: do not run docker compose, do not install a browser, do not leave build caches or temp files outside web/. Chrome is installed (`which google-chrome chromium chromium-browser`); the previous agent drove it over the DevTools protocol with a small script kept in the scratch area; do the same. For data, write a tiny mock server (plain node:http, in the scratch area or under web/dev/mock-server.mjs if you want it kept: then document it in one README line) that implements the specification's endpoints with believable fixed data for two tenants, including sign-in with the four demo users, roles, pagination, a stuck redemption, alerts, a waiting settings change, and the player endpoints the player page uses. The mock is a development aid only; no test may depend on it at run time except your browser check.

## Product decisions (from the owner; build exactly this)
1. The back office is a separate working screen, not a layer over the game: "strictly functional, not pretty". It reads everything from the server. The current admin page listed "players in this session" from the browser's shared state: that is wrong for a back office and goes away. The admin route must not read the player session store at all.
2. Real sign-in. No key fields, no "your name" field: the identity comes from the signed token. The owner: "a leaky admin in the demo is a failure".
3. The player page: "looks a bit like a toy". It should read as OUR widget placed on a casino's website, so it is obvious what is the casino's and what is ours.
4. One React app, two routes, one codebase, shared API client and types. The player page keeps its session store.

## Back office (`#/admin/...`)
**Sign-in screen**: email, password, "Sign in". For the demo, a small note under the form lists the four demo users as buttons that fill the form (email and the demo password; the passwords are given to the page at run time by `GET /app-config.json` field `demoAdmins: [{ email, password, role, tenantId }]` if present; if the field is absent show no buttons. Tell the backend owner in your report that this field is needed; do not hardcode passwords in the bundle). Errors: 401 -> "Wrong email or password, or the account is locked."; network error -> a plain message. The token is kept in memory and in sessionStorage (not localStorage); on 401 from any call the app returns to sign-in with "Your session ended". A "Sign out" button. Show who is signed in: name, role, tenant.
**Layout**: a left sidebar with the sections; a top bar with the tenant (a picker only for `platform_admin`, from `GET /platform/tenants`; fixed text for tenant roles), the signed-in user and sign out; the content area. Neutral and dense: system font at 13-14 px, a light theme by default with a dark one via `prefers-color-scheme`, one accent used only for the primary action and links, 1 px borders, no shadows, no gradients, no rounded "cards" stacked down the page, no decoration. Tables are the main element: sticky header, right-aligned numbers with tabular figures, monospace short ids (first 8 chars) with the full id on hover and a copy button, status as text with a small colour mark (never colour alone), row click opens the detail. Empty, loading and error states for every table, in the table body, in plain words. Works from 1024 px up; below that the sidebar collapses to a top menu; nothing overlaps at 390 px.
**Routing**: hash routes that can be shared and reloaded: `#/admin/overview`, `#/admin/alerts`, `#/admin/redemptions`, `#/admin/redemptions/<id>`, `#/admin/stuck`, `#/admin/players`, `#/admin/players/<id>`, `#/admin/events`, `#/admin/events/<id>`, `#/admin/spins`, `#/admin/settings`, `#/admin/changes` (platform admin: waiting changes of all tenants), `#/admin/outbox`, `#/admin/audit`. Filters live in the hash query (`?status=submitting`) so a filtered view is a link. Keep the tiny hand-written router; extend it.
**Sections** (each calls exactly the endpoint in the specification):
- Overview: the numbers of `GET /admin/{t}/overview` as a plain definition grid (label, number), each number a link to the filtered list; alerts summary; settings versions. Auto-refresh every 10 s while visible, with "updated HH:MM:SS".
- Alerts: table of alerts (severity, code, subject, value, limit, detail as expandable JSON). "No alerts" as an explicit good state.
- Redemptions: table with filters (status, player id), pagination by "Load more" using `nextCursor`. Detail: the fields, the reward, the job row (attempts, last error, next run), and the audit timeline (time, actor, action, changed fields as `field: from -> to`, request id). If the status is `submitting` and the role allows: the resolve form (outcome radio, required note 5..500 chars, a sentence: "Use this only when the casino cannot tell us the outcome. What to choose is an agreement with the casino."), 409 shown as "already final".
- Stuck: `GET /admin/{t}/redemptions/stuck` as a table (age as a duration, last platform call), each row links to the redemption detail.
- Players: search by the start of the external id; detail with balance (or "ledger not answering"), spins, redemptions, events.
- Events: table with a kind filter; detail shows `normalized` and `raw` as formatted JSON and the spins the event gave.
- Spins: table with status filter.
- Settings: the wheel versions (segments table with weight, share in percent, coins; the expected prize per version; the current version marked), grant policy versions, ops policy versions, store items; all read-only tables. Below the wheel: "Propose a new wheel": an editable segments table starting from the current version (add row, remove row, edit label/coins/weight), a live computed expected prize next to the limit from the newest ops policy with a plain sentence: "Within the limit: this change will be applied at once." or "Above the limit of N: this change will wait for the platform team." Submit -> `POST /admin/{t}/settings/wheel`; show the result (201 applied with the new version; 202 waiting). Hidden for `tenant_viewer`. Then the list of this tenant's changes with status.
- Changes (platform admin only; the menu item is hidden for others and the route shows "Not allowed for your role"): `GET /platform/settings-changes?status=proposed`, each with the proposed segments, expected prize against the limit, who proposed, and Approve / Reject with a required note.
- Outbox: table with a state filter.
- Audit: recent rows (`?recent=1`) with filters by action and actor prefix, and a lookup by entity id.
Role handling: hide what the role cannot do, and still handle 403 from the server with a clear message (the server is the authority; the hiding is a courtesy).
A collapsible "Requests" panel at the bottom of the back office listing the calls this page made (method, path, status, ms), for the reviewer; no bodies of sign-in calls and never the token.

## Player page (`#/play`), reframe only (do not redo the wheel)
- Put the widget inside a simple mock of a casino website: a top bar that clearly belongs to the casino (the casino's name and accent, a few inert nav words such as "Slots", "Live", "Promotions", the player's wallet in EUR as plain text, and the casino's own "Deposit €20" button), and below it the page body with our widget in a framed panel titled by a small label "Wheel of Fortune - a gamification widget" so the boundary is visible. The deposit action moves OUT of the widget into the casino's top bar; inside the widget, when there is no spin, the call to action is "Make a deposit to get a spin" with an arrow or pointer toward the casino's button, not a button of ours. Everything else keeps the current one-obvious-action logic.
- The wheel must draw any number of segments from `GET /wheel` well (2..24): label size and orientation adapt; test it visually with 8 and with 12 segments in the mock.
- Tone down what reads as a toy: one restrained colour scheme per casino, smaller type, less glow; keep the win moment and the deceleration.
- In "Behind the scenes" fix the labels: the line for our call to the casino must read "us -> casino", not "player -> us" (derive the actor from which call the line narrates).
- Remove the link to the admin page's session view; keep one small link "Back office" in the demo controls.

## Tests
- Keep the existing web unit tests green; add: the router (parse and build of every admin route with filters); the role helper that decides what to show per role (mirror of the specification's table); the expected-prize function and the "within / above the limit" sentence (exact arithmetic: integer sums, one division for display); cursor pagination state (append pages, no duplicates, stop on null); the sign-in state machine (success, 401, session ended on a later 401, sign out clears sessionStorage); the "behind the scenes" actor labels; wheel geometry for 2, 8, 12 and 24 segments (slices cover the circle exactly, labels inside their slice).
- Browser check, required, against your mock: sign in as each of the four users; walk every section; open a redemption detail and resolve it; propose a wheel within the limit and one above it; as the platform admin approve the waiting one; confirm the viewer sees no resolve or propose controls; sign out. Player page: first open inside the casino frame, deposit from the casino's bar, spin, win, reward. Screenshots at 1440, 1024 and 390 px (back office light and dark; player page) into the scratch area; LOOK at each one (read the image files) for overlap, clipping, cramped or misaligned tables, unreadable text; fix and re-shoot. Check the browser console for errors.

## Rules
- `npm run verify:web` must pass before each commit (typecheck, unit tests, build). TypeScript strict; no `any` without a comment saying why; no dead code; no leftover console.log. No new dependencies beyond what web/ has.
- No secrets in the bundle: no passwords, keys or tokens in web/src.
- Plain English in the UI, sentence case, short sentences, no marketing words, no emoji.
- Three commits: the back office shell with sign-in and routing; the sections; the player page reframe. Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (a separate, strictly functional back office with real sign-in that reads the server; the player page as a widget on a casino site); agent (layout and details)". Say in each row that the screens were checked against a mock, not the real server.

## Report back (read by a person who does not read the code; under 40 lines)
Branch and commit hashes; the sections built; what was driven in a real browser and with which user; screenshot paths; every place where the specification was unclear and what you assumed (the backend agent reads the same text, so these are the likely mismatches: list them precisely, endpoint by endpoint); what the backend must provide that the specification does not say (e.g. `demoAdmins` in /app-config.json); what is not tested.
````

## The agent's report

````text
The back office rebuild and the player-page reframe are finished in three commits. Everything was checked against my mock server (`web/dev/mock-server.mjs`), not the real backend. Nothing was pushed or merged.

**Branch:** `worktree-agent-a92cf70fc34ee0c3f`
- `db95f4e` shell: sign-in, roles, routes, overview
- `6debe67` all the sections
- `5395216` player page reframe
- `npm run verify:web` is green (99 unit tests).

**What was built**
- **Sign-in:** the back office has a real sign-in screen with a note listing the four demo users as buttons.
- **Layout:** left sidebar, top bar with tenant, user and sign-out, and a collapsible Requests panel. Hash routes carry the filters.
- **Sections:** all of them are built: overview, alerts, redemptions (detail plus resolve form), stuck, players, events, spins, settings (wheel proposal form with live expected prize), waiting changes, outbox, audit.
- **Isolation:** the admin route never mounts the player store, and the old session-based admin page is deleted.
- **Player page:** now sits inside a mock casino site with a casino top bar. The deposit button is the casino's, and our widget is a framed panel labelled "Wheel of Fortune - a gamification widget".
- **Wheel:** draws any number of segments from 2 to 24, checked with 8, 12 and 24.
- **Behind the scenes:** the call to the casino now reads "us -> casino".
- **README:** the Run it section and `docs/ai-log.md` are updated, one row per commit.

**Driven in headless Chrome with the mock**
- Wrong password gives the 401 message. All four demo users signed in.
- The alpha manager resolved a stuck redemption, proposed a wheel within the limit (applied as v2) and one above it (waiting).
- The viewer saw no resolve or propose controls, and a direct call got 403.
- The beta manager got 404 on alpha's tenant and "ledger not answering" on its own overview.
- The platform admin approved the waiting change (v3) and switched tenants.
- "Load more" ran through 130 players, and filters from the hash worked. A bad token returned to sign-in with "Your session ended".
- Player page: first open inside the frame, deposit from the casino bar, spin, win, redeem, "In your casino account". No console errors, apart from the 401/403/404 I triggered on purpose.
- Screenshots are in `<scratch>/bo/shots/`:
  - `1440-*`, `1024-*`, `390-*` and `*d-*` (dark) for the back office.
  - `play-<width>-<segments>-*` for the player page.
  - `flow-*` for the interactive steps.
  - I read them and fixed what I saw.

**What the backend must provide beyond the spec**
- `GET /app-config.json` must include `demoAdmins: [{ email, password, role, tenantId }]`. Without it the page shows no demo buttons. No passwords are in the bundle.
- The fake casino's `/control/config` may keep or drop `adminKey` in its tenants. The page ignores it.

**Spec was unclear, so I assumed this (likely mismatches):**
- **`GET /admin/{t}/settings` `changes[]` and `GET /platform/settings-changes`:** the item shape is not defined. I assumed camelCase of the `settings_changes` columns (`id, tenantId, status, proposed, expectedPrizeCoins, limitCoins, proposedBy, decidedBy, decisionNote, createdAt, decidedAt`). `proposed` may be a bare segments array or `{ segments }`. The platform endpoint may return a bare array or `{ items }` / `{ changes }`. The numeric fields may be numbers or strings.
- **Audit `changes`:** shown as `field: from -> to` if it is `{field: {from, to}}` or `[{field, from, to}]`. Anything else is shown as `key: value` lines. Please check what `audited.ts` really writes.
- **Stuck `lastPlatformCall`:** shape not defined. Shown as one JSON line, cut at 80 characters.
- **Audit with `recent=1`:** I assumed rows carry `cursor` and the response is `{ items, nextCursor }`. With `entityId` I assumed a bare array.
- **`GET /admin/{t}/redemptions/:id` `reward`:** shown as raw JSON.
- **`playerId` filters:** I assumed they take our uuid, not the external id.
- **Events `kind` filter:** the values are unknown, so it is a text field.
- **Outbox row state:** derived client-side from `deadAt`, `doneAt` and `runAt`.
- **Expected prize:** computed in the page from segments with integer sums and compared to `maxExpectedPrizeCoins`. The server's number should agree.
- **Players list:** I assumed `{ id, externalId, createdAt, spinsAvailable, spinsUsed, redemptions }` as in the spec, and balance in the detail as `{ available, reserved }`.
- **Wallet:** the casino wallet in EUR is a demo figure in the page, starting at 0.00 and adding 20.00 per deposit. No server value feeds it.
- **Tenant list:** `/platform/tenants` is called for every role, to get the tenant name.

**Not tested**
- Nothing against the real backend: field names, the demo users and the `app-config.json` field are checked only against my mock.
- Lockout after repeated failures (the backend's job) and the 10-second auto-refresh over a long time.
- Tab order and screen readers.
- Beta's wheel in the dark theme, and the 1024 px player page beyond one shot.
- No lint run, because biome is not installed at the root.
````
