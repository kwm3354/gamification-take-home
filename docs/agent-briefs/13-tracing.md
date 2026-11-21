# Brief 13: tracing

Wave 6. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
Add distributed tracing with OpenTelemetry to a working NestJS + PostgreSQL + TigerBeetle prototype, so that for any request one can see where its time went. The service is a gamification backend for casino operators (deposit event -> wheel spin -> coins in a ledger -> redemption -> call to the casino platform). It has 231 passing backend tests. You work in your own git worktree on your own branch. Time box: 40 minutes; there is a fallback below if the main route does not work by minute 25.

Others working in parallel; avoid their files: a backend agent is rewriting src/admin/**, src/config.ts (adds one field), src/schema.sql, src/tenants/**, test/app.ts (a few lines), and adds one env line to the `app` service in docker-compose.yml. A measuring agent has untracked files scripts/load.ts and docs/performance.md in the main tree (not in yours). Keep your edits to shared files (src/main.ts, src/config.ts, docker-compose.yml, Dockerfile, package.json, test/app.ts) minimal and local so merges are easy.

## Read first
CLAUDE.md, docs/contracts.md ("Shape", "Logs", "Outbox", "Ledger"), src/main.ts, src/app.module.ts, src/config.ts, src/db.ts and src/db.module.ts, src/ledger/coin-ledger.tigerbeetle.ts and ledger.module.ts, src/integrations/http.ts, src/outbox/outbox.ts, src/logging/* (request-id.ts with its AsyncLocalStorage, log.ts), src/audit/audited.ts (where it reads the request id), Dockerfile, docker-compose.yml, package.json, tsconfig*.json, vitest.config.ts, test/app.ts, test/logging.test.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle     # in every shell that runs tests
npm run verify      # must be green (231 tests) before you change anything
```
After ANY `npm install` run `./scripts/tb-old-cpu.sh` again (with TB_OLDCPU_DIR set as above): the CPU has no AVX2 and the script swaps in a local TigerBeetle client build. The disk is nearly full: install only what is listed, do not leave caches or temp files, do not run `docker compose` on the default ports (the owner's stack is running there and a measurement is in progress: do not disturb it). For a real check use another project and ports: `APP_PORT=32080 FAKE_PORT=32081 PG_PORT=56329 TB_PORT=32009 docker compose -p tracing up -d --build --wait` with a gitignored `docker-compose.override.yml` in your worktree root containing:
```
services:
  tigerbeetle:
    image: tigerbeetle-oldcpu:0.17.9
  app:
    volumes:
      - <local-tigerbeetle-build>/node-client/x86_64-linux-gnu/client.node:/app/node_modules/tigerbeetle-node/dist/bin/x86_64-linux-gnu/client.node:ro
```
and `docker compose -p tracing down -v` when done. Do not stop containers you did not start.

## What to build
Decisions already made: OpenTelemetry; traces only (no OTel metrics, no OTel logs); spans at OUR boundaries, written by hand, so what is traced is exactly what we chose; the trace is tied to the request id that logs and audit rows already carry; tracing is off unless configured, and when it is off it costs nothing and nothing changes.

1. Dependencies (check current versions with `npm view`, do not trust memory): `@opentelemetry/api`, `@opentelemetry/sdk-trace-node` (or `sdk-trace-base` + what is needed for context propagation with AsyncLocalStorage), `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions`. Do NOT use `@opentelemetry/auto-instrumentations-node` or `sdk-node`, and no module-patching instrumentation: the app is native ES modules, where patching needs loader hooks and is a known time sink; manual spans avoid it and keep the Docker start command as it is.
2. `src/tracing/tracing.ts` (plain): `startTracing(config)` sets up the tracer provider with an OTLP/HTTP exporter and a batch processor when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (service name from `OTEL_SERVICE_NAME`, default "gamification"), and returns a shutdown function; when the env is not set it does nothing and `@opentelemetry/api` gives its no-op tracer. `span(name, attributes, fn)` helper: runs `fn` inside an active span, records an exception and sets error status when it throws, always ends the span, returns `fn`'s result (sync or async). In tests an in-memory exporter can be plugged in (a parameter or a setter), so tests can read finished spans.
3. Spans, each with the tenant id when known and never with secrets, tokens, bodies or SQL parameter values:
   - `http <METHOD> <route pattern>` (e.g. `http POST /webhooks/:tenantId/events`): one server span per request, from a Nest interceptor or middleware: attributes `http.request.method`, `http.route`, `http.response.status_code`, `tenant.id`, `request.id`. Continue an incoming W3C `traceparent` header if present. Set the response header `x-trace-id`.
   - `db <operation>`: wrap the pool so every `query` (on the pool and on a checked-out client inside `transaction`) is a span named by the first SQL keyword and, where cheaply known, the table (`db SELECT spins`, `db INSERT audit_log`, `db BEGIN`, `db COMMIT`); attribute `db.statement` = the SQL text WITHOUT parameter values, cut to 200 chars. Also one span `db acquire` around getting a client from the pool: waiting for a free connection is the thing most likely to hide time. Do this in ONE place (src/db.ts) without changing any caller.
   - `ledger <method>` around every public method of the TigerBeetle coin ledger (creditPrize, reserve, capture, release, balance, outstanding), attribute `ledger.result` where there is one ("reserved" / "insufficient").
   - `platform <issue|find> <A|B>` around outgoing calls to the casino platform (src/integrations/http.ts or the adapters), attributes `http.response.status_code` or the error class, and inject `traceparent` into the outgoing request headers.
   - `outbox <kind>` around each job run, as a new root span, linked to nothing, attributes `outbox.attempts`, `outbox.result` (done / retry / dead), `request.id` (the `job:` form).
   - `audit write` is NOT a separate span (it would double the db spans).
4. Tie-in with what exists: put `traceId` into every structured log line when a span is active (in the Log, one place), and into `GET /health`? no. Write the trace id into the audit row? No schema change: instead make sure `request.id` on the span equals the audit/log request id, and document that this is the join key. 
5. Compose: add a `jaeger` service (image `jaegertracing/all-in-one` pinned to a specific current tag you verify exists; OTLP HTTP on 4318 inside the network; UI published on host `${JAEGER_PORT:-30086}:16686`), and set on the `app` service `OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318` and `OTEL_SERVICE_NAME: gamification`. The app must start and work when Jaeger is down (exporter errors are swallowed, at most one warn log line per minute). Do not make `app` depend on jaeger.
6. Graceful shutdown flushes pending spans (hook into the existing shutdown).
7. Docs: a short section "Tracing" in docs/contracts.md (span names, attributes, what is never recorded, how to turn it on, the join with logs and audit by request id) and five lines in README "Run it" (open http://localhost:30086, pick service "gamification", what a redemption trace shows). Only write what you ran.

## Fallback (if by minute 25 the OTel SDK does not work in this ESM + NestJS 12 setup)
Stop, remove the dependencies, and implement the same `span(name, attrs, fn)` helper over AsyncLocalStorage that collects child timings per request and writes ONE structured log line per request at debug level (`request.timing` { route, status, totalMs, parts: [{ name, ms, count }] }, parts aggregated by span name), plus the same for outbox jobs. Keep every span call site the same so OTel can be put behind the helper later. Say clearly in the report that the fallback was taken and why (the exact error).

## Tests (test/tracing.test.ts; whole app over real HTTP with `startApp`, an in-memory span exporter)
1. A deposit request produces one `http POST /webhooks/:tenantId/events` span with children: `db acquire`, `db BEGIN`, inserts, `db COMMIT`; all share one trace id; the response has `x-trace-id` equal to it; `tenant.id` is set.
2. A spin produces `ledger creditPrize` under the request span; a redemption on platform A produces `ledger reserve`, `platform issue A`, `ledger capture`; on platform B the later settle is in an `outbox redemption_advance` root span.
3. An incoming `traceparent` header is continued (same trace id).
4. The outgoing call to the fake casino carries a `traceparent` header whose trace id is the request's (read it from the fake casino's recorded requests if it records headers; if it does not, assert on the span's context instead and say so).
5. Nothing secret in any span: scan all attributes and span names of a full flow on both tenants for every demo secret in src/tenants/demo-tenants.ts, for `Bearer `, for signatures sent, and for SQL parameter values (use a recognisable external player id and assert it appears in NO `db.statement`).
6. A span around a failing call has error status and the exception recorded, and the error still propagates unchanged.
7. Tracing off (the default in tests unless the exporter is plugged in): no spans, no header `x-trace-id`? Decide: keep `x-request-id` always; `x-trace-id` only when tracing is on; test it.
8. Log lines written inside a traced request carry `traceId` equal to the span's.
9. The existing 231 tests stay green with tracing off, and a run of the whole suite with the in-memory exporter turned on globally also passes (run it once by env var and report the result; do not make it the default).
Measure the overhead honestly, once: the same 500 sequential deposit requests with tracing off and with the in-memory exporter on, wall time each, on this machine under background load; report the two numbers and say they are one run, not a benchmark.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation checks (restore each; report which test caught it): (a) record SQL parameter values in `db.statement`; (b) do not end spans on error; (c) drop context propagation into the db wrapper (children become roots).
- Tracing must never change behaviour or throw into business code. No `new Date()` / `Date.now()` in src for business time (OTel's own clock is fine). Imports end in `.ts`; injected classes are plain imports, never `import type`. Plain English comments, short sentences.
- Real check, required: bring up your compose project on the ports above, run one deposit, spin and redemption on each tenant (use the fake casino's control API as docs/samples.md shows), then query Jaeger's HTTP API (`/api/traces?service=gamification&limit=20` on your Jaeger port) and confirm traces with the expected span names exist; paste the span tree of one redemption trace (names and durations) into your report. Then `docker compose -p tracing down -v`.
- Commit on your branch when green, in two commits (the tracing core with the db/ledger/platform/outbox spans and tests; compose, docs). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md: append one row per commit at the end: `| HH:MM | what | who decided | how it was checked |`, time from `date +%H:%M`; "who decided": "Author (take OpenTelemetry to see where time goes); agent (traces only, manual spans at our boundaries, the scope)".

## Report back (read by a person who does not read the code; under 35 lines)
Branch and commit hashes; main route or fallback (and why); the span tree of one real redemption trace with durations; what the trace showed about where time goes in a deposit, a spin and a redemption (facts from the trace, not guesses); the overhead numbers; mutation check results; image size before and after if you measured it; DEVIATIONS; what is not tested.
````

## Follow-up message 1, sent while the agent was working

````text
One addition, small: the owner will run a load test with tracing on and then read Jaeger. Support a sampling ratio so a load run does not flood the exporter or Jaeger's memory: env `OTEL_TRACES_SAMPLE_RATIO` (0..1, default 1), implemented as a parent-based trace-id-ratio sampler (so a sampled request keeps all its child spans and an unsampled one records none). Add one test (ratio 0 records nothing; ratio 1 records everything) and one line in the "Tracing" docs section and in the compose env (default 1). Also say in your report what happens to spans when the exporter cannot keep up (the batch processor's queue limit and that dropped spans are dropped silently or counted), from the SDK's documented behaviour or what you observed.
````

## The agent's report

````text
Tracing is in on branch `worktree-agent-a096193c45999138e`, using the main route (the OpenTelemetry SDK); the fallback was not needed. Commits: `24e740e` (core, spans, tests, sampler) and `77e3556` (compose, docs). `npm run verify` is green with 242 tests (231 old plus 11 new), and the whole suite also passes with the in-memory exporter on globally (`TRACE_ALL_TESTS=1`).

**How it works**
- Packages: api 1.9.1, sdk-trace-node 2.12.1, exporter-trace-otlp-http 0.217.0 (`api@1.10.0` and `sdk-trace-node` conflict on peer dependencies, so I used the older matching set), plus resources and semantic-conventions.
- Spans are written by hand at http, db, ledger, platform and outbox. Everything is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- The http span's `request.id` equals the request id in logs and audit rows, and log lines inside a span also carry `traceId`.
- The db wrapper is in `src/db.ts` and the platform spans are in the platform registry, so no caller changed. The core is in `src/tracing/`.

**Real redemption trace** (compose project `tracing`, Jaeger API; platform A, 79 ms total; `db BEGIN` and `db acquire` rows omitted, each 0.1 to 0.4 ms):
```
http POST /store/redemptions 79.0
  db INSERT redemptions 1.2 / db WITH outbox 1.2 / db INSERT audit_log 0.5 / db COMMIT 4.6
  db SELECT outbox 0.5
  ledger reserve 17.3
  db SELECT/UPDATE redemptions + INSERT audit_log + COMMIT (3.0)
  db SELECT/UPDATE redemptions + INSERT audit_log + COMMIT (2.4)
  platform find A 4.1
  db INSERT audit_log 0.4 / db COMMIT 1.4
  platform issue A 4.9
  db INSERT audit_log 0.5 / db COMMIT 1.7
  db SELECT/UPDATE redemptions + INSERT audit_log + COMMIT (1.8)
  ledger capture 3.4
  db SELECT/UPDATE redemptions + COMMIT (2.0), db INSERT audit_log 0.4, db COMMIT 1.8, db UPDATE outbox 0.8
```
52 spans in all. The tenant-B redemption trace had 45 spans (163 ms).

**Where time goes (one real run each, small samples):**
- **Deposit (15 ms):** every query takes 0.4 to 1.2 ms. The final `db COMMIT` is the largest single piece at 5.6 ms.
- **Spin (31.5 ms):** `ledger creditPrize` is 8.6 ms and the rest is about 14 short queries and commits.
- **Redemption on A (79 ms):** `ledger reserve` is the largest piece at 17 ms (3.4 ms for capture). The platform calls take 4 to 5 ms each, and the many separate commits add up.
- **Redemption on B (163 ms):** `platform find B` is 38 ms and `platform issue B` is 15 ms. The two calls make up about a third of the request.
- `db acquire` was 0.1 ms. I saw no pool waiting in these single-user runs.

**Overhead:** 500 sequential deposits took 6029 ms and 5537 ms with tracing off, and 7096 ms and 6850 ms with it on (about 12 ms per request versus 14 ms). That is two runs each on a loaded machine, not a benchmark.

**Mutation checks**
- (a) Recording SQL parameter values in `db.statement` was caught by test 5 (nothing secret).
- (b) Not ending spans on error was caught by test 6 (failing span).
- (c) Making db spans roots was caught by tests 1 and 9.

**Sampling:** `OTEL_TRACES_SAMPLE_RATIO` (0 to 1, default 1) uses a parent-based ratio sampler, so a sampled request keeps all its spans. Test 9 checks that ratio 0 records nothing and ratio 1 records everything. It is documented and set in compose with default 1.

**When the exporter cannot keep up** (from the SDK source, `BatchSpanProcessorBase`, not observed under load):
- Spans wait in a queue of 2048, are sent every 5 s in batches of 512, and the export times out after 30 s.
- When the queue is full, new spans are dropped and counted. The count is reported once through the SDK's diagnostic channel, which is silent by default. I route that one "Dropped N spans" line to stderr.
- Jaeger itself keeps at most 10000 traces in memory (`MEMORY_MAX_TRACES`).

**Jaeger down:** I stopped Jaeger and `/health` kept returning 200. The app logged `tracing: export failed: getaddrinfo ENOTFOUND jaeger` once. `app` does not depend on `jaeger`.

**Image size:** 243 MB for the existing image against 274 MB for the new build. That is not a clean comparison, because the old image was built at an earlier commit.

**Deviations**
- `config.ts` is untouched; tracing reads its own env in `src/tracing/tracing.ts`.
- `app.module.ts` and `main.ts` are edited minimally.
- A vitest setup file `test/tracing-setup.ts` is wired in `vitest.config.ts` for the global exporter run; `test/app.ts` is untouched.
- Jaeger is 1.76.0, taken from the Docker Hub tag list.
- The outbox claim (BEGIN, SELECT) and the outcome UPDATE are outside the `outbox` span, so idle timer ticks leave no traces. Every job that actually runs gets a root trace, including trivial `spin_credit` ones.
- A span that is not an http or outbox span is created only when a span is already running.
- `x-trace-id` is sent only when tracing is on, and `x-request-id` always.
- I started the Jaeger container on its default host port, 30086, instead of a custom one. It had no conflict and was removed with `down -v`.

**Not tested:** behaviour under real load or queue overflow, the Jaeger UI in a browser, and platform B's `outbox` span against the real fake casino (covered through a forwarding proxy in the tests). The test for the outgoing `traceparent` uses that recording proxy, because the fake casino does not record headers. One `GET /health` test failed once in a full run, and passed 3 of 3 reruns and in the following full run. I did not investigate it.
````
