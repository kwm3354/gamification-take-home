import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeClock } from "../src/clock.ts";
import { type Level, Log, MemorySink, withRequestId } from "../src/logging/log.ts";
import { startApp } from "./app.ts";

// Unit tests of Log need nothing else. The tests of the running service are further down and are
// skipped when no TigerBeetle is available.

function makeLog(level: (tenantId: string | null) => Level = () => "info") {
  const sink = new MemorySink();
  const log = new Log(sink, new FakeClock("2026-03-04T05:06:07Z"), level);
  const parsed = () => sink.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { sink, log, parsed };
}

describe("Log", () => {
  test("a line has at, level, event, tenantId, requestId and the fields", () => {
    const { log, parsed } = makeLog();
    log.event("info", "x.happened", { tenantId: "t1", requestId: "r1", n: 3 });
    expect(parsed()).toEqual([
      {
        at: "2026-03-04T05:06:07.000Z",
        level: "info",
        event: "x.happened",
        tenantId: "t1",
        requestId: "r1",
        n: 3,
      },
    ]);
  });

  test("the level of the tenant decides: debug is dropped at info, kept at debug; errors always pass", () => {
    const { log, parsed } = makeLog((t) => (t === "loud" ? "debug" : "info"));
    for (const t of ["loud", "quiet", null]) {
      log.event("debug", "d", { tenantId: t });
      log.event("info", "i", { tenantId: t });
      log.event("warn", "w", { tenantId: t });
      log.event("error", "e", { tenantId: t });
    }
    const seen = parsed().map((l) => `${String(l.tenantId)}:${String(l.event)}`);
    expect(seen).toEqual([
      "loud:d",
      "loud:i",
      "loud:w",
      "loud:e",
      "quiet:i",
      "quiet:w",
      "quiet:e",
      "null:i",
      "null:w",
      "null:e",
    ]);
  });

  test("a level that only lets errors through is respected too", () => {
    const { log, parsed } = makeLog(() => "error");
    log.event("warn", "w");
    log.event("error", "e");
    expect(parsed().map((l) => l.event)).toEqual(["e"]);
  });

  test("secret-looking keys are written as *** at every depth, in arrays too", () => {
    const { sink, log } = makeLog();
    log.event("info", "x", {
      tenantId: "t",
      idempotencyKey: "KEY-1",
      nested: {
        webhookSecret: "S1",
        deep: [{ authorization: "Bearer abc.def" }, { password: "P1" }],
        ok: "fine",
      },
      signature: "SIG1",
      apiToken: "T1",
    });
    const line = sink.lines[0] as string;
    for (const secret of ["KEY-1", "S1", "abc.def", "P1", "SIG1", "T1"]) expect(line).not.toContain(secret);
    const o = JSON.parse(line);
    expect(o.nested.ok).toBe("fine");
    expect(o.idempotencyKey).toBe("***");
    expect(o.nested.deep[0].authorization).toBe("***");
  });

  test("a bearer token inside a text value is cut out", () => {
    const { sink, log } = makeLog();
    log.event("warn", "x", { error: "call failed with Authorization: Bearer abc.def.ghi, retrying" });
    expect(sink.lines[0]).not.toContain("abc.def.ghi");
    expect(sink.lines[0]).toContain("Bearer ***");
  });

  test("bigint is written as a string", () => {
    const { log, parsed } = makeLog();
    log.event("info", "x", { coins: 12345678901234567890n, list: [1n] });
    expect(parsed()[0]).toMatchObject({ coins: "12345678901234567890", list: ["1"] });
  });

  test("a value that cannot be serialised does not throw; a minimal line says so", () => {
    const { log, parsed } = makeLog();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => log.event("info", "x", { tenantId: "t", loop })).not.toThrow();
    expect(parsed()).toEqual([
      {
        at: "2026-03-04T05:06:07.000Z",
        level: "info",
        event: "x",
        tenantId: "t",
        requestId: null,
        logError: "fields not serialisable",
      },
    ]);
  });

  test("a sink or a level function that throws does not throw out of event", () => {
    const clock = new FakeClock();
    const bad = new Log(
      {
        write: () => {
          throw new Error("disk full");
        },
      },
      clock,
      () => "info",
    );
    expect(() => bad.event("info", "x")).not.toThrow();
    const bad2 = new Log(new MemorySink(), clock, () => {
      throw new Error("no level");
    });
    expect(() => bad2.event("info", "x")).not.toThrow();
  });

  test("a line is exactly one line: a newline inside a string is escaped", () => {
    const { sink, log } = makeLog();
    log.event("warn", "x", { error: "first\nsecond\r\nthird", "odd\nkey": 1 });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toMatch(/[\r\n]/);
    expect(JSON.parse(sink.lines[0] as string).error).toBe("first\nsecond\r\nthird");
  });

  test("the request id comes from the running request when the caller gives none", () => {
    const { log, parsed } = makeLog();
    withRequestId("req-9", () => log.event("info", "a"));
    withRequestId("req-9", () => log.event("info", "b", { requestId: "explicit" }));
    log.event("info", "c");
    expect(parsed().map((l) => l.requestId)).toEqual(["req-9", "explicit", null]);
  });
});

const running = await startApp();
afterAll(async () => {
  await running?.close();
});
const app = () => {
  if (!running) throw new Error("no app");
  return running;
};

describe.skipIf(!running)("request id", () => {
  beforeAll(() => {
    app().logs.length = 0;
  });

  test("a valid x-request-id is echoed", async () => {
    const r = await fetch(`${app().url}/health`, { headers: { "x-request-id": "abc.DEF_12-3" } });
    expect(r.headers.get("x-request-id")).toBe("abc.DEF_12-3");
  });

  test("an invalid x-request-id is replaced by a uuid; a missing one gets a uuid", async () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const bad of ["has space", "x".repeat(65), "semi;colon", "line\tbreak"]) {
      const r = await fetch(`${app().url}/health`, { headers: { "x-request-id": bad } });
      expect(r.headers.get("x-request-id")).toMatch(uuid);
    }
    const none = await fetch(`${app().url}/health`);
    expect(none.headers.get("x-request-id")).toMatch(uuid);
  });
});
