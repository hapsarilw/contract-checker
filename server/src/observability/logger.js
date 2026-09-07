import pino from "pino";
import config from "../config.js";
import { getRequestId } from "../middleware/requestId.js";

/**
 * SRS §6.5 — the never-logged list, made enforceable rather than
 * aspirational (FR-2.7, NFR-2.7, TR-16).
 *
 * pino's redaction is PATH-based (via fast-redact), not field-name-based:
 * it matches an exact shape, not "any key called rawText anywhere in the
 * object." A path of `document.rawText` does nothing if a call site logs
 * `{ payload: { document: { rawText } } }` instead — the redaction fails
 * silently, with no error, and the text ships to stdout.
 *
 * The convention this file enforces: log payloads that carry
 * document-derived, request, or email data MUST nest it under exactly
 * one of the top-level keys below, at exactly this depth. Do not wrap
 * them in another object.
 *
 *   logger.info({ document: { id, wordCount } }, "document created");
 *   logger.warn({ req: { headers: req.headers } }, "rejected upload");
 *   logger.error({ err, email: { to } }, "send failed");
 *
 * A `document`, `req`, or `email` key nested any deeper than top-level
 * defeats redaction. If a call site cannot conform to this shape, redact
 * the field by hand before logging rather than relying on the path list.
 */
export const REDACTED_PATHS = [
  // Document text and everything derived from it (FR-2.7, NFR-2.7).
  "document.rawText",
  "document.text",
  "document.excerpt",
  "document.excerpts[*]",
  "document.summary",
  "document.summaries[*]",
  "document.suggestedChange",
  "document.suggestedChanges[*]",
  "document.filename",
  "document.findings[*].excerpt",
  "document.findings[*].suggestedChange",

  // Email — the never-logged list singles out addresses in message
  // bodies; blanket-redacting the whole body is the simpler and
  // strictly safer reading of that rule.
  "email.body",
  "email.address",

  // Credentials and secrets.
  "password",
  "token",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",

  // Full request bodies are never logged, not just on document routes —
  // a blanket ban is simpler to reason about and strictly safer than a
  // route-conditional one.
  "req.body",
];

const REDACTION_CENSOR = "[Redacted]";

export const redactConfig = Object.freeze({
  paths: REDACTED_PATHS,
  censor: REDACTION_CENSOR,
});

/**
 * Injects the current request's correlation id (SRS §6.5) into every log
 * line without threading it through every call signature. Exported
 * separately so a test-scoped logger can reuse the exact same behavior.
 */
export function requestIdMixin() {
  const requestId = getRequestId();
  return requestId ? { requestId } : {};
}

const logger = pino({
  level: config.LOG_LEVEL,
  redact: redactConfig,
  mixin: requestIdMixin,
  timestamp: pino.stdTimeFunctions.isoTime,
  // Structured error serialization (type, message, stack, cause) under the
  // canonical `err` key. NFR-3.2: stack traces are logged server-side —
  // this is where — and never returned to a client response.
  serializers: { err: pino.stdSerializers.err },
});

export default logger;
