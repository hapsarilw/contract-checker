import { SpanStatusCode, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AppError } from "../lib/AppError.js";
import { getRequestId } from "../middleware/requestId.js";
import logger from "./logger.js";

/**
 * SRS §6.6: "OpenTelemetry spans around the analyze pipeline (extract →
 * prompt → provider call → validate → verify → persist) with the
 * requestId as an attribute. This is what makes 'the analysis took 50
 * seconds' answerable without guessing which stage was slow."
 *
 * THE SPANS AND WHERE THEY ARE OPENED:
 *   document.extract     services/intake.js, at UPLOAD. Text is extracted
 *                        once, when the document arrives (FR-2.x), not on
 *                        every analysis, so this span lives in the upload
 *                        request's trace. It is the same stage §6.6 names;
 *                        it simply happens in the request that does it.
 *   analysis             services/analysis.js, the root of an analyze
 *   analysis.prompt      services/llm/index.js, building the messages
 *   analysis.provider_call  services/llm/index.js, one per provider call,
 *                        transport retries included (llm.attempts says how
 *                        many)
 *   analysis.validate    services/analysis.js, the schema check
 *   analysis.verify      services/analysis.js, excerpt verification (§5.3)
 *   analysis.persist     services/analysis.js, the COMPLETED transaction
 *
 * WHAT A SPAN MAY CARRY: identifiers, counts and codes. Never document
 * text, an excerpt, a summary, a prompt or an email address (NFR-2.8,
 * §6.5's logging rule applies to traces too, since a trace backend is
 * another place data goes). A failed span records the error's CODE as its
 * status, never the error's message or stack: provider and parser errors
 * can quote the input that caused them.
 *
 * OFF UNLESS CONFIGURED: with no OTEL_EXPORTER_OTLP_ENDPOINT, no SDK is
 * started and the API is a no-op, so every span below costs nothing. The
 * exporter reads the standard OTEL_EXPORTER_OTLP_* variables itself
 * (headers for an authenticated collector included).
 */

export const TRACER_NAME = "clausecheck-server";

/** The attribute every span carries (§6.6: "the requestId as an attribute"). */
export const REQUEST_ID_ATTRIBUTE = "clausecheck.request_id";

const tracer = () => trace.getTracer(TRACER_NAME);

/**
 * Runs `fn` inside a span named `name`, as a child of whatever span is
 * active. The request id is attached automatically.
 *
 * @template T
 * @param {string} name
 * @param {(span: import("@opentelemetry/api").Span) => Promise<T> | T} fn
 * @param {Record<string, string | number | boolean>} [attributes] ids and counts only
 * @returns {Promise<T>}
 */
export function withSpan(name, fn, attributes = {}) {
  const requestId = getRequestId();
  return tracer().startActiveSpan(
    name,
    { attributes: { ...(requestId ? { [REQUEST_ID_ATTRIBUTE]: requestId } : {}), ...attributes } },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const code = err instanceof AppError ? err.code : "INTERNAL";
        span.setAttribute("error.code", code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Starts the SDK when an OTLP endpoint is configured. Returns a shutdown
 * function that flushes pending spans, for index.js's graceful shutdown.
 *
 * @param {{ endpoint?: string, serviceName?: string, version?: string }} options
 * @returns {() => Promise<void>}
 */
export function startTracing({ endpoint, serviceName = "clausecheck-api", version } = {}) {
  if (!endpoint) return async () => {};
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": serviceName,
      ...(version ? { "service.version": version } : {}),
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  logger.info({ tracing: { exporter: "otlp-http" } }, "tracing enabled");
  return () => provider.shutdown();
}
