import config from "../config.js";
import { AppError } from "../lib/AppError.js";

/**
 * FR-1.12 — the CSRF stance, in full, because it is a reasoned position
 * rather than a library choice and the reasoning has to survive contact
 * with whoever changes this next.
 *
 * Cookie authentication combined with a credentialed CORS policy
 * requires an explicit stance. All of the following shall hold:
 *
 *   (a) the session cookie is SameSite=Lax, which blocks cross-site
 *       form POSTs;
 *   (b) CORS allows exactly FRONTEND_ORIGIN, never a wildcard, never a
 *       reflected Origin;
 *   (c) every state-changing endpoint requires Content-Type
 *       application/json or multipart/form-data AND rejects requests
 *       whose Origin header is present and not the allowed origin;
 *   (d) GET endpoints are side-effect free.
 *
 * A token-based CSRF defence is not required given (a)-(c). This file
 * implements (c). (a) lives in services/auth.js's cookie options, (b) in
 * app.js's cors() call, and (d) is enforced by an audit test that lists
 * every registered GET route against a reviewed allowlist.
 *
 * ⚠ CHANGING SameSite=Lax TO SameSite=None BREAKS THIS DEFENCE.
 * Clause (a) is what stops a cross-site form POST from carrying the
 * session cookie at all; the checks below are the second layer, not the
 * first. Whoever makes that change is making a security decision and
 * needs to add a token-based defence in the same commit — which is
 * exactly why FR-1.12 records the reasoning instead of only the rules.
 *
 * WHY THESE TWO CONTENT TYPES, given a cross-site form CAN send
 * multipart/form-data: an HTML form can only produce three encodings —
 * application/x-www-form-urlencoded, multipart/form-data, and
 * text/plain. Allowing only application/json and multipart/form-data
 * blocks the first and third outright. multipart stays allowed because
 * file upload needs it (FR-2.1), and it is covered instead by clause (a)
 * — the cookie is not sent — and by the Origin check below when the
 * browser does send one. So the Content-Type rule is not the whole
 * defence for multipart, and removing either of the other clauses
 * reopens it.
 */

/** Methods that cannot change state, so nothing here applies to them (clause (d)). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALLOWED_CONTENT_TYPES = new Set(["application/json", "multipart/form-data"]);

/**
 * Strips parameters and casing: "application/json; charset=utf-8" is
 * application/json. A check that compared the raw header would reject
 * every browser that helpfully appends a charset.
 */
function mediaType(contentTypeHeader) {
  if (typeof contentTypeHeader !== "string") return "";
  return contentTypeHeader.split(";")[0].trim().toLowerCase();
}

export function csrfGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin;

  /**
   * An ABSENT Origin is allowed, deliberately. Browsers omit it on
   * same-origin requests in some cases, and non-browser clients (curl,
   * a server-side integration) omit it entirely — rejecting on absence
   * would break legitimate callers while stopping no attack, because the
   * attack this guards against is a BROWSER being made to send a request,
   * and browsers do send Origin on exactly those cross-site requests.
   */
  if (typeof origin === "string" && origin !== config.FRONTEND_ORIGIN) {
    next(new AppError("CSRF_CHECK_FAILED"));
    return;
  }

  if (!ALLOWED_CONTENT_TYPES.has(mediaType(req.headers["content-type"]))) {
    next(new AppError("CSRF_CHECK_FAILED"));
    return;
  }

  next();
}
