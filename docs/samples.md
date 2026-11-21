# Sample requests and responses

Captured on 2026-11-21 at 10:33 UTC on the development machine, code at commit 9b692dc, by
running `docker compose up --build` (one `app`, two `worker` processes, the fake casino, Jaeger) and
calling it with curl. TigerBeetle was a local build for a CPU without AVX2 (version 0.17.9, the same
as the pinned client). The output below is copied from that run. Two things were changed: the stack
ran on moved host ports (36080, 36081) next to another one, and the commands are shown with the
default ports; long JSON from `jq` is printed on one line (`jq -c`).

Addresses: our app is `http://localhost:30080`, the fake casino is `http://localhost:30081`. Ids,
timestamps, signatures, request ids and trace ids differ on every run. Calls to `/control/...`
belong to the fake casino, not to our API. The signatures in steps 2 and 5 were computed with
`openssl` from the demo webhook secrets in `src/tenants/demo-tenants.ts`.

### 1. A signed deposit, platform A, sent by the fake casino

```
$ curl -s -X POST http://localhost:30081/control/deposit -d '{"tenantId":"alpha-casino","platform":"A","playerId":"sample-a","amount":"20.00","eventId":"evt_sample_1"}'
{"eventId":"evt_sample_1","sent":[{"status":200,"body":{"accepted":1,"duplicates":0,"ignored":0}}]}
```

### 2. The same kind of request built by hand, so the headers and body are visible (platform A)

The signature is the hex HMAC-SHA256 of `timestamp + "." + raw body` with the tenant's webhook
secret. Every answer carries `x-request-id` (the id in our log lines and audit rows) and, with
tracing on, `x-trace-id` (the trace in Jaeger).

```
$ curl -s -i -X POST http://localhost:30080/webhooks/alpha-casino/events -H 'Content-Type: application/json' -H 'X-Alpha-Timestamp: 1795257208' -H 'X-Alpha-Signature: 25e81cdfa17edaba84c38d455e1f77aadc4090c73f85502bc3d9b3974e949da2' -d '{"event_id":"evt_sample_2","type":"deposit.succeeded","player_id":"sample-a","amount_minor":2000,"currency":"EUR","occurred_at":"2026-11-21T10:33:28Z"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
x-request-id: 9ff022bf-f4b0-4664-adcf-4d935b7f780c
x-trace-id: f63bfe2a62b5df8fa04cf069591f7537
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-G4BgEmrJ33JQBxVY64weI2/C09g"
Date: Sat, 21 Nov 2026 10:33:28 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":1,"duplicates":0,"ignored":0}
```

### 3. A duplicate deposit (same event id again)

```
$ curl -s -i -X POST http://localhost:30080/webhooks/alpha-casino/events -H 'Content-Type: application/json' -H 'X-Alpha-Timestamp: 1795257208' -H 'X-Alpha-Signature: 25e81cdfa17edaba84c38d455e1f77aadc4090c73f85502bc3d9b3974e949da2' -d '{"event_id":"evt_sample_2","type":"deposit.succeeded","player_id":"sample-a","amount_minor":2000,"currency":"EUR","occurred_at":"2026-11-21T10:33:28Z"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
x-request-id: e317b1cc-e240-421a-80bd-cf656f1ee529
x-trace-id: f84457278f4b9cbcd3d25b498322a7bf
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-+hQgKbT89yPR5vvodqlBLVEKCEc"
Date: Sat, 21 Nov 2026 10:33:28 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":0,"duplicates":1,"ignored":0}
```

### 4. A bad signature (401, nothing changes)

```
$ curl -s -X POST http://localhost:30081/control/deposit -d '{"tenantId":"alpha-casino","platform":"A","playerId":"sample-a","amount":"20.00","tamper":"signature"}'
{"eventId":"evt_cb99c65d","sent":[{"status":401,"body":{"message":"Unauthorized","statusCode":401}}]}
```

### 5. A signed deposit, platform B (built by hand)

The signature is the base64 HMAC-SHA256 of the raw body.

