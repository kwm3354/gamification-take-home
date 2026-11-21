# Performance measurement

Every number below comes from a run made on 2026-11-21. Nothing is estimated. Where something was
not measured, the text says "not measured".

## 1. What was measured, and what was not

- Throughput and latency of the HTTP API of the running docker compose stack, for nine load shapes
  (section 2), at concurrency 1, 8, 32 and 64, each run at least twice.
- Where the time goes, correctness after the load, table growth.
- Not measured: a real network, TLS, a second app process, a bigger pool, a message broker, a
  PostgreSQL or TigerBeetle outage, a production-grade TigerBeetle build.
- Code: commit `a1805f1` (working tree at the time; the containers were built about 45 minutes
  before the runs, I did not check they match this commit). Machine: Intel Xeon E5-2670, 16
  logical CPUs, 32 GB RAM, Linux.
- **Under background load.** Other work (tests, other agents) ran on the same machine during all
  runs. Load average was 5.3 / 5.6 / 6.5 before the first run and 6.4 / 7.7 / 9.3 after the last.
  The one-minute load seen at the start of single runs ranged from 5.6 to 20.8. Treat every number
  as "under background load". Runs of the same configuration differ by up to 30 %.
- Shape: one NestJS process, one PostgreSQL 16, one TigerBeetle 0.17.9, one fake casino, all in
  docker on one host. The load client runs on the same host.

## 2. Results

Columns: concurrency; requests per second for each run; p50 and p99 latency in ms for each run;
errors. "n" is the number of measured requests per run (after an unmeasured warm-up of 10 %, at
least 50). Concurrency 1 used n = 500 for scenarios that otherwise use 2000 (to save time).
Errors were **0** in every run of every scenario (no 4xx, no 5xx, no timeouts, no connection errors).
A third run was made when two runs differed by more than about 20 %; it is shown as a third value.

### deposit (platform A, one new event for one new player per request)

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 76.8 / 79.0 | 11.9 / 11.7 | 21.4 / 20.8 |
| 8 | 315.8 / 305.6 | 24.5 / 24.1 | 40.5 / 67.4 |
| 32 | 302.3 / 323.8 | 100.1 / 96.7 | 179.3 / 187.2 |
| 64 | 300.3 / 294.0 | 206.8 / 193.1 | 303.0 / 482.1 |

### deposit-b (platform B, 10 transactions per request; one request = 10 deposits)

| c | req/s (txn/s) | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 11.1 (110) / 10.1 (101) | 87.5 / 92.8 | 147 / 173 |
| 8 | 44.2 (442) / 33.7 (337) / 42.5 (425) | 171.8 / 200.6 / 181.3 | 307 / 480 / 343 |
| 32 | 33.6 (336) / 33.8 (338) | 838.8 / 782.9 | 1496 / 1831 |
| 64 | 36.9 (369) / 42.9 (429) | 1454 / 1465 | 3338 / 1704 |

### duplicate (the same event sent again; the dedup path)

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 193.5 / 184.3 | 4.8 / 5.3 | 11.0 / 8.1 |
| 8 | 323.2 / 431.1 / 578.0 | 22.1 / 17.5 / 13.4 | 58.1 / 36.2 / 20.5 |
| 32 | 523.7 / 366.9 / 556.4 | 58.2 / 80.5 / 56.6 | 99.7 / 237.3 / 74.7 |
| 64 | 496.2 / 509.0 | 127.2 / 112.4 | 221.5 / 278.4 |

### wheel (`GET /wheel`; PostgreSQL only, but with the player-token check)

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 217.1 / 230.1 | 4.4 / 4.3 | 8.2 / 8.1 |
| 8 | 583.2 / 596.6 | 13.2 / 12.9 | 25.4 / 22.1 |
| 32 | 644.1 / 610.0 | 48.1 / 51.9 | 73.1 / 69.5 |
| 64 | 474.8 / 642.7 / 586.8 | 133.2 / 97.0 / 106.1 | 180.5 / 130.3 / 143.8 |

### me (`GET /me`; PostgreSQL plus a TigerBeetle balance lookup; 200 prepared players)

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 94.5 / 82.9 | 9.7 / 9.2 | 23.1 / 54.2 |
| 8 | 434.1 / 353.3 / 395.1 | 16.8 / 20.0 / 17.6 | 37.9 / 83.3 / 77.6 |
| 32 | 587.4 / 482.6 / 632.1 | 54.2 / 64.5 / 50.4 | 77.4 / 108.5 / 65.3 |
| 64 | 614.5 / 586.1 | 98.7 / 104.6 | 181.0 / 167.3 |

