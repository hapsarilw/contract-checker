/**
 * BUILD-PLAN step 32 — the `returnTo` query parameter both RequireAuth
 * (redirecting an unauthenticated visitor out) and the login/register
 * screens (sending a signed-in visitor back) use, factored out because
 * consuming it is the security-sensitive half.
 *
 * `returnTo` arrives in the URL, which makes it attacker-controlled: a
 * crafted link like `/login?returnTo=https://evil.example`, or
 * `/login?returnTo=//evil.example` (no scheme, but every browser treats
 * a leading `//` as protocol-relative to the current one), or
 * `/login?returnTo=/\evil.example` (a lone leading backslash — browsers
 * normalise it to a slash during URL parsing, so this ALSO becomes
 * protocol-relative; confirmed directly, `new URL("/\\evil.example",
 * "http://x")` resolves to `http://evil.example/`) — must not be able to
 * turn a successful sign-in into an open redirect.
 *
 * The safety property is what this function RETURNS, not a same-origin
 * check on what it parses:
 *   1. `value` must start with exactly one "/" before it is ever handed
 *      to `new URL()`. This is what rules out a value carrying its OWN
 *      scheme — "javascript:alert(1)", "data:...", "mailto:..." — none
 *      of which start with "/". It matters because such a scheme parses
 *      as an absolute URL in its own right, and `.pathname` for it does
 *      NOT start with "/" — `new URL("javascript:alert(1)",
 *      "http://x").pathname` is `"alert(1)"`, not `"/alert(1)"` — so
 *      without this check first, that string would reach the return
 *      statement below unchanged.
 *   2. Once something passed step 1, it can only be resolved in one of
 *      two ways: as a same-origin path against the http(s) base (safe),
 *      or — via `//`, or the backslash normalisation above — as
 *      protocol-relative, which still resolves to an http(s) URL, and
 *      `.pathname` for http(s) always starts with "/" regardless of
 *      which host it resolved to. Reconstructing ONLY
 *      `pathname + search + hash` (never `.href`) is what makes BOTH
 *      cases land back on the current origin.
 *
 * Two things an earlier version of this function got wrong, each found
 * by testing a mutation of the code rather than by reading it — the
 * checks LOOKED load-bearing and weren't:
 *   - Step 2 used to also check `resolved.origin !== window.location
 *     .origin` and return "/" on a mismatch. Deleting that comparison
 *     (`if (false)` in its place) changed nothing about what the
 *     function returned, for every case this file tests — the
 *     pathname-only reconstruction was already the reason it was safe.
 *   - Step 1 used to also reject a value starting with "//" as its own
 *     clause, redundant with step 2 for the same reason: "//evil.example"
 *     still resolves to an http(s) URL with `.pathname` "/", so step 2's
 *     reconstruction was already returning "/" for it regardless.
 *
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function sanitizeReturnTo(value) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/")) return "/";
  try {
    // A defensive fallback, not a proven-necessary one like the two
    // checks above: every "/"-leading string this file's tests throw at
    // it (including hostile bytes, a lone surrogate, a 200-KB path)
    // resolves without throwing — WHATWG URL parsing is lenient enough
    // that no failing case was found. Kept anyway, because "new URL()
    // never throws here" is not a guarantee this file can make about
    // every engine and every future input, and the failure mode of
    // being wrong about that — an uncaught exception taking down
    // whatever called this — is worse than falling back to "/".
    const resolved = new URL(value, window.location.origin);
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
