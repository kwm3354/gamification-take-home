# Sample requests and responses

Captured on 2026-11-21 on the development machine by running the stack with
`docker compose -p playground up` and calling it with curl. TigerBeetle was a local build for a CPU
without AVX2 (version 0.17.9, the same as the pinned client). Code at commit f421dd8.
The output below is copied from the real run; only whitespace at line ends was trimmed.

Addresses: our app is `http://localhost:30080`, the fake casino is `http://localhost:30081`. Ids,
timestamps and signatures differ on every run. In the commands, `$TOKEN` is the token from step 6.
The signatures in steps 2 and 5 were computed with `openssl` from the demo webhook secrets in
`src/tenants/demo-tenants.ts`. Calls to `/control/...` belong to the fake casino, not to our API.

### 1. A signed deposit, platform A, sent by the fake casino

```
$ curl -s -X POST http://localhost:30081/control/deposit -d '{"tenantId":"alpha-casino","platform":"A","playerId":"sample-a","amount":"20.00","eventId":"evt_sample_1"}'
{"eventId":"evt_sample_1","sent":[{"status":200,"body":{"accepted":1,"duplicates":0,"ignored":0}}]}
```

### 2. The same kind of request built by hand, so the headers and body are visible (platform A)

The signature is the hex HMAC-SHA256 of `timestamp + "." + raw body` with the tenant's webhook secret.

```
$ curl -s -i -X POST http://localhost:30080/webhooks/alpha-casino/events -H 'Content-Type: application/json' -H 'X-Alpha-Timestamp: 1795246877' -H 'X-Alpha-Signature: 96b1e405ed1c89a092e42269dd999e2b32a0bac8674d762ecc10fbe7f0e44415' -d '{"event_id":"evt_sample_2","type":"deposit.succeeded","player_id":"sample-a","amount_minor":2000,"currency":"EUR","occurred_at":"2026-11-21T07:41:17Z"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-G4BgEmrJ33JQBxVY64weI2/C09g"
Date: Sat, 21 Nov 2026 07:41:17 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":1,"duplicates":0,"ignored":0}
```

### 3. A duplicate deposit (same event id again)

```
$ curl -s -i -X POST http://localhost:30080/webhooks/alpha-casino/events -H 'Content-Type: application/json' -H 'X-Alpha-Timestamp: 1795246877' -H 'X-Alpha-Signature: 96b1e405ed1c89a092e42269dd999e2b32a0bac8674d762ecc10fbe7f0e44415' -d '{"event_id":"evt_sample_2","type":"deposit.succeeded","player_id":"sample-a","amount_minor":2000,"currency":"EUR","occurred_at":"2026-11-21T07:41:17Z"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-+hQgKbT89yPR5vvodqlBLVEKCEc"
Date: Sat, 21 Nov 2026 07:41:17 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":0,"duplicates":1,"ignored":0}
```

### 4. A bad signature (401, nothing changes)

```
$ curl -s -X POST http://localhost:30081/control/deposit -d '{"tenantId":"alpha-casino","platform":"A","playerId":"sample-a","amount":"20.00","tamper":"signature"}'
{"eventId":"evt_31eba748","sent":[{"status":401,"body":{"message":"Unauthorized","statusCode":401}}]}
```

### 5. A signed deposit, platform B (built by hand)

The signature is the base64 HMAC-SHA256 of the raw body.

```
$ curl -s -i -X POST http://localhost:30080/webhooks/beta-casino/events -H 'Content-Type: application/json' -H 'X-Beta-Auth: a5pFbjWkEp8MT2AzFL9jBSE7R+s1gDwDZ/scCu7Pzw8=' -d '{"batchId":"batch-sample-1","transactions":[{"txnId":"T-sample-1","kind":"DEPOSIT","state":"COMPLETED","customer":{"id":"sample-b"},"amount":"20.00","currencyCode":"EUR","completedAt":1795246877}]}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 41
ETag: W/"29-G4BgEmrJ33JQBxVY64weI2/C09g"
Date: Sat, 21 Nov 2026 07:41:17 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"accepted":1,"duplicates":0,"ignored":0}
```

### 6. A player token (the casino signs it; it lasts 10 minutes)

```
$ curl -s -X POST http://localhost:30081/control/token -d '{"tenantId":"alpha-casino","playerId":"sample-a"}'
{"token":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhbHBoYS1jYXNpbm8iLCJzdWIiOiJzYW1wbGUtYSIsImlhdCI6MTc5NTI0Njg3NywiZXhwIjoxNzk1MjQ3NDc3fQ.QkS4AdnrMujT6Nlix5Gl2aOHgNDqCnkz5AbbEysBvGo"}
```

The next commands use `TOKEN` for that token.

### 7. The player's state

