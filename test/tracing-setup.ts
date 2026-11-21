import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-node";
import { startTracing } from "../src/tracing/tracing.ts";

// Set TRACE_ALL_TESTS=1 to run every test file with tracing on (in-memory exporter).
// It checks that tracing changes nothing for the other tests. It is not the default.
if (process.env.TRACE_ALL_TESTS === "1") startTracing({ exporter: new InMemorySpanExporter() });
