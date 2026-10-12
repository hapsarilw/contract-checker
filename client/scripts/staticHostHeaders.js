import { DEFAULT_API_BASE_URL } from "../src/api/baseUrl.js";

/** The API route that receives violation reports (server/src/routes/cspReport.js). */
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * The static host's response headers for the built client (BUILD-PLAN step
 * 75, docs/staging-setup.md), as Netlify's `_headers` file. Generated at
 * build time, because one directive depends on the environment: FR-7.9's
 * `connect-src` is "'self' plus the API origin only", and staging and
 * production are built against different APIs (deploy.yml's
 * VITE_API_BASE_URL).
 *
 * FR-7.9 directive by directive: default-src 'self'; script-src 'self'
 * with no unsafe-inline and no unsafe-eval (Vite's output has no inline
 * script, and check-bundle-size.mjs keeps it so); connect-src 'self' and
 * the API; img-src 'self' data:; frame-ancestors 'none'; object-src 'none';
 * base-uri 'self'; form-action 'self'. No third-party origin anywhere, which
 * is PRD D11's "no third-party script on a page that can render a report",
 * enforced rather than promised.
 *
 * REPORTS (FR-7.9: "violations report to an endpoint during rollout"): to
 * the API's POST /api/csp-report, through `report-uri` ALONE. Measured on
 * 2026-10-12 with headless Chromium against a local receiver: report-uri
 * alone delivered the report at once; report-uri plus `report-to` and a
 * Reporting-Endpoints header delivered NOTHING in 70 s, because a browser
 * that understands report-to ignores report-uri and then batched or
 * dropped the Reporting API's upload. Adding the newer mechanism would
 * have lost the reports the older one delivers. Chrome, Firefox and
 * Safari all honour report-uri. (The endpoint accepts the Reporting API's
 * format as well, should the policy ever move.) The endpoint keeps only
 * the directive and URLs without their query (server/src/lib/
 * cspReports.js), since /reset-password and /verify-email carry tokens.
 * The policy is ENFORCED, not report-only: reports say what it blocked.
 *
 * @param {string | undefined} apiBaseUrl
 */
export function staticHostHeaders(apiBaseUrl) {
  // The same rule api/client.js applies: unset means the default; an empty
  // value means relative URLs, which is the page's own origin, 'self'.
  const base = apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const api = base === "" ? null : new URL(base).origin;
  const reportUrl = `${api ?? ""}${CSP_REPORT_PATH}`;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src 'self'${api ? ` ${api}` : ""}`,
    "img-src 'self' data:",
    "style-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${reportUrl}`,
  ].join("; ");
  return [
    "/*",
    `  Content-Security-Policy: ${csp}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: no-referrer",
    "  Strict-Transport-Security: max-age=31536000",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
    // No Cache-Control on "/*": Netlify merges every matching rule's headers,
    // so one here would be joined to the assets' below into a contradiction.
    // Its default already revalidates HTML, so a deploy or a rollback reaches
    // everyone on their next load. Assets are content-hashed: a cached copy
    // can never be stale.
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}
