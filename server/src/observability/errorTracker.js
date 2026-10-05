import * as Sentry from "@sentry/node";

/**
 * BUILD-PLAN step 74 / SRS §6.5, §8 / TR-16: error tracking (Sentry), built
 * so that a document's text cannot reach it. PRD §14.3 counts an
 * unscrubbed exception carrying document text that reaches a third party
 * as a Sev-1: it is the one failure the confidentiality promise cannot
 * survive. Off unless SENTRY_DSN is set (Appendix B: "absent disables it
 * cleanly").
 *
 * WHAT SRS §6.5 ASKS FOR NO LONGER EXISTS AS WRITTEN. It specifies
 * `sendDefaultPii: false`. Sentry 11 (pinned here) removed that option and
 * replaced it with `dataCollection`, whose defaults COLLECT: HTTP bodies in
 * all four directions (including the outgoing request to the LLM provider,
 * which is the document), generative-AI inputs and outputs, headers,
 * cookies, query strings, database query data, and the values of local
 * variables in every stack frame. Dropping the old option without setting
 * the new one would have turned all of that on. Found when the old option
 * failed the type check.
 *
 * FOUR LAYERS, any one of which would be enough on its own:
 *
 * 1. NO AUTOMATIC COLLECTION. Sentry's default integrations are off,
 *    including the HTTP and AI instrumentations that record bodies and
 *    prompts, and so is its OpenTelemetry setup (this server has its own
 *    tracing, step 67). An event carries what reportError() attaches:
 *    method, route pattern, request id.
 *
 * 2. `dataCollection` SET TO COLLECT NOTHING, explicitly, field by field,
 *    so a future integration, or a change of defaults, collects nothing
 *    either.
 *
 * 3. beforeSend (scrubEvent) cleans every event again on its way out:
 *    request data, cookies, headers, query strings, extra data, user data,
 *    frame variables and breadcrumb data are removed from every event.
 *
 * 4. ON A SENSITIVE ROUTE, EXCEPTION MESSAGES ARE WITHHELD TOO. A body is
 *    not the only way document text gets into an error: a Prisma
 *    validation error prints the query it rejected, data and all, and
 *    creating a Document puts its rawText in that query. The type and the
 *    stack trace are kept, because they are what a fix needs. "Sensitive"
 *    is SRS §6.5's /api/v1/documents* AND /api/v1/account*, because the
 *    account export returns every document the user has.
 *
 * tests/unit/errorTracker.test.js checks scrubEvent; and
 * tests/integration/errorTracking.test.js runs a real failing upload
 * through the real SDK into a recording transport and requires that the
 * document's text appears nowhere in what would have been sent.
 */

/** Routes whose requests or responses carry document text. */
export const SENSITIVE_ROUTE = /^\/api\/v1\/(?:documents|account)(?:[/?]|$)/;

export const WITHHELD =
  "[message withheld: on this route an error message may quote a document]";

/** Collect nothing the SDK could collect on its own (Sentry 11's dataCollection). */
export const DATA_COLLECTION = Object.freeze({
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
});

/**
 * @template {{ data?: unknown, message?: string }} T
 * @param {T} crumb
 * @returns {Omit<T, "data" | "message">}
 */
function withoutContent(crumb) {
  const copy = { ...crumb };
  delete copy.data;
  delete copy.message;
  return copy;
}

/**
 * @param {import("@sentry/node").ErrorEvent} event
 * @returns {import("@sentry/node").ErrorEvent}
 */
export function scrubEvent(event) {
  const sensitive =
    event.tags?.sensitive_route === "yes" ||
    SENSITIVE_ROUTE.test(String(event.tags?.route ?? "")) ||
    SENSITIVE_ROUTE.test(
      String(event.request?.url ?? "").replace(/^https?:\/\/[^/]+/, ""),
    );

  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    delete event.request.env;
    // The path can carry a document id and nothing worse; a query string
    // could carry anything.
    if (event.request.url) event.request.url = event.request.url.split("?")[0];
  }
  delete event.extra;
  delete event.user;
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(withoutContent);
  for (const value of event.exception?.values ?? []) {
    for (const frame of value.stacktrace?.frames ?? []) delete frame.vars;
    if (sensitive) value.value = WITHHELD;
  }
  if (sensitive && event.message) event.message = WITHHELD;
  return event;
}

let enabled = false;

/**
 * @param {{ dsn?: string, environment?: string, release?: string, transport?: import("@sentry/node").NodeOptions["transport"] }} options
 * @returns {boolean} whether error tracking is on
 */
export function startErrorTracking({ dsn, environment, release, transport }) {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment,
    release,
    dataCollection: DATA_COLLECTION,
    defaultIntegrations: false,
    integrations: [
      Sentry.linkedErrorsIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    // No OpenTelemetry provider of Sentry's own (this server runs its own,
    // step 67), and no load-time patching of modules: with no integration
    // listening, the hooks would only be one more thing touching Express.
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: withoutContent,
    ...(transport ? { transport } : {}),
  });
  enabled = true;
  return true;
}

/**
 * The one way the application reports an error: the error, and the
 * request's method, route pattern and id. Nothing else about the request.
 * `path` is used only to decide whether the route is sensitive, which
 * matters when the error happened before a route matched and the pattern
 * is "unmatched"; the path itself is not sent.
 *
 * @param {unknown} err
 * @param {{ method: string, route: string, path: string, requestId?: string }} request
 */
export function reportError(err, { method, route, path, requestId }) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag("route", route);
    scope.setTag("method", method);
    scope.setTag(
      "sensitive_route",
      SENSITIVE_ROUTE.test(path) || SENSITIVE_ROUTE.test(route) ? "yes" : "no",
    );
    if (requestId) scope.setTag("request_id", requestId);
    Sentry.captureException(err);
  });
}

/** @param {number} [timeoutMs] */
export async function stopErrorTracking(timeoutMs = 2_000) {
  if (!enabled) return;
  enabled = false;
  await Sentry.close(timeoutMs);
}
