/**
 * Walks a live Express app's router stack and returns every registered
 * route as `"METHOD /path"` (method upper-cased, path in Express's own
 * `:param` form).
 *
 * Originally local to tests/integration/csrf.test.js (FR-1.12(d)'s GET
 * audit, filtered to GET/HEAD only); extracted here once
 * tests/unit/openapi.test.js (step 59) needed the same walk over EVERY
 * method. Two independent copies of a non-trivial Express-internals walk
 * is itself a drift risk — the exact failure this step's own contract
 * test exists to catch elsewhere — so this is the one copy both files
 * import.
 */

/**
 * Express stores a mounted router's prefix as a regexp
 * (`/^\/api\/v1\/auth\/?(?=\/|$)/i`); this recovers the literal path.
 *
 * @param {any} layer
 */
function decodeMount(layer) {
  if (layer.path) return layer.path;
  const source = layer.regexp?.source;
  if (!source || source === "^\\/?(?=\\/|$)") return "";
  const match = source.match(/^\^((?:\\\/[^\\?(]+)+)/);
  return match ? match[1].replace(/\\\//g, "/") : "";
}

/**
 * @param {import("express").Express} expressApp
 * @returns {string[]} e.g. ["GET /api/v1/documents", "POST /api/v1/documents", ...]
 */
export function registeredRoutes(expressApp) {
  const routes = [];
  const walk = (stack, prefix = "") => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, prefix + decodeMount(layer));
      }
    }
  };
  walk(expressApp._router?.stack ?? expressApp.router?.stack ?? []);
  return routes;
}
