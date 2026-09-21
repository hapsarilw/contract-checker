import app from "../../src/app.js";

/**
 * ONE HTTP server for the whole test file, instead of one per request.
 *
 * WHY THIS EXISTS. `request(app)` hands supertest an Express app, and
 * supertest responds by creating a FRESH `http.Server` on an ephemeral
 * port for every single request, then closing it. Across an integration
 * run that is thousands of bind/close cycles, and at that rate a response
 * occasionally arrives at a client that did not ask for it.
 *
 * Measured rather than theorised, with 4,000 concurrent requests split
 * between `/api/health` (200) and an unrouted path (404), each response
 * checked against the request that asked for it:
 *
 *   server per request   2 mismatches in 4,000  — /api/health got a 404,
 *                                                 and another got a 400
 *   one shared server    0 in 8,000 (two runs)
 *
 * That roughly 1-in-2,000 rate is exactly the shape of the flake that had
 * been failing about one integration run in five, with a different test
 * each time: a limiter that "did not count", a route that answered 404, a
 * single-use token that appeared to work twice, and one honest `Error:
 * socket hang up`. All four are the same event — a response landing on
 * the wrong request — wearing different clothes.
 *
 * The server is started and stopped by tests/integration/setup.js, so
 * every file gets exactly one and nothing has to remember to clean up.
 */

/** @type {import("node:http").Server | undefined} */
let server;

export async function startTestServer() {
  if (server) return server;
  server = app.listen(0);
  // Awaited, because supertest inspects `server.address()` and would
  // start a SECOND server on the same object if the bind had not landed.
  await new Promise((resolve, reject) => {
    server?.once("listening", resolve);
    server?.once("error", reject);
  });
  return server;
}

export async function stopTestServer() {
  if (!server) return;
  const closing = server;
  server = undefined;
  await new Promise((resolve) => closing.close(() => resolve(undefined)));
}

/** The listening server, for `request(testServer())`. */
export function testServer() {
  if (!server) {
    throw new Error("test server not started — tests/integration/setup.js should have done it");
  }
  return server;
}