```
$ curl -s http://localhost:30080/me -H "Authorization: Bearer $TOKEN"
{"playerId":"2ef86e11-3283-4e2e-8d59-0577ceab36a9","tenantId":"alpha-casino","balance":{"available":"0","reserved":"0"},"spins":[{"id":"35c3b7e0-2f3d-47d7-b4da-0b7819be8f08","status":"available","coins":null},{"id":"c0e0177a-dd48-4fb0-bf3a-9a99467fef92","status":"available","coins":null}]}
```

### 8. The wheel

```
$ curl -s http://localhost:30080/wheel -H "Authorization: Bearer $TOKEN"
{"version":1,"segments":[{"label":"10 coins","coins":10},{"label":"50 coins","coins":50},{"label":"100 coins","coins":100},{"label":"500 coins","coins":500}]}
```

### 9. A spin, and the same spin again (the answer is the same, the prize is paid once)

```
$ curl -s -X POST http://localhost:30080/wheel/spins/35c3b7e0-2f3d-47d7-b4da-0b7819be8f08/spin -H "Authorization: Bearer $TOKEN"; echo; curl -s -X POST http://localhost:30080/wheel/spins/35c3b7e0-2f3d-47d7-b4da-0b7819be8f08/spin -H "Authorization: Bearer $TOKEN"
{"spinId":"35c3b7e0-2f3d-47d7-b4da-0b7819be8f08","segmentIndex":1,"label":"50 coins","coins":50}
{"spinId":"35c3b7e0-2f3d-47d7-b4da-0b7819be8f08","segmentIndex":1,"label":"50 coins","coins":50}
```

### 10. The player after the spin

```
$ curl -s http://localhost:30080/me -H "Authorization: Bearer $TOKEN"
{"playerId":"2ef86e11-3283-4e2e-8d59-0577ceab36a9","tenantId":"alpha-casino","balance":{"available":"50","reserved":"0"},"spins":[{"id":"35c3b7e0-2f3d-47d7-b4da-0b7819be8f08","status":"used","coins":"50"},{"id":"c0e0177a-dd48-4fb0-bf3a-9a99467fef92","status":"available","coins":null}]}
```

Setup, not shown: to have enough coins, the script sent 1 more deposit for sample-a and spun every spin until the balance was at least 600.

### 11. The store

```
$ curl -s http://localhost:30080/store/items -H "Authorization: Bearer $TOKEN"
[{"id":"60471593-3ed1-4017-b228-cc763eb3526e","code":"bonus-1-eur","name":"Bonus 1 EUR","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100}},{"id":"cb284239-c402-4782-8511-0f73233959b2","code":"bonus-5-eur","name":"Bonus 5 EUR","costCoins":"500","reward":{"type":"bonus","currency":"EUR","amountMinor":500}}]
```

### 12. A redemption on platform A (issued at once)

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-1' -H 'Content-Type: application/json' -d '{"itemId":"60471593-3ed1-4017-b228-cc763eb3526e"}'
HTTP/1.1 201 Created
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 191
ETag: W/"bf-VhyGGjIuZJ7Kx+GIi7IW9Zn0sGs"
Date: Sat, 21 Nov 2026 07:41:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"f08c1d87-bc40-429b-900d-351206d5ff36","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_1","settled":true}
```

### 13. The same request again with the same Idempotency-Key (200, the same redemption, no second grant)

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-1' -H 'Content-Type: application/json' -d '{"itemId":"60471593-3ed1-4017-b228-cc763eb3526e"}'
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 191
ETag: W/"bf-VhyGGjIuZJ7Kx+GIi7IW9Zn0sGs"
Date: Sat, 21 Nov 2026 07:41:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"f08c1d87-bc40-429b-900d-351206d5ff36","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_1","settled":true}
```

### 14. Not enough coins (a player with no coins; the redemption ends as insufficient)

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhbHBoYS1jYXNpbm8iLCJzdWIiOiJzYW1wbGUtYnJva2UiLCJpYXQiOjE3OTUyNDY4NzgsImV4cCI6MTc5NTI0NzQ3OH0.KqHiziqFtIl6yE6SJLjs4UDTtHP9SeV-pizgt1CgCQk" -H 'Idempotency-Key: sample-key-broke' -H 'Content-Type: application/json' -d '{"itemId":"60471593-3ed1-4017-b228-cc763eb3526e"}'
HTTP/1.1 201 Created
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 197
ETag: W/"c5-LCv2l4n1I/VdxhcqdC6qFpt2rmk"
Date: Sat, 21 Nov 2026 07:41:18 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"4d9e9bbd-331c-4a31-a404-20568d1fd417","status":"insufficient","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":null,"settled":false}
```

(In that command the token is written out because it belongs to a second player, sample-broke.)

### 15. A redemption on platform B (accepted, then reported later by webhook)

Setup, not shown: the player sample-b of beta-casino was given enough coins the same way. `TOKEN_B` is its token.

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN_B" -H 'Idempotency-Key: sample-key-b1' -H 'Content-Type: application/json' -d '{"itemId":"8cd58992-f9db-4978-be46-9eb7f9db581c"}'
HTTP/1.1 201 Created
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 196
ETag: W/"c4-IvXeE9/yn/Q+RNCGDKYcN5YSDck"
Date: Sat, 21 Nov 2026 07:41:20 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"b5f001b3-f53e-4d8b-81a1-cb665231d25c","status":"submitting","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"r_1","settled":false}

```

