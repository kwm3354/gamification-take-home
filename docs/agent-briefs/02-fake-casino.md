# Brief 02: fake casino

Wave 1. Given to a coding agent (model `claude-sonnet-5-5`) working on its own git branch. The text is what the agent received; local paths are replaced with placeholders.

## The brief

````text
You build the fake outside world of a prototype: one small process that plays two different casino platforms, can be told to fail in precise ways, and exposes its state so tests can judge our service by what the casino saw. You work in your own git worktree on your own branch. Two other agents work in parallel on other files; the real service that talks to your fake does not exist yet, so your tests use a stub receiver.

## Read first
CLAUDE.md, docs/verification.md (why the fake exists and why "lost answer" matters), docs/contracts.md (binding; sections "Platform A", "Platform B", "Fake casino", and "Our HTTP API" for the webhook paths and the player token), src/tenants/demo-tenants.ts, docker-compose.yml, Dockerfile, package.json, tsconfig.build.json, test/app.ts.

## Machine setup (first, exactly)
```
npm ci
TB_OLDCPU_DIR=<local-tigerbeetle-build> ./scripts/tb-old-cpu.sh
export TB_BIN=<local-tigerbeetle-build>/tigerbeetle
npm run verify      # must be green before you change anything
```
(The CPU has no AVX2; the script swaps in a local TigerBeetle build so the existing tests run. Your own code does not use TigerBeetle.) Docker is running. Do not stop containers you did not start.