### spin (`POST /wheel/spins/:id/spin`; includes the TigerBeetle credit; each spin used once)

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 31.4 / 31.0 | 28.8 / 31.0 | 112.4 / 62.6 |
| 8 | 135.7 / 106.8 / 135.2 | 52.8 / 68.1 / 54.6 | 188.7 / 169.5 / 219.9 |
| 32 | 143.8 / 184.3 / 181.3 | 209.7 / 170.7 / 170.4 | 446.8 / 249.9 / 387.3 |
| 64 | 186.6 / 178.7 | 321.8 / 320.7 | 596.1 / 614.1 |

### redeem-a (`POST /store/redemptions`, platform A; n = 500; reserve, call the casino, capture; answer is "issued")

| c | req/s | p50 ms | p99 ms |
|---|---|---|---|
| 1 | 13.5 / 11.6 | 70.3 / 79.1 | 197 / 184 |
| 8 | 30.4 / 28.7 | 254.2 / 255.4 | 631 / 746 |
| 32 | 27.9 / 31.3 | 1030 / 992 | 1971 / 1428 |
| 64 | 26.9 / 31.8 | 2229 / 1823 | 3059 / 2621 |

### redeem-b (platform B; n = 500; the POST answers "submitting"; final after a webhook)

| c | req/s | p50 ms | p99 ms | ms from the last POST to the last redemption final (run 1 / run 2) |
|---|---|---|---|---|
| 1 | 15.6 / 16.5 | 58.8 / 57.3 | 190 / 140 | 1826 / 1175 |
| 8 | 30.6 / 23.6 / 29.0 | 242.9 / 304.5 / 244.6 | 534 / 715 / 872 | 33626 / 34859 (third run: not recorded in this table) |
| 32 | 29.5 / 33.1 | 970 / 917 | 1722 / 1473 | 38417 / 36337 |
| 64 | 33.2 / 32.0 | 1799 / 1924 | 2636 / 2466 | 42111 / 39244 |

All 500 redemptions of every run reached `issued` with `settled_at` set. The script polls
`GET /store/redemptions/:id` only after the POST phase ends, so only the last column is a valid
time-to-final; the per-redemption start-to-final values in the raw JSON are inflated by that and are
not used here.

### mixed (one virtual player per slot, a loop of deposit, me, spin, me, redeem when coins >= 100; platform A; 300 cycles per run, after 2 warm-up cycles per player)

Cycles per second, then per-call p50 / p99 in ms. Two runs each.

| c | cycles/s | deposit | me | spin | redeem |
|---|---|---|---|---|---|
| 1 | 10.0 / 9.3 | 11.1 / 19 | 10.3 / 20 | 27 / 93 | 65 / 194 |
| 8 | 32.2 / 31.5 | 17.6 / 38 | 24.1 / 87 | 65 / 281 | 191 / 400 |
| 32 | 33.2 / 34.2 | 23.8 / 119 | 32.6 / 118 | 85 / 226 | 1482 / 2024 |
| 64 | 33.5 / 37.6 | 34.2 / 248 | 43.6 / 225 | 103 / 343 | 2922 / 3882 |

(The per-call cells show the first run; the second run is in the same range. Cycle p50 at c = 32 was
455 / 412 ms and p99 2119 / 2367 ms.) Redeem is the slowest call: p50 1482 ms at c = 32 against 85 ms for spin.

## 3. Where the time goes

Evidence is from `docker stats` and `pg_stat_activity` sampled every 2 seconds during each run, from
the code, and from `EXPLAIN (ANALYZE, BUFFERS)` after the runs. CPU is "percent of one core"; a
single Node process can use about one core for JavaScript.

- **Pool size.** `src/db.ts` makes the pool with `max = 5` and `src/db.module.ts` does not pass
  another value. Concurrency 8 already gives the best throughput for deposit (about 310 req/s);
  32 and 64 add only waiting time (p50 100 ms and 200 ms). PostgreSQL never held more than about 6
  of its 100 allowed connections (`pg_stat_activity`).
- **deposit.** About 300 req/s, flat from c = 8. During the c = 32 and c = 64 runs the app container
  showed up to 98-112 % CPU and PostgreSQL 131-143 %. So the single Node process is close to one
  full core and PostgreSQL is also busy. The waits seen in PostgreSQL were `WALSync`
  and `LWLock WALWrite` (the log write; 39 + 22 + 9 + 9 of the sampled lines at one to four
  sessions), and no waits of type `Lock` (no row-lock waiting) in any sample. The SQL is not slow:
  `EXPLAIN ANALYZE` of the player, spin-list, outbox-claim and tenant queries all ran in
  0.13-0.45 ms with index scans. The cost is the number of statements and rows per deposit
  (section 6), not one bad query. The duplicate path (no inserts except a failed unique insert)
  reaches 500 req/s; a new deposit reaches 300: the writes cost the difference.