```
$ curl -s -i -X POST http://localhost:30080/webhooks/beta-casino/events -H 'Content-Type: application/json' -H 'X-Beta-Auth: xub6HDr9q/Xe8hWeEN2L4YxBAps/jk4QgQQzV+PsdNU=' -d '{"batchId":"batch-sample-1","transactions":[{"txnId":"T-sample-1","kind":"DEPOSIT","state":"COMPLETED","customer":{"id":"sample-b"},"amount":"20.00","currencyCode":"EUR","completedAt":1795257208}]}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
x-request-id: 1f84eb83-dedf-4e0f-83ed-e4daa6a3dcd9
x-trace-id: 12868d009e2c585acb80d68e4f83fe34
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-G4BgEmrJ33JQBxVY64weI2/C09g"
Date: Sat, 21 Nov 2026 10:33:28 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":1,"duplicates":0,"ignored":0}
```

### 6. A player token (the casino signs it; this one lasts 10 minutes)

```
$ curl -s -X POST http://localhost:30081/control/token -d '{"tenantId":"alpha-casino","playerId":"sample-a"}'
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhbHBoYS1jYXNpbm8iLCJzdWIiOiJzYW1wbGUtYSIsImlhdCI6MTc5NTI1NzIwOCwiZXhwIjoxNzk1MjU3ODA4fQ.c0uOAkl8jIsNQgi3wZAe6ywdRY_q8oGR5qc33x_d-OI"}
```

The next commands use `TOKEN` for that token.

### 7. The player's state

The first deposit (step 1) and the hand-built one (step 2) gave one spin each.

```
$ curl -s http://localhost:30080/me -H "Authorization: Bearer $TOKEN"
{"playerId":"67624407-34d8-4018-9ea9-b2cc9f3d43c3","tenantId":"alpha-casino","balance":{"available":"0","reserved":"0"},"spins":[{"id":"fa19288c-bc5a-466a-9a1a-de2eac25d235","status":"available","coins":null},{"id":"af3ac8b0-c10b-4d8f-9a2b-5a724da53a4b","status":"available","coins":null}]}
```

### 8. The wheel (labels and coins; the weights are not shown)

```
$ curl -s http://localhost:30080/wheel -H "Authorization: Bearer $TOKEN"
{"version":1,"segments":[{"label":"10 coins","coins":10},{"label":"50 coins","coins":50},{"label":"100 coins","coins":100},{"label":"500 coins","coins":500}]}
```

### 9. A spin, and the same spin again (the answer is the same, the prize is paid once)

```
$ curl -s -X POST http://localhost:30080/wheel/spins/fa19288c-bc5a-466a-9a1a-de2eac25d235/spin -H "Authorization: Bearer $TOKEN"; echo; curl -s -X POST http://localhost:30080/wheel/spins/fa19288c-bc5a-466a-9a1a-de2eac25d235/spin -H "Authorization: Bearer $TOKEN"
{"spinId":"fa19288c-bc5a-466a-9a1a-de2eac25d235","segmentIndex":1,"label":"50 coins","coins":50}
{"spinId":"fa19288c-bc5a-466a-9a1a-de2eac25d235","segmentIndex":1,"label":"50 coins","coins":50}
```

### 10. The player after the spin (50 coins, not 100)

```
$ curl -s http://localhost:30080/me -H "Authorization: Bearer $TOKEN"
{"playerId":"67624407-34d8-4018-9ea9-b2cc9f3d43c3","tenantId":"alpha-casino","balance":{"available":"50","reserved":"0"},"spins":[{"id":"fa19288c-bc5a-466a-9a1a-de2eac25d235","status":"used","coins":"50"},{"id":"af3ac8b0-c10b-4d8f-9a2b-5a724da53a4b","status":"available","coins":null}]}
```

Setup, not shown: to have enough coins, the script sent 14 more deposits for sample-a through the
fake casino and spun every spin until the balance was at least 600. It did the same for sample-b
of beta-casino (3 more deposits).

### 11. The store