## Files you own (create or edit only these)
- src/fake-casino/** : `main.ts` (process entry: reads PORT default 4000 and APP_URL default `http://app:3000`, starts the server), `server.ts` (exports `startFakeCasino(options: { port?: number; appUrl?: string; autoDeliverMs?: number | null }): Promise<{ url: string; state: () => FakeState; close: () => Promise<void> }>`), and whatever small files you need (state, platform-a, platform-b, faults, signing). Plain `node:http` and `node:crypto` only; no framework; no imports from the rest of src except `../tenants/demo-tenants.ts`.
- test/fake.ts (helper that starts the fake in-process on a random port, for other test files), test/fake-casino.test.ts.
- docker-compose.yml: add a service `fake-casino` (same image as `app` via `build: .`, `command: ["node", "dist/fake-casino/main.js"]`, env PORT=4000 and APP_URL=http://app:3000, host port 30081:4000, a healthcheck on `GET /control/state`); add to the `app` service the env `SEED_DEMO: "1"` and `FAKE_CASINO_URL: http://fake-casino:4000`. Do not make `app` depend on the fake. Leave the postgres and tigerbeetle services exactly as they are, including comments.
- docs/ai-log.md: append ONE row at the end (see Rules).
Do not edit docs/contracts.md, src/schema.sql, src/domain/**, src/tenants/**, package.json, the Dockerfile (check that `npm run build` already compiles src/fake-casino into dist; it should, since it is under src), or anything else. No new npm dependencies. If the contract is wrong or incomplete, do not edit it: pick the smallest sensible reading, and list it under DEVIATIONS in your report.

## Behaviour (the contract is binding; these are the details it leaves open)
- Tenants: the fake knows the demo tenants from `demoTenants`. A request for a platform API is matched to a tenant by its key: `Authorization: Bearer <platformKey>` on /a/..., `X-Api-Key: <platformKey>` on /b/... . Unknown key -> 401. A tenant on platform A calling /b/... (or the reverse) -> 404.
- Platform A: `POST /a/bonuses` requires `Idempotency-Key`; the first call with a key creates a grant `{ bonus_id, status: "granted" }` and stores the response; any later call with the same key returns the stored response and creates nothing. `GET /a/bonuses?reference=` returns the grant by `reference`, 404 if none.
- Platform B: `POST /b/v2/rewards/grant` ALWAYS creates a new request, even for an `externalRef` it has seen (that is the trap). A request starts as ACCEPTED and holds a planned final state (GRANTED unless a `refuse` fault says DECLINED). A callback is queued for it. `POST /control/b/deliver` delivers every queued callback now: it sets the request to its final state, records a grant if GRANTED, and POSTs the signed notice to `{appUrl}/webhooks/{tenantId}/rewards`; it returns what was delivered and our answers. With `autoDeliverMs` set (main.ts uses 1000) a timer delivers automatically; tests pass `null` and deliver by hand. `GET /b/v2/rewards/requests?externalRef=` lists all requests with that ref.
- "Grant" in the state means: the casino really gave the player the reward. For A that is at the successful POST; for B at delivery time when the state becomes GRANTED (so a GRANTED request is a grant even if the callback to us was lost).
- Faults at `a.grant`, `b.grant`: `error_500` (500, nothing done), `rate_limit` (429 + `Retry-After: 1`, nothing done), `refuse` (A: 422 `{ "error": "player_blocked" }`, recorded as a rejected attempt findable by reference with status "rejected"; B: accepted, final state DECLINED with reason "player_blocked"), `lost_request` (destroy the socket, nothing done), `lost_answer` (do the work fully, then destroy the socket without answering), `slow_answer` (do the work, answer after `delayMs`, default 5000; the timer must not keep the process or a test alive: unref it and clear it on close).
- Faults at `a.find`, `b.find`: `error_500`, `rate_limit`, `lost_request`, `slow_answer`.
- Faults at `b.callback`: `lost` (state becomes final, nothing is sent), `twice` (sent two times), `delay` (stays queued; skipped by this deliver call, delivered by the next).
- Scripted faults: `POST /control/faults { point, fault, times = 1, delayMs?, tenantId? }` queues them; each matching call consumes one. `GET /control/faults` shows what is queued.
- Chaos: `POST /control/chaos { seed, rates }` uses a small seeded generator (e.g. mulberry32; no Math.random) so the same seed and the same sequence of calls gives the same faults. Scripted faults win over chaos. `{ seed: null }` or `/control/reset` turns it off.
- `POST /control/deposit { tenantId, playerId, amount, currency = "EUR", eventId?, repeat = 1, tamper?, ourUrl? }`: builds the event in the tenant's platform format (`amount` is a decimal string in major units like "20.00": A sends `amount_minor` 2000, B sends `"20.00"`), signs it with the tenant's `webhookSecret` as the contract says (A: header timestamp = current unix seconds; B: base64 HMAC), POSTs it to `{ourUrl or appUrl}/webhooks/{tenantId}/events` `repeat` times, and returns `{ eventId, sent: [{ status, body }] }`. `tamper: "signature"` flips the signature; `tamper: "stale"` (A only) uses a timestamp one hour old; `tamper: "failed"` sends a non-successful deposit (A: type `deposit.failed`; B: state `FAILED`). The exact bytes signed must be the exact bytes sent.
- `POST /control/token { tenantId, playerId, ttlSeconds = 600, tamper? }` returns `{ token }`: a JWT, HS256, made with node:crypto (base64url header.payload.signature), claims `iss`, `sub`, `iat`, `exp`, signed with the tenant's `tokenSecret`. `tamper: "signature"` signs with a wrong secret; `tamper: "expired"` sets exp in the past.
- `GET /control/state` returns `{ grants: [{ tenantId, platform, playerId, reference, amountMinor, currency, platformRef, at }], requests: [{ tenantId, point, reference, at, fault }], callbacks: [...] }`. `reference` is our redemption id. `requests` logs every platform API call received, with the fault applied if any.
- CORS: answer every request with `Access-Control-Allow-Origin: *` and handle OPTIONS, because a browser page will call the control API later. Leave a clear place where a static page can be served from `src/fake-casino/public/` at `GET /` (a later agent adds the page; return 404 "no page yet" for now, and note in your report that the build script copies only .ts and schema.sql to dist).
- Invalid JSON or missing fields -> 400 with a short message. The server must never crash on bad input.

## Tests (test/fake-casino.test.ts) - real HTTP against the in-process fake, plus a stub receiver
Start a tiny `node:http` stub in the test that records what it receives (headers and raw body) and answers 200, and pass its address as appUrl. Cover at least:
1. A: grant, then the same Idempotency-Key again -> same bonus_id, one grant in state. Find by reference works; unknown reference 404.
2. B: grant -> 202 ACCEPTED, no grant in state yet; deliver -> state GRANTED, one grant, the stub received a notice whose `X-Beta-Auth` the test verifies by computing the HMAC ITSELF over the raw body it received (do not import the fake's signing code into the test).
3. B: two grant calls with the same externalRef -> two requests and, after deliver, two grants (the trap exists).
4. Each fault at a.grant: error_500 and rate_limit and lost_request leave no grant; lost_answer leaves a grant AND the client call rejects (fetch throws); slow_answer with delayMs 50 leaves a grant and answers; refuse gives 422 and find reports rejected.
5. `times: 2` applies to exactly two calls.
6. b.callback faults: lost (final state, nothing received), twice (two received), delay (delivered by the second deliver call).
7. /control/deposit for A and for B: the stub receives a body in the right format and a signature the test verifies independently (A: hex HMAC of `timestamp + "." + rawBody`); `repeat: 3` sends the identical bytes three times; `tamper: "signature"` fails that verification.
8. /control/token: the test verifies the JWT signature and claims itself with node:crypto; tamper variants are wrong in the stated way.
9. Chaos: the same seed and the same 30 calls give the same sequence of outcomes twice; a different seed gives a different one.
10. Wrong key -> 401; bad JSON -> 400; reset empties the state.
No test sleeps longer than a few tens of milliseconds, and only where slow_answer needs it.

Also check the compose service for real: with a local override file this machine needs (create a gitignored `docker-compose.override.yml` if it is absent: it must switch the tigerbeetle image to `tigerbeetle-oldcpu:0.17.9` and bind-mount `<local-tigerbeetle-build>/node-client/x86_64-linux-gnu/client.node` over `/app/node_modules/tigerbeetle-node/dist/bin/x86_64-linux-gnu/client.node` in the `app` service; `.gitignore` already lists it), run `docker compose -p fakecheck up -d --build --wait fake-casino` then `curl http://127.0.0.1:30081/control/state`, then `docker compose -p fakecheck down -v`. If host port 30081 is busy, say so and pick another. Report the actual output.

## Rules
- `npm run verify` must pass before you commit. Never make a test pass with a long sleep, a retry or a skip. `npx biome check --write src test` fixes formatting.
- Mutation check before you finish: (a) make `lost_answer` skip the work, confirm a test fails, restore; (b) make platform A ignore the Idempotency-Key, confirm a test fails, restore. If a mutation is not caught, fix the tests.
- Imports use `.ts` extensions. Plain English comments, short sentences. The fake may use `Date.now()` (it is the outside world), but take time through one small function so it is easy to find.
- Commit on your branch when green (one or two commits). Message: what changed and how it was checked; no tool names, no attribution or co-author lines. Do NOT push, do NOT merge, do NOT switch branches.
- docs/ai-log.md row appended at the end, same commit: `| HH:MM | what | Agent | how it was checked |`, time from `date +%H:%M`.

## Report back (read by a person who does not read the code; under 40 lines)
Branch and commit hash; what the fake does in five lines; the list of assumptions the fake makes that a real casino platform might not honour (be honest and specific: this goes into the README); results of the two mutation checks; the compose check output; DEVIATIONS from the contract or "none"; what is not tested.
````

## The agent's report

````text
Branch `worktree-agent-a4d066cf6c7820680`, commit `cc70507`. `npm run verify` is green (30 tests, 27 of them new).

**What the fake does**
- One `node:http` process plays platform A and platform B for the two demo tenants. It picks the tenant from the API key: 401 for an unknown key, 404 for the wrong platform.
- A is idempotent by `Idempotency-Key`. B always creates a new request, even for a repeated `externalRef`, and reports the result only when `/control/b/deliver` runs (or on the timer).
- Scripted faults (`times`, `delayMs`, `tenantId`) and seeded chaos (mulberry32) cover all the points in the brief. Scripted faults win over chaos.
- `/control/deposit` and `/control/token` build signed events and JWTs, including the `tamper` variants.
- `/control/state` shows grants, every request received (with the fault applied) and the callbacks. It has CORS and OPTIONS handling. Bad input returns 400 and never crashes the server.
- `GET /` serves `src/fake-casino/public/index.html` if it exists, otherwise 404 "no page yet".

**Assumptions the fake makes that a real casino platform might not honour (for the README)**
1. B's lookup shows a request as soon as the grant call was accepted. A real platform may lag.
2. A's idempotency key is kept forever and answers exactly like the first call. Real platforms often expire keys or answer differently on a repeat.
3. B's callbacks are signed the same way as its deposit events. B has no retry on our 5xx; each callback is sent once, or twice with the `twice` fault.
4. Both platforms apply the grant atomically and never half-apply it. A "grant" is one row, with no partial amounts or currency conversion.
5. A refusal is a deterministic `player_blocked`. Other refusal reasons, such as limits or KYC, are not modelled.
6. State lives in memory and is lost on restart. Delivery order is first in, first out except under `delay`, so the fake does not reorder messages.
7. The fake never validates our requests beyond required fields, and it has no rate limiting except where a fault asks for it.
8. The player token is a bare HS256 JWT with `iss`, `sub`, `iat` and `exp`. Nothing else is modelled.

**Mutation checks**
- (a) `lost_answer` without the work: `lost_answer does the work and the client call fails` failed. Restored.
- (b) Platform A ignoring the idempotency key: `grants once per Idempotency-Key and finds the grant by reference` failed. Restored.

**Compose check**
Host port 30081 was free. I created the gitignored `docker-compose.override.yml`. Then `docker compose -p fakecheck up -d --build --wait fake-casino` built the image and the container reached Healthy. `curl http://127.0.0.1:30081/control/state` returned `200 OK` with `Access-Control-Allow-Origin: *` and body `{"grants":[],"requests":[],"callbacks":[]}`. `docker compose -p fakecheck down -v` cleaned up. `npm run build` compiles `src/fake-casino` into `dist`. The build script copies only `.ts` output and `schema.sql`, so a `public/` page would not reach the image without a Dockerfile or script change.

**DEVIATIONS from the contract**
- `/control/deposit` has no `platform` field. The platform comes from the tenant, as the brief said.
- `/control/b/deliver` returns `{ delivered: [{ tenantId, requestId, state, outcome: "lost" | "sent", answers: [{ status, body }] }] }`. The contract did not give a shape.
- If our app is unreachable, `sent` and `answers` entries show `status: 0` with the error text.
- In the state output, `at` is an ISO string.
- A B callback marked `delay` that never gets delivered leaves the request in ACCEPTED, so no grant is recorded.

**Not tested**
- The auto-delivery timer (`autoDeliverMs`) and `main.ts`. The container only proved that `/control/state` answers.
- `slow_answer` with the default 5000 ms delay and the timer cleanup on `close` (only 50 ms was run).
- Body-size limit (413), concurrent `deliver` calls, and the `GET /` page when `public/index.html` exists.
- Webhooks against the real app. Only a stub receiver was used.

I added `docs/ai-log.md` row 11:55. Files are under `src/fake-casino/`, plus `test/fake.ts`, `test/fake-casino.test.ts` and `docker-compose.yml`.
````
