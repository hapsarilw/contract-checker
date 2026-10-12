/**
 * FR-7.9: "Violations report to an endpoint during rollout." What a browser
 * sends, reduced to what an operator needs and nothing a user typed or was
 * mailed (BUILD-PLAN step 75).
 *
 * Two formats arrive, because browsers are mid-migration between them:
 *   - `report-uri` (application/csp-report): one object, `{ "csp-report":
 *     { "document-uri", "blocked-uri", "effective-directive", ... } }`;
 *   - the Reporting API's `report-to` (application/reports+json): an array
 *     of `{ type: "csp-violation", body: { documentURL, blockedURL,
 *     effectiveDirective, ... } }`.
 *
 * WHAT IS KEPT: the directive, the blocked resource, the page, and where in
 * the code, each reduced:
 *   - URLs lose their query and fragment. /reset-password?token=... and
 *     /verify-email?token=... carry single-use secrets in the query, and a
 *     violation on either page would otherwise write the token to the logs.
 *   - data: and blob: URLs keep only their scheme: what follows is content.
 *   - the directive is one of a known set, or "other", so the metric's
 *     label cannot be grown without bound by whoever posts here.
 * WHAT IS DROPPED: `script-sample` / `sample` (up to 40 characters of the
 * blocked code or style, which can be page content), the referrer, the
 * original policy (we wrote it), and the user agent.
 *
 * Nothing here trusts the body: any field may be missing, of another type,
 * or hostile. A body in neither shape yields no violations.
 */

/** CSP Level 3's fetch, document and navigation directives. */
const KNOWN_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "require-trusted-types-for",
  "trusted-types",
]);

/** A report body may carry many; more than this from one request is noise or abuse. */
export const MAX_VIOLATIONS_PER_REQUEST = 20;

const MAX_URL_LENGTH = 300;

/**
 * @typedef {{
 *   directive: string,
 *   blocked: string | null,
 *   document: string | null,
 *   source: string | null,
 *   line: number | null,
 *   column: number | null,
 *   disposition: "enforce" | "report" | null,
 * }} CspViolation
 */

/** @param {unknown} value */
function directiveOf(value) {
  if (typeof value !== "string") return "other";
  // violated-directive may carry the whole directive ("script-src 'self'").
  const name = value.trim().split(/\s+/)[0].toLowerCase();
  return KNOWN_DIRECTIVES.has(name) ? name : "other";
}

/**
 * A URL without the parts that can hold a secret, or a CSP keyword
 * ("inline", "eval", "wasm-eval", "trusted-types-policy") as it came.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function withoutSecrets(value) {
  if (typeof value !== "string" || value === "") return null;
  if (/^[a-z][a-z-]{0,30}$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return "unparseable";
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return url.protocol;
  return `${url.protocol}//${url.host}${url.pathname}`.slice(0, MAX_URL_LENGTH);
}

/** @param {unknown} value */
function position(value) {
  return Number.isInteger(value) && /** @type {number} */ (value) >= 0
    ? /** @type {number} */ (value)
    : null;
}

/** @param {unknown} value */
function disposition(value) {
  return value === "enforce" || value === "report" ? value : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} body the parsed request body, in either format
 * @returns {CspViolation[]}
 */
export function normalizeCspReports(body) {
  if (Array.isArray(body)) {
    return body
      .filter((r) => isObject(r) && r.type === "csp-violation" && isObject(r.body))
      .slice(0, MAX_VIOLATIONS_PER_REQUEST)
      .map(({ body: b }) => ({
        directive: directiveOf(b.effectiveDirective),
        blocked: withoutSecrets(b.blockedURL),
        document: withoutSecrets(b.documentURL),
        source: withoutSecrets(b.sourceFile),
        line: position(b.lineNumber),
        column: position(b.columnNumber),
        disposition: disposition(b.disposition),
      }));
  }
  if (isObject(body) && isObject(body["csp-report"])) {
    const r = body["csp-report"];
    return [
      {
        directive: directiveOf(r["effective-directive"] ?? r["violated-directive"]),
        blocked: withoutSecrets(r["blocked-uri"]),
        document: withoutSecrets(r["document-uri"]),
        source: withoutSecrets(r["source-file"]),
        line: position(r["line-number"]),
        column: position(r["column-number"]),
        disposition: disposition(r.disposition),
      },
    ];
  }
  return [];
}
