import {
  type AttributeValue,
  type Attributes,
  type Context,
  DiagLogLevel,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  diag,
  propagation,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  SimpleSpanProcessor,
  type SpanExporter,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/**
 * Tracing by hand. Spans are made at our own boundaries (http, db, ledger, platform, outbox), so
 * what is traced is what we chose. No module patching, no auto instrumentation.
 *
 * Rules:
 *  - Off unless started. When off, every function here only calls the work it was given.
 *  - Tracing never throws into business code and never changes a result.
 *  - Attributes carry ids and names only: never secrets, tokens, bodies or SQL parameter values.
 *  - A span that is not a root needs a running parent. A db call with no request behind it
 *    (the outbox timer asking for due jobs) makes no span, so idle ticks leave no traces.
 */

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface TracingOptions {
  /** OTLP/HTTP base address, for example http://jaeger:4318. Without it (and without `exporter`) tracing stays off. */
  endpoint?: string;
  serviceName?: string;
  /**
   * Share of new traces that are recorded, 0 to 1 (default 1). The decision is made once at the root and
   * every child follows it: a sampled request keeps all its spans, an unsampled one records none.
   * A request that arrives with a `traceparent` follows the caller's decision.
   */
  sampleRatio?: number;
  /** Tests plug in an in-memory exporter. It is used with a simple processor, so spans are readable at once. */
  exporter?: SpanExporter;
  /** Receives export errors, at most one a minute. The default writes one line to stderr. */
  onExportError?: (error: unknown) => void;
  /** When true, `TracingModule` stops tracing (and flushes) when the app shuts down. main.ts sets it; tests do not. */
  stopOnAppClose?: boolean;
}

const TRACER = "gamification";
const NOOP_SPAN: Span = trace.wrapSpanContext({
  traceId: "00000000000000000000000000000000",
  spanId: "0000000000000000",
  traceFlags: 0,
});

let provider: NodeTracerProvider | undefined;
let stopOnAppClose = false;

/** Called by TracingModule at app shutdown. Flushes pending spans if main.ts asked for it. */
export async function flushOnAppClose(): Promise<void> {
  if (stopOnAppClose) await stopTracing();
}

/** True when spans are really being recorded. */
export function tracingOn(): boolean {
  return provider !== undefined;
}

function ratioFrom(text: string | undefined): number {
  const n = text === undefined || text === "" ? 1 : Number(text);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

export function tracingOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): TracingOptions {
  return {
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    serviceName: env.OTEL_SERVICE_NAME || "gamification",
    sampleRatio: ratioFrom(env.OTEL_TRACES_SAMPLE_RATIO),
  };
}

/** Wraps an OTLP exporter so a dead collector costs one warning a minute, not a stream of errors. */
function quietExporter(inner: SpanExporter, onError: (e: unknown) => void): SpanExporter {
  let lastWarn = Number.NEGATIVE_INFINITY;
  return {
    export(spans, done) {
      try {
        inner.export(spans, (result) => {
          if (result.error) {
            const at = performance.now();
            if (at - lastWarn >= 60_000) {
              lastWarn = at;
              onError(result.error);
            }
          }
          done({ code: 0 }); // a failed batch is dropped: never retried, never fatal
        });
      } catch (e) {
        done({ code: 0 });
        onError(e);
      }
    },
    shutdown: () => inner.shutdown(),
    forceFlush: () => inner.forceFlush?.() ?? Promise.resolve(),
  };
}

/** Starts tracing and returns the function that flushes pending spans and stops it. */
export function startTracing(options: TracingOptions = {}): () => Promise<void> {
  void stopTracing();
  const onError =
    options.onExportError ??
    ((e) => process.stderr.write(`tracing: export failed: ${e instanceof Error ? e.message : String(e)}\n`));
  let processor: SimpleSpanProcessor | BatchSpanProcessor;
  if (options.exporter) {
    processor = new SimpleSpanProcessor(options.exporter);
  } else if (options.endpoint) {
    const url = `${options.endpoint.replace(/\/$/, "")}/v1/traces`;
    processor = new BatchSpanProcessor(quietExporter(new OTLPTraceExporter({ url }), onError));
  } else {
    return async () => {};
  }
  const created = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName ?? "gamification" }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio ?? 1) }),
    spanProcessors: [processor],
  });
  // register() also installs the AsyncLocalStorage context manager and the W3C propagator.
  created.register();
  // The batch processor counts the spans it drops when its queue is full and reports the count through
  // the diag channel. Show that one message; the SDK sends it once per burst.
  diag.setLogger(
    {
      error() {},
      info() {},
      debug() {},
      verbose() {},
      warn: (m) => {
        if (m.startsWith("Dropped")) process.stderr.write(`tracing: ${m}\n`);
      },
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
  provider = created;
  stopOnAppClose = options.stopOnAppClose === true;
  return () => stopTracing();
}

async function stopTracing(): Promise<void> {
  const current = provider;
  if (!current) return;
  provider = undefined;
  // Unregister at once (before any await), so a provider started right after is not unregistered.
  trace.disable();
  context.disable();
  propagation.disable();
  try {
    await current.shutdown(); // flushes pending spans
  } catch {
    // nothing to do: tracing must not fail the shutdown
  }
}

const tracer = () => trace.getTracer(TRACER);

function clean(attributes: SpanAttributes): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attributes)) if (v !== undefined) out[k] = v as AttributeValue;
  return out;
}