- **deposit-b.** 337-442 events per second (10 events per request). PostgreSQL reached 196 % CPU
  and the app 98 %. The controller handles the 10 events of a batch one after the other, each in
  its own transaction (`src/events/events.controller.ts`). So a batch is only 1.1x-1.4x faster per
  event than single events; the saving is in HTTP and signature work, not in PostgreSQL work.
- **wheel and me.** The read path stops at about 600 req/s at c >= 32 with the app at 98-124 % CPU
  and PostgreSQL at 33-87 %. The app is the limit here. Every player call first runs the token check,
  a tenant lookup and a transaction with a player lookup (`src/tenants/player-auth.guard.ts`).
  **The ledger read is cheap**: `/me` (with the TigerBeetle lookup and the spin list) reached 587 /
  483 / 632 req/s at c = 32 against 644 / 610 for `/wheel`, which is inside the run-to-run spread. At
  c = 1 `/me` took 9.7 ms against 4.4 ms for `/wheel`, so the lookup plus the spin query is about
  5 ms of latency but not a throughput limit. TigerBeetle's container used at most 5-9 % CPU in these runs.
- **spin.** About 107-186 req/s. At c = 1 a spin takes 29 ms against 4.4 ms for `/wheel`. A spin is a
  transaction (update spin, audit row, outbox row), then a TigerBeetle transfer, then another
  transaction (credited_at, audit row), plus the lookups. App 110-124 %, PostgreSQL 118-121 %,
  TigerBeetle 4-7 % CPU. The time spent inside the TigerBeetle write call was not measured on its
  own. TigerBeetle is probably slower here than an official build, because this one is a custom
  build for a CPU without AVX2 with a development data file; I cannot measure the difference.
- **redeem-a and redeem-b.** The clearest limit: **about 30 req/s at any concurrency from 8 to 64**
  while p50 grows in step with concurrency (255 ms at c = 8, about 1000 ms at c = 32, 1800-2200 ms at
  c = 64). That is a queue in front of a fixed number of workers. In `src/store/store.service.ts`
  `slots: new Slots(2)`: at most 2 redemptions run their inline step at the same time. Each one
  holds a database transaction (the outbox row lock, `src/store/redemption.ts` `runInline`) and a
  pool connection for the whole step, including the HTTP call to the casino and the
  TigerBeetle calls. `pg_stat_activity` showed `idle in transaction / ClientRead` sessions
  (2 at the same time in the redeem runs). One redemption alone takes about 58-70 ms (c = 1 p50), and
  2 slots / 0.066 s is about 30 per second, which is what was measured. CPU was not the limit:
  app up to 111-120 %, PostgreSQL 118-121 %, TigerBeetle 10-13 %.
- **redeem-b time to final.** At c = 1 the last redemption was final 1.2-1.8 s after the last POST,
  as expected from the fake casino's 1-second callback timer. At c >= 8 it took **34-42 s**. The 500
  redemptions were finalized at about 9-10 per second (500 in 50-57 s from the first request). The
  fake casino sends the callbacks one at a time (`deliverAll` in `src/fake-casino/platform-b.ts`
  awaits each POST), so a single sender is part of this limit. Whether the callback handling in the
  app or the one-at-a-time sender sets the rate: not measured.
- **mixed.** Plateau at about 33 cycles/s from c = 8 on; one cycle contains one redeem (about half
  the cycles reach 100 coins), so the redeem limit above sets the plateau. Beyond c = 8 only the
  waiting grows (cycle p99 580 ms at c = 8, 2.1-2.4 s at c = 32, 4.0-4.2 s at c = 64).
- **Outbox timer (every 500 ms).** Nothing in these runs waited for it: on both platforms the
  inline step ran in the request and every outbox job finished. Pending jobs after all runs: 0.
  The outbox claim query uses the partial index `outbox_due` (index scan, 0.3 ms). The done rows are
  never removed: 69 126 rows, 16 MB after the runs.
- **Node and logging.** The app writes one JSON log line per accepted event at level info (322 255
  info lines after the runs). The cost of this was not measured.
- **Keep-alive.** Node's global `fetch` reuses connections. I checked with
  `ss -tn state established '( dport = :30080 )'` during a c = 8 run: 13 connections for 1000
  requests, not 1000.