Then, a few seconds later, the status:

```
$ curl -s http://localhost:30080/store/redemptions/b5f001b3-f53e-4d8b-81a1-cb665231d25c -H "Authorization: Bearer $TOKEN_B"
{"id":"b5f001b3-f53e-4d8b-81a1-cb665231d25c","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"r_1","settled":true}
```

What the casino recorded for that request (the callback it sent to us, and the grant):

```
$ curl -s http://localhost:30081/control/state | jq '{callback: [.callbacks[] | select(.externalRef=="b5f001b3-f53e-4d8b-81a1-cb665231d25c")], grant: [.grants[] | select(.reference=="b5f001b3-f53e-4d8b-81a1-cb665231d25c")]}'
{
  "callback": [
    {
      "tenantId": "beta-casino",
      "requestId": "r_1",
      "externalRef": "b5f001b3-f53e-4d8b-81a1-cb665231d25c",
      "finalState": "GRANTED",
      "status": "delivered",
      "sentCount": 1
    }
  ],
  "grant": [
    {
      "tenantId": "beta-casino",
      "platform": "B",
      "playerId": "sample-b",
      "reference": "b5f001b3-f53e-4d8b-81a1-cb665231d25c",
      "amountMinor": 100,
      "currency": "EUR",
      "platformRef": "r_1",
      "at": "2026-11-21T07:41:21.063Z"
    }
  ]
}

```

The callback body is `{"requestId", "externalRef", "state"}`, signed with the base64 HMAC of the raw body in `X-Beta-Auth` (see `deliverAll` in `src/fake-casino/platform-b.ts`). The page and this script do not capture that request itself; it goes from the casino container to the app container.

### 16. A redemption that survives a lost answer (platform A)

First arm the fault. `lost_answer`: the casino does the work, we never get the answer.

```
$ curl -s -X POST http://localhost:30081/control/faults -d '{"point":"a.grant","fault":"lost_answer","times":1,"tenantId":"alpha-casino"}'
[{"point":"a.grant","fault":"lost_answer","times":1,"tenantId":"alpha-casino"}]
```

Redeem. The answer is not final yet:

```
$ curl -s -i -X POST http://localhost:30080/store/redemptions -H "Authorization: Bearer $TOKEN" -H 'Idempotency-Key: sample-key-lost' -H 'Content-Type: application/json' -d '{"itemId":"60471593-3ed1-4017-b228-cc763eb3526e"}'
HTTP/1.1 201 Created
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
Content-Length: 195
ETag: W/"c3-dSPpn2C8RsXMSfSLLdnSlaV37xU"
Date: Sat, 21 Nov 2026 07:41:23 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"id":"a449a160-511b-456c-92c3-009688946057","status":"submitting","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":null,"settled":false}

```

A few seconds later the recovery job has looked first and found the grant:

```
$ curl -s http://localhost:30080/store/redemptions/a449a160-511b-456c-92c3-009688946057 -H "Authorization: Bearer $TOKEN"
{"id":"a449a160-511b-456c-92c3-009688946057","status":"issued","costCoins":"100","reward":{"type":"bonus","currency":"EUR","amountMinor":100},"reason":null,"platformRef":"b_2","settled":true}
```

The casino has ONE grant for that reference:

```
$ curl -s http://localhost:30081/control/state | jq '[.grants[] | select(.reference=="a449a160-511b-456c-92c3-009688946057")]'
[
  {
    "tenantId": "alpha-casino",
    "platform": "A",
    "playerId": "sample-a",
    "reference": "a449a160-511b-456c-92c3-009688946057",
    "amountMinor": 100,
    "currency": "EUR",
    "platformRef": "b_2",
    "at": "2026-11-21T07:41:23.730Z"
  }
]

```

And the calls we made for it (the first was the grant whose answer was lost):

```
$ curl -s http://localhost:30081/control/state | jq '[.requests[] | select(.reference=="a449a160-511b-456c-92c3-009688946057")]'
[
  {
    "tenantId": "alpha-casino",
    "point": "a.find",
    "reference": "a449a160-511b-456c-92c3-009688946057",
    "at": "2026-11-21T07:41:23.723Z",
    "fault": null
  },
  {
    "tenantId": "alpha-casino",
    "point": "a.grant",
    "reference": "a449a160-511b-456c-92c3-009688946057",
    "at": "2026-11-21T07:41:23.730Z",
    "fault": "lost_answer"
  },
  {
    "tenantId": "alpha-casino",
    "point": "a.find",
    "reference": "a449a160-511b-456c-92c3-009688946057",
    "at": "2026-11-21T07:41:24.897Z",
    "fault": null
  }
]

```
