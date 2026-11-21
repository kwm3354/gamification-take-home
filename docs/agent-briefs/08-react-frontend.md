# Brief 08: react frontend

Wave 4. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You build the frontend of a working backend prototype: ONE React application with two routes that share one in-browser state: a player page (a Wheel of Fortune you can actually spin, coin balance, bonus store) and an admin page (operations console). The backend is a gamification service for casino operators (NestJS + PostgreSQL + TigerBeetle): a casino platform sends a deposit event -> the player gets a wheel spin -> the prize is coins -> the player redeems coins in a bonus store -> we ask the casino platform to issue the reward -> the status is tracked. It exists, has 167 passing tests, and runs in docker compose together with a fake casino process. You work in your own git worktree on your own branch. Another agent is finishing the admin endpoints in parallel (src/admin, src/alerts, src/schema.sql, src/store, src/tenants, docs/contracts.md, docs/monitoring-playbook.md); do not touch those.

## Read first
CLAUDE.md, docs/contracts.md (all; "Our HTTP API", "Wheel outcome", "Redemption", the two platform sections, "Fake casino"), docs/samples.md (real requests and responses), src/fake-casino/public/index.html (the existing plain-HTML control panel: it already talks to every endpoint; reuse its knowledge of the API, the token refresh on 401, the request log idea), src/fake-casino/* (control API: /control/config, /control/deposit, /control/token, /control/state, /control/b/deliver), src/main.ts, package.json, Dockerfile, docker-compose.yml, .github/workflows/ci.yml, README.md ("Run it"), test/playground.test.ts, vitest.config.ts, biome.json.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle
npm run verify      # must be green (167 tests) before you change anything
```
The CPU has no AVX2, so the official TigerBeetle image and npm client crash here. For docker compose on THIS machine create a gitignored `docker-compose.override.yml` in your worktree root (`.gitignore` lists it):
```
services:
  tigerbeetle:
    image: tigerbeetle-oldcpu:0.17.9
  app:
    volumes:
      - <local-tigerbeetle-build>/node-client/x86_64-linux-gnu/client.node:/app/node_modules/tigerbeetle-node/dist/bin/x86_64-linux-gnu/client.node:ro
```
The owner's own stack is running on the default host ports and he is using it: DO NOT stop it and do not use its ports. Run yours under another project name and other ports: `APP_PORT=31080 FAKE_PORT=31081 PG_PORT=55329 TB_PORT=31009 docker compose -p webdev up -d --build --wait` and `docker compose -p webdev down -v` when done (compose reads those variables; `PUBLIC_APP_URL` follows `APP_PORT`). Do not stop any container you did not start.

## Product decisions already made (build this; do not widen it)
- One React app, two routes, one shared in-browser state. The player page is OUR widget as it would sit on a casino's site; the admin page is OUR back office.
- The wheel outcome is decided by the server. The animation only shows the answer. The client sends nothing but "spin this spin".
- The player is identified by a short-lived token signed by the casino. In the demo the fake casino signs it (`POST {fake}/control/token`).
- The existing control panel page stays as it is (it plays the casino: faults, many-player runs, verdict). Link to it; do not rebuild it.

## Files you own (create or edit only these)
- web/** : a Vite + React + TypeScript app with its own package.json and lockfile. Dependencies: react, react-dom, vite, @vitejs/plugin-react, typescript and the React type packages. Nothing else: no router library (two routes: use the URL hash or pathname with a 20-line hook), no state library (one store with `useReducer` + context, or `useSyncExternalStore`), no UI kit, no CSS framework, no icon set, no fonts from the network. Check current versions with `npm view` rather than from memory.
- src/web.ts (new, plain) and src/main.ts: serve the built app from our service at `/app/` (static files from `dist/web`, with a fallback to index.html for `/app/*`), using Nest's Express adapter API (`NestExpressApplication.useStaticAssets` or express static through `app.use`); no new backend dependency. Add `GET /app-config.json` -> `{ fakeCasinoUrl: <env PUBLIC_FAKE_CASINO_URL, default http://localhost:30081> }` so the browser knows where the simulated casino is. If static serving is missing (dist/web absent, as in tests) the service must still start.
- src/config.ts and test/app.ts: only to add `publicFakeCasinoUrl` (env `PUBLIC_FAKE_CASINO_URL`) if you want it in Config; keep every existing field.
- Dockerfile: add a stage that builds web/ and copy its output to dist/web in the final image. package.json (root): scripts `web:install`, `web:build`, `web:typecheck`, and `verify:web` that runs install + typecheck + the web unit tests + build. docker-compose.yml: only env `PUBLIC_FAKE_CASINO_URL: http://localhost:${FAKE_PORT:-30081}` on the app service. .github/workflows/ci.yml: add `npm run verify:web` after `npm run verify`, and after the compose step a `curl -f http://127.0.0.1:30080/app/` check. .gitignore: web/node_modules, web/dist. biome.json only if needed to keep `npm run lint` scoped as it is (src, test).
- test/web.test.ts (root vitest; see Tests), README.md ONLY the "Run it" section (the addresses of the three pages), docs/ai-log.md (append rows).

## Shared state (the point of "one app")
One store for the whole app, used by both routes: selected tenant, the session's players (external id, token, token expiry), the current player, `me` (balance, spins), wheel segments, store items, the session's redemptions with their latest status, admin key per tenant, and the request log. Persist the small durable part (tenant, players, current player, session redemption ids, admin name) to localStorage and sync between tabs with the `storage` event, so `/app/#/play` in one window and `/app/#/admin` in another show the same session. Wrap every localStorage access in try/catch; the app must work without it. Data that the server owns (balance, statuses) is always re-read from the server, never trusted from the store: after every action, and by polling every 2 s while anything is not final (stop polling when all is final or the tab is hidden).
One API client module used by both pages: adds the token, gets a fresh token on 401 and repeats once, records every call in the request log with who -> whom ("player -> us", "admin -> us", "casino -> us" for calls the page asks the fake to make), method, path, status, duration, request and response bodies.

## Player page (`#/play`)
A top strip, visually separate and labelled "Casino side (simulated)": tenant picker (Alpha Casino, platform A / Beta Casino, platform B; from `{fake}/control/config`), player picker (new random player, or one from this session), and a button "Deposit 20.00 at the casino" (`{fake}/control/deposit`; the casino then sends us the signed event). One sentence under it says what just happened in plain words ("The casino told us about the deposit. We gave the player one spin.").
Below it, the widget:
- Balance: available coins, and reserved coins when not zero ("held for a reward that is being issued").
- The wheel: an SVG wheel drawn from `GET /wheel` segments (equal slices; labels readable), a pointer at the top, a "Spin" button showing how many spins are available. On click: POST the oldest available spin; when the answer arrives, rotate with an ease-out for about 4 s so the answered segment stops under the pointer (several full turns plus the target angle; honour `prefers-reduced-motion` by skipping to the result), then show "You won 50 coins" and refresh the balance. If the POST fails, the wheel does not move and an inline message says what happened and that the spin is not lost. The pure function that turns `(segmentCount, segmentIndex, currentRotation)` into the final rotation lives in its own file without React so it can be unit-tested. A small caption: "The result comes from the server. The animation only shows it."
- Store: items with price; "Redeem" is disabled with a reason when coins are short; each click makes a fresh Idempotency-Key. The player's redemptions in this session listed newest first with a status in player words: created/reserved/submitting -> "Being issued by the casino", issued -> "Issued", refused -> "Refused: <reason>. Your coins are back.", insufficient -> "Not enough coins". Platform B stays "Being issued" for about a second (the casino answers by webhook); the list updates by polling.
- States: loading, empty (no spins: "Make a deposit at the casino to get a spin"), error (service unreachable), all handled inline, no alert/confirm/prompt.

## Admin page (`#/admin`)
Tenant picker and an admin key field (prefilled from `{fake}/control/config` `adminKey` for the demo, with a note that this is a demo convenience), admin name field (default "playground"). Sections, each tolerant of 404 with "Not available in this build" (the endpoints are being merged now; their shapes are fixed):
- Alerts: `GET /admin/{tenantId}/alerts` -> `{ at, policyVersion, alerts: [{ code, severity: "warning" | "critical", subject, value, limit, detail }] }`. A clear "No alerts" state. Refresh button and auto-refresh every 10 s while the tab is visible.
- Stuck redemptions: `GET /admin/{tenantId}/redemptions/stuck` -> `{ limitSec, items: [{ id, status, settled, playerExternalId, costCoins, ageSec, platformRef, lastPlatformCall }] }`. Per item: "Resolve as issued" / "Resolve as refused" opening an inline form with a required note (5..500 chars) -> `POST /admin/{tenantId}/redemptions/{id}/resolve` body `{ outcome, note }`; show 409 as "already final". A sentence above the list: "Use this only when the casino cannot tell us the outcome. What to choose is an agreement with the casino."
- Audit trail: a field for an entity id (spin, redemption, player) with quick picks from the session's spins and redemptions -> `GET /admin/{tenantId}/audit?entityId=` -> `[{ id, at, actor, action, entityType, entityId, changes, requestId }]` as a timeline: time, actor, action, and the changed fields as `field: from -> to`.
- Headers for all admin calls: `X-Admin-Key`, `X-Admin-Name`.
- Session players: the players of this session with balance and their redemptions (read with their tokens), so the admin page and the player page visibly show the same state.
- A link "Casino control panel (faults, many-player runs, verdict)" to `{fakeCasinoUrl}/`.
Both pages: a collapsible request log at the bottom fed by the shared store (newest first, max 300, expandable bodies, "copy as curl").

## Design
A tool that looks cared for, not a template. One accent colour, a neutral scale, system font stack, 4 px spacing scale, both light and dark via `prefers-color-scheme` with CSS variables defined once. The wheel is the one place with some life: distinct but harmonious slice colours, a subtle shadow, a satisfying deceleration. No gradients on buttons, no emoji, no glass effects. Visible focus rings, buttons are `<button>`, form fields have labels, status is never colour alone (text too), touch targets at least 36 px, works from 360 px to 1440 px wide (the player page is a widget: it should look right at 390 px). Plain CSS files or CSS modules. Plain English, sentence case, short sentences.

## Tests
- Web unit tests inside web/ with vitest (add it as a dev dependency of web only): the wheel rotation function (the answered segment ends under the pointer for every index and several segment counts; rotation only ever increases; at least 3 full turns), the store reducer (add player, switch tenant, record redemption, log cap of 300), the status-to-player-words mapping, the API client's "401 -> fresh token -> repeat once, and only once" with a stubbed fetch.
- test/web.test.ts in the root suite: the service starts and `/health` works when dist/web is absent; `GET /app-config.json` answers; when a small fake build directory is supplied (make `src/web.ts` take the directory as a parameter so a test can point it at a temp dir with an index.html), `/app/` and `/app/anything` return that index.html and `/app/assets/x.js` returns the asset; API routes are not shadowed by the static handler.
- Real check, required: bring up your compose project (ports above), then drive the built app in headless Chrome. Chrome is installed (find it with `which google-chrome chromium chromium-browser`); the Playwright browser is not; drive Chrome over the DevTools protocol with a small script kept in the scratch area (not committed), as the previous agent did. On BOTH tenants: deposit, spin (wait for the animation, read the result text and the balance), redeem the cheapest item when coins allow (deposit and spin more until they do), see the status reach "Issued", then open `#/admin` in the same session and confirm the same players and redemptions show; check the console for errors; take screenshots at 1280 px and at 390 px, light and dark, of both routes, into the scratch area, and LOOK at them (read the image files) for overlap, clipping, unreadable text and misalignment; fix what you see and re-shoot. Say in the report exactly what was driven in a real browser and what was not.

## Rules
- `npm run verify` (backend) and `npm run verify:web` must both pass before you commit. Never make a test pass with a sleep, a retry or a skip.
- Do not put secrets in the bundle: no demo secret strings in web/ (tokens and the admin key come from the fake casino at run time).
- TypeScript strict in web/. No `any` unless commented why. No dead code, no leftover console.log.
- Commit on your branch when green, in two or three commits (serving and build wiring; the player page; the admin page). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (one React app, two routes, shared state; player page with the wheel as a game; admin page); agent (layout and details)". Write in the row what was driven in a real browser.

## Report back (read by a person who does not read the code; under 40 lines)
Branch and commit hashes; the addresses of the pages; what each page has in a few lines; what was driven in a real browser on which tenant, with the screenshot paths; console errors seen; anything in the backend that looked wrong while you used it like a person (precisely, with ids); what the Docker image size and build time became if you measured them (do not guess); DEVIATIONS; what is not tested.
````

## Follow-up message 1, sent while the agent was working

````text
Change of direction for the PLAYER page, from the owner. He opened the existing plain control panel and could not tell quickly how it works; a demo like that works against him. The player page must look and feel like what a real casino player sees, and must be understood in five seconds by someone who has never seen the project. This overrides the "Design" and "Player page" sections of your brief where they conflict; the admin page, shared store, serving, tests and rules stay as briefed.

Before you write more UI: if you have a Skill tool, load the skills `frontend-design` and `design-taste-frontend` (and `ui-ux-pro-max` if you want a second opinion on palette and type) and follow them for the player page. If you have no Skill tool, apply the direction below.

Player page, new direction:
1. It is a game screen, not a form. Dark, rich, a little theatrical: the wheel is the hero and takes the centre of the screen; a coin balance chip sits at the top; one big primary button under the wheel. Give it a deliberate visual identity (your choice of palette and display type via system or bundled-free means; no network fonts): depth on the wheel (rim, pegs or lights, a real-looking pointer that ticks), a win moment (the prize count rolls up on the balance chip, a short burst of coins or light; respect prefers-reduced-motion), satisfying deceleration. It should look like something a player would want to press.
2. No technical or internal words anywhere a player looks: no "tenant", "platform A/B", "idempotency", "submitting", "settled", "webhook", ids. Player words only: "Spin", "You won 50 coins", "Your coins", "Rewards", "Get it", "On its way", "In your casino account", "Not available right now, your coins are back".
3. Exactly one obvious next action at any moment, and the screen says why:
   - no spins and not enough coins -> the wheel is dimmed with "Deposit to get a spin" and the primary button is "Deposit €20" (styled as the casino's cashier action);
   - a spin is available -> primary button "Spin" (with a count badge if more than one);
   - enough coins for a reward -> the affordable reward card glows and its button is primary.
4. Rewards are cards (name, price in coins, a progress bar toward the price when coins are short), not a table. A redemption shows on its card as a small status: "On its way" with a subtle progress animation, then "In your casino account" or "Not available, your coins are back".
5. Everything that is demo scaffolding moves out of sight into ONE small control in a corner, collapsed by default, labelled "Demo controls": which casino (Alpha / Beta, with one plain sentence on how they differ: "Beta's casino confirms rewards a moment later"), which player (new player / pick from this session), and a link to the admin page and to the casino control panel. Choosing a casino may change the widget's accent so the two are visibly different brands.
6. A "Behind the scenes" panel, closed by default, opened by a quiet button at the bottom or side ("See what happened behind the scenes"). This is what makes the demo work for a technical reviewer: a timeline that narrates each step in one plain sentence as it happens, in order, with a tick: "The casino told us about a €20 deposit", "We checked the casino's signature", "We gave you one spin", "You pressed Spin; the server picked the prize, not your browser", "50 coins were added to your balance in the ledger", "You asked for Bonus €1; we set 100 coins aside", "We asked the casino to issue the bonus", "The casino confirmed; the coins were spent" (and for Beta: "The casino accepted and will confirm in a moment", then the confirmation; for a refusal: "The casino refused; your coins came back"). Each line expands to the real request and response (from the shared request log), with who -> whom. Build the sentences from the actual calls and their answers, never from assumptions: if a call failed, the line says so.
7. First paint must not be empty or confusing: on first open with no player, create a random player automatically and show the dimmed wheel with the deposit call to action. No setup step.
8. Layout: looks right as a phone-sized widget at 390 px and centred with breathing room on a 1280 px screen (the wheel does not grow beyond about 480 px; rewards sit beside it on wide screens, below it on narrow).
The admin page stays a calm working tool (as briefed), but share the type scale and spacing so the two feel like one product; add the same "Behind the scenes" data as its request log.

Checking: when you take the screenshots, judge the player page with this test and say the result honestly in your report: "Would a person who was told nothing know what to press, and after pressing, understand what they got?" Shoot these states at 390 px and 1280 px: first open (no spin), spin available, mid-spin, win shown, reward affordable, reward on its way, reward delivered, Behind the scenes open. Look at each image and fix what is unclear, clipped or ugly before you report.
````

## The agent's report

````text
Branch `worktree-agent-a72a761948fe3adb4`, commits `6054fd7` (serving and `/app-config.json`) and `5f14ae1` (the web app, Dockerfile, CI, README, `docs/ai-log.md`). Nothing pushed or merged. `npm run verify` is green (173 tests, the 6 new ones in `test/web.test.ts`). `npm run verify:web` is green (33 unit tests plus the build).

**Pages** (the stack ran under project `webdev` on its own ports, now removed):
- Player: `http://localhost:30080/app/` (the stack ran on 31080)
- Back office: `http://localhost:30080/app/#/admin`
- The existing control panel is unchanged and linked, on 30081.

**Player page** (rebuilt to the owner's new direction):
- It is a dark game screen with the wheel in the centre and a coin chip at the top. The wheel has a rim, bulbs and a pointer that ticks as slices pass.
- One primary button at any moment, with a line saying why. Without a spin or coins the wheel is dimmed with "Deposit to get a spin" and the button is "Deposit €20". With a spin it is "Spin" with a count badge. With enough coins it is "Get Bonus €1" and the matching reward card glows.
- The prize count rolls up on the chip, a burst of coins plays, and `prefers-reduced-motion` skips all of it.
- Rewards are cards with a progress bar and the statuses "On its way", "In your casino account" and "Not available, your coins are back".
- Demo controls are collapsed in one corner: Alpha or Beta, player pick, links. Alpha is gold and Beta is cyan.
- "See what happened behind the scenes" is a drawer built from the real calls. Each line expands to the request, the response and who called whom. A failed call produces a failure line.

**Back office:** alerts with 10 s auto-refresh, stuck redemptions with resolve, audit timeline, session players, request log (300 max, copy as curl). It shares one store with the player page, saved to localStorage and synced between tabs.

**Real browser** (headless Chrome 146 over DevTools, driving the built app in the compose stack):
- On alpha-casino and beta-casino: first open, deposit, spin with the animation, win text and balance, more deposits and spins until Bonus €1 was affordable, redeem, status to "In your casino account". Beta showed "On its way" first.
- `#/admin` in the same session showed the same player and redemption.
- Screenshots at 1280 and 390 px, read and fixed, are in `<scratch>/final4/` (`alpha-*`, `beta-*`, `-390` and `-1280`). The state is in the file name; admin files carry `-light` for the light scheme.
- The admin sections were also rendered against stubbed responses I injected into the page, shots in `scratchpad/shots2/`.

**Five-second test:** first open passes. Someone told nothing knows to press "Deposit €20", and after Spin sees "You won 50 coins" and the coin chip rolling up. The reward step is clear on a phone after one change I made when I saw the shot: the reward card sat below the fold, so the stage button itself becomes "Get Bonus €1". The deposit-versus-spin choice is the weakest part: after a win the wheel is dimmed again, so the winning slice is no longer the focus. A stranger may not realise that "Deposit €20" stands for the casino's cashier.

**Console errors:** none in the final runs. Earlier runs showed only the 404s from the unmerged admin endpoints.

**Backend while used as a player:**
- Nothing wrong seen. With platform B the redemption ids and states matched `docs/contracts.md`.
- The web build adds about 0.25 MB to the image (242,227,578 to 242,483,310 bytes, compared with the owner's existing local app image, which I assume was built from the same base).
- A cold `docker compose build --no-cache app` took 40 s including the web stage. I did not measure a no-cache build without the web stage.

**Deviations:**
- Two commits, not three. The player and admin pages share `App.tsx`, the store and the CSS, so splitting would leave a commit that does not build.
- `test/app.ts` got an optional `webDir` and a `mountWeb` call, beyond the `publicFakeCasinoUrl` you allowed. Without it the real wiring could not be tested.
- web uses TypeScript 5.9.3, not 7.0.2 (newest on npm). TS 7 is a new major release and I did not want to verify it. I did not try it.
- Request-log actors: calls to the fake casino for the config and tokens are labelled "page -> casino". Deposits are labelled "casino -> us".
- The player page is dark in both OS colour schemes (a game screen). The back office follows `prefers-color-scheme`.

**Not tested:** admin Alerts, Stuck and Audit against the real endpoints (404 in my build, I did not rebuild after the other agent merged). Resolve was checked only to its 409 path. `prefers-reduced-motion` was not driven (code path only). A real `storage` event between two live tabs was not driven. The CI `curl /app/` step has not run on GitHub. Only Chrome was used, not Firefox or Safari.
````