```
$ curl -s http://localhost:30080/store/items -H "Authorization: Bearer $TOKEN"
[{"id":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c","code":"bonus-1-eur","name":"Bonus 1 EUR","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100}},{"id":"b1cf9454-f74f-4b64-8c96-018c7e2e7a1e","code":"bonus-5-eur","name":"Bonus 5 EUR","costCoins":"500","reward":{"type":"bonus","currency":"EUR","amountMinor":500}}]
```

### 12. A redemption on platform A (issued at once)

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-1' -H 'Content-Type: application/json' -d '{"itemId":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c"}'
HTTP/1.1 201 Created
X-Powered-By: Express
Access-Control-Allow-Origin: *
x-request-id: 87061e75-27af-46ac-b980-edee8b938c43
x-trace-id: b1119febd7048f1e409e384d9182b20c
Content-Type: application/json; charset=utf-8
Content-Length: 191
ETag: W/"bf-Ffl5XmDvB3auz7fZaR8kZLSBtus"
Date: Sat, 21 Nov 2026 10:33:34 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"e9ad5e23-1bf9-4e6f-a713-ef57184643a2","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_1","settled":true}
```

### 13. The same request again with the same Idempotency-Key (200, the same redemption, no second grant)

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-1' -H 'Content-Type: application/json' -d '{"itemId":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
x-request-id: 9e743a54-df9f-423e-b7b4-885b900fe06e
x-trace-id: 104b3679db8c297733a4cff0807762d0
Content-Type: application/json; charset=utf-8
Content-Length: 191
ETag: W/"bf-Ffl5XmDvB3auz7fZaR8kZLSBtus"
Date: Sat, 21 Nov 2026 10:33:34 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"e9ad5e23-1bf9-4e6f-a713-ef57184643a2","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_1","settled":true}
```

### 14. Not enough coins (a player with no coins; the redemption ends as insufficient)

`TOKEN_BROKE` is a token for a second player, sample-broke, made as in step 6. Nothing was
reserved, so the redemption is final and settled at once.

```
$ curl -s -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN_BROKE" -H 'Idempotency-Key: sample-key-broke' -H 'Content-Type: application/json' -d '{"itemId":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c"}'
{"id":"26ae0651-efa1-4355-ad20-73db61ab38f9","status":"insufficient","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":null,"settled":true}
```

### 15. A redemption on platform B (accepted, then reported later by webhook)

`TOKEN_B` is the token of sample-b of beta-casino. The item id is beta-casino's own `bonus-1-eur`.

```
$ curl -s -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN_B" -H 'Idempotency-Key: sample-key-b1' -H 'Content-Type: application/json' -d '{"itemId":"1e11276f-f3c6-4ad2-bd56-ff638d0662f0"}'
{"id":"e5eca581-baf3-4b2e-a15f-5a52e61f85a5","status":"submitting","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"r_1","settled":false}
```

Four seconds later, the status:

```
$ curl -s http://localhost:30080/store/redemptions/e5eca581-baf3-4b2e-a15f-5a52e61f85a5 -H "Authorization: Bearer $TOKEN_B"
{"id":"e5eca581-baf3-4b2e-a15f-5a52e61f85a5","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"r_1","settled":true}
```

What the casino recorded for that request (the callback it sent to us, and the grant):

```
$ curl -s http://localhost:30081/control/state | jq -c '{callback: [.callbacks[] | select(.externalRef=="e5eca581-baf3-4b2e-a15f-5a52e61f85a5")], grant: [.grants[] | select(.reference=="e5eca581-baf3-4b2e-a15f-5a52e61f85a5")]}'
{"callback":[{"tenantId":"beta-casino","requestId":"r_1","externalRef":"e5eca581-baf3-4b2e-a15f-5a52e61f85a5","finalState":"GRANTED","status":"delivered","sentCount":1}],"grant":[{"tenantId":"beta-casino","platform":"B","playerId":"sample-b","reference":"e5eca581-baf3-4b2e-a15f-5a52e61f85a5","amountMinor":100,"currency":"EUR","platformRef":"r_1","at":"2026-11-21T10:33:34.934Z"}]}
```