## 4. Correctness under load (after all runs, from the outside, read-only)

| Check | Result | Pass |
|---|---|---|
| (a) Grants in the fake casino vs redemptions `issued` in PostgreSQL | alpha-casino 5735 vs 5735; beta-casino 4950 vs 4950; 10 685 distinct references, 0 references with more than one grant; sum of granted amounts equals the sum of reward amounts (573 500 and 495 000 minor units) | pass |
| (b) Redemptions not final | 0 of 10 685 (all `issued`, all with `settled_at`); outbox jobs pending 0. Checked after the last run had ended, more than 60 s after the last callback | pass |
| (c) Spins used vs credited | alpha-casino 40 919 vs 40 919; beta-casino 17 522 vs 17 522 | pass |
| (d) Dead outbox jobs | 0 | pass |
| (e) Balance = prizes of used spins - cost of issued redemptions, 50 players read through `GET /me` (25 with a redemption, 13 alpha and 12 beta random) | 50 of 50 equal, `reserved` was "0" for all | pass |

Also: no line at level warn or error in the whole app log (322 291 lines), and no HTTP error status
in any of the 81 runs.

## 5. Storage growth

After the runs (about 162 000 deposits, 58 400 used spins, 10 685 redemptions): database 800 MiB.
Table sizes with indexes and rows:

| Table | rows | bytes | bytes per row |
|---|---|---|---|
| audit_log | 664 580 | 593 412 096 | 893 |
| inbound_events | 162 001 | 130 949 120 | 808 |
| spins | 162 001 | 54 870 016 | 339 |
| players | 135 621 | 30 400 512 | 224 |
| outbox | 69 126 | 16 187 392 | 234 |
| redemptions | 10 685 | 4 644 864 | 435 |

- **audit_log is 71 % of all table bytes** (593 MB of 831 MB). Rows per action: spin create 162 001,
  event create 162 001, player create 135 621, spin update 116 882, redemption update 47 690,
  redemption platform_call 29 688, redemption create 10 685.
- **Per deposit** (new player, one spin): 3 audit rows (measured: +3000 audit rows for 1000
  deposits) plus one row each in inbound_events, spins and players. By the averages above this is
  about 4 050 bytes, of which about 2 680 (66 %) are audit rows. The event body is stored in
  inbound_events and again inside its audit row.
- **Per spin used:** 2 audit rows (used, credited), about 346 bytes of row data each, plus 1 outbox row.
- **Per redemption:** 8.2 audit rows on average (1 create of 1 160 bytes, 4.5 updates of 376 bytes,
  2.8 platform calls of 239 bytes; about 3 500 bytes of row data), plus the 435-byte redemption row
  and one outbox row: audit is about 89 % of it.
- **Write-ahead log:** 8 624 640 bytes were written while about 920 to 1000 deposits ran (the
  counters were read before they had caught up). That is about 8.6-9.4 kB of log per deposit.

## 6. What this means for a broker in front of intake

Facts only. The decision is the owner's.

- **Measured intake on this machine, one app process, under background load:** 295-324 events/s for
  single events (platform A), 337-442 events/s with batches of 10 (platform B), 367-578 req/s for
  duplicates. Throughput did not rise above concurrency 8. Latency at the plateau: p99 40-67 ms at
  c = 8; 180-480 ms at c = 32-64. No errors up to c = 64.
- **What a deposit costs today.** About 2 transactions: (1) `SELECT * FROM tenants` outside any
  transaction, (2) one transaction of about 11 statements for a new player: BEGIN, SELECT player,
  INSERT player, INSERT audit, INSERT inbound_events, INSERT audit, SELECT wheel_configs, SELECT
  grant_policies, INSERT spin, INSERT audit, COMMIT (an existing player skips the player insert and its
  audit row). The 2 transactions per deposit match the `xact_commit` counter (+2066 for 1000
  requests, which includes a few other statements). The spin is created inside intake. About 9 kB of
  write-ahead log per deposit.
- **What a broker would change.** It moves the write later; it does not make the write cheaper:
  the same rows must still be written, by a consumer, at the rate shown above, and the consumer
  would hit the same limits (one process, pool of 5, the audit rows). It adds a component that must
  itself be durable and operated. It would help when the casino must get its answer while the
  database is slow or down, because the answer would then depend on the broker only. In these runs the database was never
  slow enough to produce an error or a timeout.
