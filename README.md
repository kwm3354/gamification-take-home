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

Then open http://localhost:30081/ in a browser. It is a playground page that plays the casino
and the player, can inject faults and shows a verdict. Sample requests are in `docs/samples.md`.

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
