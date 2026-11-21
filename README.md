# (title once the task is known)

> Skeleton. Fill in during the last hour; delete this line.

## The task in my own words

## What is here

## Run it

Needs Docker with Compose. Start PostgreSQL, TigerBeetle and the app, then ask the app if it is healthy:

```
docker compose up -d --build --wait
curl http://127.0.0.1:30080/health
```

The answer is `{"ok":true,"postgres":"ok","ledger":"ok"}`.

Then open three pages in a browser:

- http://localhost:30080/app/ is the player page: a Wheel of Fortune you can spin, your coins and the
  reward store, as it would sit on a casino's site. "See what happened behind the scenes" at the
  bottom tells the story of each step in plain sentences and shows the real requests.
- http://localhost:30080/app/#/admin is the back office. It needs a sign-in. The sign-in page lists the
  demo users as buttons that fill the form. It reads everything from the server: overview, alerts,
  redemptions (with the manual resolution of a stuck one), players, events, spins, settings (with a
  proposal for a new wheel), waiting changes for the platform admin, outbox and audit. The player page
  and the back office are one app with two routes and share no state.
- http://localhost:30081/ is the casino control panel. It plays the casino, can inject faults, runs
  many players and shows a verdict.

Sample requests are in `docs/samples.md`.

To look at the screens without the stack: `npm run web:build`, then `node web/dev/mock-server.mjs` and open
http://localhost:4800/app/. The mock is a development aid built from `docs/contracts.md`, not the service.

Stop and delete the data:

```
docker compose down -v
```

Run the checks (typecheck, lint, tests). Needs Node.js 22. The tests start their own PostgreSQL
in Docker and use the TigerBeetle from Compose:

```
npm ci
docker compose up -d --wait tigerbeetle
TB_ADDRESS=127.0.0.1:30009 npm run verify
```

The web app (`web/`) is built in the app image. To check it on its own: `npm run verify:web`
(installs, type-checks, runs its unit tests and builds).

These commands are the ones CI runs on every push (`.github/workflows/ci.yml`), on a GitHub
runner with the official images.

The TigerBeetle server and its Node.js client need a CPU with AVX2 and Docker that allows
io_uring (hence `seccomp=unconfined` in `docker-compose.yml`). On a CPU without AVX2 see
`scripts/tb-old-cpu.sh`.

## Design

See `docs/`.

## What is real, what is fake, what is not built

## Priorities: what I chose to do in the time, and why

## Assumptions I made where the task did not say

## How it is verified

See `docs/verification.md`.

## How this was made