- **Cheaper steps visible in the measurements.** None of these was tried.

  | Step | Evidence | Tried |
  |---|---|---|
  | Pool size above 5 | pool is 5, PostgreSQL uses 130-196 % of one core and showed WAL waits, so more parallel statements are possible; but the app is also near one core, so the gain is unknown | not tried |
  | More than one app process | app container 98-128 % CPU, one Node process; the host has 16 CPUs | not tried |
  | Batch insert for platform B | a batch of 10 gives only 1.1x-1.4x events/s because each event is its own transaction | not tried |
  | One audit row per change | 3 audit rows per deposit, 66 % of the bytes per deposit and 71 % of all table bytes; each is a statement | not tried |
  | Tenant lookup on every request | one extra autocommit statement per request, for a table of 2 rows | not tried |
  | Redemption slots (2) and connection held during the casino call | redeem stops at about 30 req/s at c >= 8 and p50 grows with concurrency | not tried |
  | Log line per event at info | 322 255 lines; cost not measured | not tried |
  | Remove or archive done outbox rows | 69 126 rows, 16 MB, grow without limit | not tried |

## 7. Commands to repeat every measurement

The stack must be running (`docker compose up`). Replace `tenant` where needed.

```
# one run: scenario deposit | deposit-b | duplicate | wheel | me | spin | redeem-a | redeem-b | mixed
npx tsx scripts/load.ts --scenario deposit --n 2000 --c 32
# options: --url http://127.0.0.1:30080  --tenant alpha-casino|beta-casino  --warm 200  --players 200

# the grid used here: each scenario, c = 1 8 32 64, twice (c = 1 with n = 500; redeem and mixed n = 500 / 300)
for c in 1 8 32 64; do for r in 1 2; do npx tsx scripts/load.ts --scenario deposit --n 2000 --c $c; done; done

# during a run, every 2 seconds
docker stats --no-stream gamification-take-home-app-1 gamification-take-home-postgres-1 gamification-take-home-tigerbeetle-1 gamification-take-home-fake-casino-1
docker compose exec -T postgres psql -U app app -At -c "select state, wait_event_type, wait_event, count(*) from pg_stat_activity where datname='app' group by 1,2,3"
ss -tn state established '( dport = :30080 )' | wc -l

# correctness after the runs
curl -s http://127.0.0.1:30081/control/state          # grants, requests, callbacks
docker compose exec -T postgres psql -U app app -c "select tenant_id, status, count(*), sum((settled_at is not null)::int) from redemptions group by 1,2"
docker compose exec -T postgres psql -U app app -c "select tenant_id, count(*) filter (where status='used') used, count(*) filter (where credited_at is not null) credited from spins group by 1"
docker compose exec -T postgres psql -U app app -c "select count(*) from outbox where dead_at is not null"
# check (e): for 50 players compute sum(coins of used spins) - sum(cost of issued redemptions) in SQL,
# mint a token as in scripts/load.ts, and compare with GET /me balance.available + reserved.

# sizes
docker compose exec -T postgres psql -U app app -c "select relname, n_live_tup, pg_total_relation_size(relid) from pg_stat_user_tables order by 3 desc"
# cost of a deposit: read xact_commit (pg_stat_database), n_tup_ins (pg_stat_user_tables) and
# pg_current_wal_lsn() before and after `npx tsx scripts/load.ts --scenario deposit --n 1000 --c 8 --warm 0`;
# wait 3 seconds before reading, the counters lag.
```

## 8. Limits of this measurement

- Client and server share one host and CPU with other running work. Numbers moved by up to 30 %
  between runs of the same configuration (duplicate, deposit-b c = 8 and spin c = 8 needed a third run).
- The data set was small to begin with and grew during the runs from 0 to about 160 000 events, so
  later runs saw a bigger database than earlier ones. The order of runs was: deposit, deposit-b,
  duplicate, wheel, me, spin, redeem-a, redeem-b, mixed, then the third runs.
- TigerBeetle is a custom build for a CPU without AVX2 with a development data file; the ledger
  is probably slower than with an official build. The size of the difference is not measured.
- The casino is the fake one: it answers fast and sends platform B callbacks one at a time from a
  1-second timer, so the redeem-b time-to-final reflects the fake as much as the app.
- No network latency, no TLS, one app process, pool size 5 as shipped.
- Redemptions: n = 500 per run, not 2000. Concurrency 1 used n = 500 in every scenario.
- The load client signs its own events and tokens; the fake casino is not in the path for deposit,
  spin and read scenarios. The per-call latencies in `mixed` are 300 cycles per run.
- `pg_stat_statements` is not installed, so per-statement time is not measured; only a few
  read queries were explained.
- The effect of the log lines, the cost inside the TigerBeetle client, and the behaviour with a
  failing PostgreSQL or TigerBeetle: not measured.
