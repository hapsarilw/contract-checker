/**
 * BUILD-PLAN step 31 — the one place that calls `window.location`.
 *
 * A real, whole-page navigation rather than client-side routing: no
 * router exists yet (BUILD-PLAN step 39, "Routing, guards, and the
 * shell," comes after every individual screen is built) and a session-
 * expiry redirect has a good reason to want a real navigation anyway —
 * it should not leave any of the expired session's in-memory state
 * around for a router to hand off to the next screen.
 *
 * Kept in its own module, one line of substance, so callers (api/client.js
 * today) can be tested with `vi.mock("../../src/lib/navigate.js")`
 * instead of fighting jsdom's "Not implemented: navigation" error, which
 * is what actually calling `window.location.assign` throws under jsdom.
 */
export function navigateTo(url) {
  window.location.assign(url);
}