The callback body is `{"requestId", "externalRef", "state"}`, signed with the base64 HMAC of the raw
body in `X-Beta-Auth` (see `deliverAll` in `src/fake-casino/platform-b.ts`). It goes from the casino
container to the app container, so this script does not capture the request itself.

### 16. A redemption that survives a lost answer (platform A)

First arm the fault. `lost_answer`: the casino does the work, we never get the answer.

```
$ curl -s -X POST http://localhost:30081/control/faults -d '{"point":"a.grant","fault":"lost_answer","times":1,"tenantId":"alpha-casino"}'
[{"point":"a.grant","fault":"lost_answer","times":1,"tenantId":"alpha-casino"}]
```

Redeem. The answer is not final yet:

```
$ curl -s -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-lost' -H 'Content-Type: application/json' -d '{"itemId":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c"}'
{"id":"f70d3474-f659-4eca-93aa-a9794cfea8ee","status":"submitting","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":null,"settled":false}
```

Five seconds later a worker has looked first and found the grant:

```
$ curl -s http://localhost:30080/store/redemptions/f70d3474-f659-4eca-93aa-a9794cfea8ee -H "Authorization: Bearer $TOKEN"
{"id":"f70d3474-f659-4eca-93aa-a9794cfea8ee","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_2","settled":true}
```

The casino has ONE grant for that reference:

```
$ curl -s http://localhost:30081/control/state | jq -c '[.grants[] | select(.reference=="f70d3474-f659-4eca-93aa-a9794cfea8ee")]'
[{"tenantId":"alpha-casino","platform":"A","playerId":"sample-a","reference":"f70d3474-f659-4eca-93aa-a9794cfea8ee","amountMinor":100,"currency":"EUR","platformRef":"b_2","at":"2026-11-21T10:33:39.020Z"}]
```

And the calls we made for it: look first, the grant whose answer was lost, and the second look
that found it.

```
$ curl -s http://localhost:30081/control/state | jq -c '[.requests[] | select(.reference=="f70d3474-f659-4eca-93aa-a9794cfea8ee") | {point, at, fault}]'
[{"point":"a.find","at":"2026-11-21T10:33:38.985Z","fault":null},{"point":"a.grant","at":"2026-11-21T10:33:39.020Z","fault":"lost_answer"},{"point":"a.find","at":"2026-11-21T10:33:40.237Z","fault":null}]
```

### 17. Back office sign-in

Admin calls need a token that we sign after a password check. The demo users and their passwords
are in `src/tenants/demo-tenants.ts`.

```
$ curl -s -X POST http://localhost:30080/admin/auth/login -H 'Content-Type: application/json' -d '{"email":"manager@alpha.demo","password":"demo-alpha-manager-1"}'
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjNjEzMzEyZC1mNDZkLTRmYjUtYmRlYS01MmRhOGY0NTc5M2UiLCJyb2xlIjoidGVuYW50X2FkbWluIiwidGlkIjoiYWxwaGEtY2FzaW5vIiwibmFtZSI6IkFscGhhIE1hbmFnZXIiLCJpYXQiOjE3OTUyNTcyMjQsImV4cCI6MTc5NTI1OTAyNCwiYXVkIjoiYmFja29mZmljZSJ9.JmGKWeoYt2izOd0Vypc-GXjT49ua7INeeBXttH0Mfac","expiresAt":"2026-11-21T11:03:44.000Z","user":{"id":"c613312d-f46d-4fb5-bdea-52da8f45793e","email":"manager@alpha.demo","name":"Alpha Manager","role":"tenant_admin","tenantId":"alpha-casino"}}
```

The next commands use `ADMIN` for that token.

### 18. The audit trail of the redemption from step 16

Every change of the row, and every call to the casino, with the actor. The first steps ran inside
the player's request; after the lost answer a worker (`system/outbox`) took over.