/** Marks the span as failed: error status and the exception recorded. */
export function recordFailure(s: Span, e: unknown): void {
  try {
    s.recordException(e instanceof Error ? e : String(e));
    s.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
    if (e instanceof Error) s.setAttribute("error.type", e.constructor.name);
  } catch {
    // ignore
  }
}

export function endSpan(s: Span): void {
  try {
    s.end();
  } catch {
    // ignore
  }
}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";

/**
 * Runs `fn` inside an active span. On a throw (or a rejected promise) it records the exception, sets
 * the error status and rethrows the same error. The span is always ended. Returns what `fn` returns,
 * sync or async. `root: true` starts a new trace, linked to nothing.
 */
export function span<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (s: Span) => T,
  options: { root?: boolean } = {},
): T {
  if (provider === undefined) return fn(NOOP_SPAN);
  let s: Span;
  let ctx: Context;
  try {
    if (!options.root && trace.getActiveSpan() === undefined) return fn(NOOP_SPAN);
    const base = options.root ? trace.deleteSpan(context.active()) : context.active();
    s = tracer().startSpan(name, { attributes: clean(attributes), root: options.root }, base);
    ctx = trace.setSpan(base, s);
  } catch {
    return fn(NOOP_SPAN);
  }
  let result: T;
  try {
    result = context.with(ctx, () => fn(s));
  } catch (e) {
    recordFailure(s, e);
    endSpan(s);
    throw e;
  }
  if (isThenable(result)) {
    return result.then(
      (v) => {
        endSpan(s);
        return v;
      },
      (e) => {
        recordFailure(s, e);
        endSpan(s);
        throw e;
      },
    ) as T;
  }
  endSpan(s);
  return result;
}

/** Sets one attribute on the running span, if there is one. */
export function setSpanAttribute(key: string, value: string | number | boolean | undefined): void {
  if (provider === undefined || value === undefined) return;
  try {
    trace.getActiveSpan()?.setAttribute(key, value);
  } catch {
    // ignore
  }
}

/** The trace id of the running span, or undefined when tracing is off or no span runs. */
export function currentTraceId(): string | undefined {
  if (provider === undefined) return undefined;
  try {
    const ctx = trace.getActiveSpan()?.spanContext();
    return ctx && trace.isSpanContextValid(ctx) ? ctx.traceId : undefined;
  } catch {
    return undefined;
  }
}

/** Adds `traceparent` to outgoing headers when a span runs. */
export function injectTraceHeaders(headers: Record<string, string>): void {
  if (provider === undefined) return;
  try {
    propagation.inject(context.active(), headers);
  } catch {
    // ignore
  }
}

/** For the http middleware: starts a server span that continues the caller's trace, if it sent one. */
export function startServerSpan(
  name: string,
  attributes: SpanAttributes,
  headers: Record<string, string | string[] | undefined>,
): { span: Span; ctx: Context } | undefined {
  if (provider === undefined) return undefined;
  try {
    const parent = propagation.extract(trace.deleteSpan(context.active()), headers);
    const s = tracer().startSpan(name, { kind: SpanKind.SERVER, attributes: clean(attributes) }, parent);
    return { span: s, ctx: trace.setSpan(parent, s) };
  } catch {
    return undefined;
  }
}
