import { Injectable, type NestMiddleware } from "@nestjs/common";
import { SpanStatusCode, context } from "@opentelemetry/api";
import { currentRequestId } from "../logging/log.ts";
import { endSpan, recordFailure, startServerSpan, tracingOn } from "./tracing.ts";

interface Req {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  playerAuth?: { tenant?: { id?: unknown } };
  admin?: { tenant?: { id?: unknown } };
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  once(event: "finish" | "close", listener: () => void): unknown;
}

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * One server span per request: `http <METHOD> <route pattern>`. It continues a `traceparent` from the
 * caller and answers with `x-trace-id`. Install it after RequestIdMiddleware: the span carries the
 * same request id the log lines and audit rows carry, and that id is the join key.
 * When tracing is off it calls `next` and nothing else.
 */
@Injectable()
export class TracingMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    if (!tracingOn()) {
      next();
      return;
    }
    const started = startServerSpan(
      `http ${req.method}`,
      { "http.request.method": req.method, "request.id": currentRequestId() },
      req.headers,
    );
    if (!started) {
      next();
      return;
    }
    const { span, ctx } = started;
    try {
      res.setHeader("x-trace-id", span.spanContext().traceId);
    } catch {
      // ignore
    }
    let ended = false;
    const finish = (completed: boolean): void => {
      if (ended) return;
      ended = true;
      try {
        // The route is known only now: the matching happens after the middleware.
        const route = text(req.route?.path);
        span.updateName(`http ${req.method} ${route ?? "(no route)"}`);
        if (route) span.setAttribute("http.route", route);
        span.setAttribute("http.response.status_code", res.statusCode);
        const tenant =
          text(req.params?.tenantId) ?? text(req.playerAuth?.tenant?.id) ?? text(req.admin?.tenant?.id);
        if (tenant) span.setAttribute("tenant.id", tenant);
        if (!completed) recordFailure(span, new Error("connection closed before the response"));
        else if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      } catch {
        // ignore
      }
      endSpan(span);
    };
    res.once("finish", () => finish(true));
    res.once("close", () => finish(false));
    context.with(ctx, next);
  }
}