```
$ curl -s http://localhost:30080/admin/alpha-casino/audit?entityId=f70d3474-f659-4eca-93aa-a9794cfea8ee -H "Authorization: Bearer $ADMIN" | jq -c '.[] | {at, actor, action, changes}'
{"at":"2026-11-21T10:33:38.893Z","actor":"player/67624407-34d8-4018-9ea9-b2cc9f3d43c3","action":"create","changes":[{"to":"f70d3474-f659-4eca-93aa-a9794cfea8ee","from":null,"field":"id"},{"to":"alpha-casino","from":null,"field":"tenant_id"},{"to":"67624407-34d8-4018-9ea9-b2cc9f3d43c3","from":null,"field":"player_id"},{"to":"sample-key-lost","from":null,"field":"idempotency_key"},{"to":"4c946fc7-fc6d-4629-8cfb-41b8d57c0b9c","from":null,"field":"item_id"},{"to":"100","from":null,"field":"cost_coins"},{"to":{"type":"bonus","currency":"EUR","amountMinor":100},"from":null,"field":"reward"},{"to":"created","from":null,"field":"status"},{"to":null,"from":null,"field":"platform_ref"},{"to":null,"from":null,"field":"reason"},{"to":null,"from":null,"field":"settled_at"},{"to":"2026-11-21T10:33:38.893Z","from":null,"field":"created_at"},{"to":"2026-11-21T10:33:38.893Z","from":null,"field":"updated_at"}]}
{"at":"2026-11-21T10:33:38.917Z","actor":"player/67624407-34d8-4018-9ea9-b2cc9f3d43c3","action":"update","changes":[{"to":"reserved","from":"created","field":"status"},{"to":"2026-11-21T10:33:38.917Z","from":"2026-11-21T10:33:38.893Z","field":"updated_at"}]}
{"at":"2026-11-21T10:33:38.952Z","actor":"player/67624407-34d8-4018-9ea9-b2cc9f3d43c3","action":"update","changes":[{"to":"submitting","from":"reserved","field":"status"},{"to":"2026-11-21T10:33:38.952Z","from":"2026-11-21T10:33:38.917Z","field":"updated_at"}]}
{"at":"2026-11-21T10:33:38.990Z","actor":"player/67624407-34d8-4018-9ea9-b2cc9f3d43c3","action":"platform_call","changes":{"call":"find","outcome":"not_found"}}
{"at":"2026-11-21T10:33:39.035Z","actor":"player/67624407-34d8-4018-9ea9-b2cc9f3d43c3","action":"platform_call","changes":{"call":"issue","error":"POST /a/bonuses: connection failed (fetch failed)"}}
{"at":"2026-11-21T10:33:40.262Z","actor":"system/outbox","action":"platform_call","changes":{"call":"find","outcome":"issued"}}
{"at":"2026-11-21T10:33:40.269Z","actor":"system/outbox","action":"update","changes":[{"to":"issued","from":"submitting","field":"status"},{"to":"b_2","from":null,"field":"platform_ref"},{"to":"2026-11-21T10:33:40.269Z","from":"2026-11-21T10:33:38.952Z","field":"updated_at"}]}
{"at":"2026-11-21T10:33:40.300Z","actor":"system/outbox","action":"update","changes":[{"to":"2026-11-21T10:33:40.300Z","from":null,"field":"settled_at"},{"to":"2026-11-21T10:33:40.300Z","from":"2026-11-21T10:33:40.269Z","field":"updated_at"}]}
```

### 19. Alerts (none open)

```
$ curl -s http://localhost:30080/admin/alpha-casino/alerts -H "Authorization: Bearer $ADMIN"
{"at":"2026-11-21T10:33:44.589Z","policyVersion":1,"alerts":[]}
```

### 20. No token, and another tenant's path

Without a token the answer is 401. The alpha-casino manager on beta-casino's path gets 404, the
same as for a tenant that does not exist.

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:30080/admin/alpha-casino/alerts
401
$ curl -s -o /dev/null -w '%{http_code}\n' http://localhost:30080/admin/beta-casino/alerts -H "Authorization: Bearer $ADMIN"
404
```
