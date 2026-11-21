import { AsyncLocalStorage } from "node:async_hooks";
import type { Clock } from "../clock.ts";

/**
 * Structured logs: one JSON object per line, written to a sink.
 *
 * Rules:
 *  - Few lines, each worth reading. The list of events is in docs/contracts.md.
 *  - A tenant's ops policy says how much it logs: "info" or "debug". Errors and warnings always pass.
 *  - Secrets never reach a line. Any field whose key looks secret is written as "***", at any depth.
 *  - Logging never throws into business code.
 */
export type Level = "error" | "warn" | "info" | "debug";

const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface LogSink {
  write(line: string): void;
}

/** One line to stdout. */
export const stdoutSink: LogSink = { write: (line) => void process.stdout.write(`${line}\n`) };

/** Keeps the lines in memory. For tests. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
}

export interface LogFields {
  tenantId?: string | null;
  requestId?: string;
  [key: string]: unknown;
}

const SECRET_KEY = /secret|token|signature|authorization|key|password/i;
const BEARER = /Bearer\s+[^\s"',;]+/gi;

const requests = new AsyncLocalStorage<{ requestId: string }>();

/** Runs `work` with this request id; every line written inside carries it. */
export function withRequestId<T>(requestId: string, work: () => T): T {
  return requests.run({ requestId }, work);
}

/** The request id of the running request or job, if there is one. */
export function currentRequestId(): string | undefined {
  return requests.getStore()?.requestId;
}

function replacer(key: string, value: unknown): unknown {
  if (key !== "" && SECRET_KEY.test(key)) return "***";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.replace(BEARER, "Bearer ***");
  if (value instanceof Error)
    return { name: value.name, message: value.message.replace(BEARER, "Bearer ***") };
  return value;
}

/** The value as JSON text with the redaction applied at every depth. Throws on a cycle. */
export function redactedJson(value: unknown): string {
  return JSON.stringify(value, replacer) ?? "null";
}

export class Log {
  constructor(
    private readonly sink: LogSink,
    private readonly clock: Clock,
    private readonly levelFor: (tenantId: string | null) => Level,
  ) {}

  event(level: Level, name: string, fields: LogFields = {}): void {
    try {
      const tenantId = fields.tenantId ?? null;
      if (RANK[level] > RANK[this.levelFor(tenantId)]) return;
      const { tenantId: _t, requestId: given, ...rest } = fields;
      const requestId = given ?? currentRequestId() ?? null;
      const at = this.clock.now().toISOString();
      try {
        this.sink.write(redactedJson({ at, level, event: name, tenantId, requestId, ...rest }));
      } catch {
        this.sink.write(
          JSON.stringify({
            at,
            level,
            event: name,
            tenantId,
            requestId,
            logError: "fields not serialisable",
          }),
        );
      }
    } catch {
      // Logging must never change what the service does.
    }
  }
}
