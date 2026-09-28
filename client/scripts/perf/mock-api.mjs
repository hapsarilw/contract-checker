// The API the LCP check's build talks to (see ../check-lcp.mjs): just
// enough of it for the three measured pages to render as a signed-in
// person would see them, with the same realistic content the E2E suite
// uses, so the report is measured at its real weight rather than with
// one-letter placeholders.
//
// Answers immediately. Lighthouse's simulated throttling models the
// network cost of these requests itself, from the trace; adding a real
// delay here would count it twice.

import { createServer } from "node:http";
import { ANALYSIS, DOCUMENT, HISTORY_ROW, USER } from "../../e2e/support/mockApi.js";

/** @type {Record<string, unknown>} */
const ROUTES = {
  "/api/v1/auth/me": { user: USER },
  "/api/v1/documents": {
    documents: [HISTORY_ROW],
    page: { nextCursor: null, hasMore: false },
  },
  "/api/v1/documents/doc1": { document: DOCUMENT, analysis: ANALYSIS },
};

/**
 * @param {{ port: number, allowOrigin: string }} options
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export function startMockApi({ port, allowOrigin }) {
  const server = createServer((req, res) => {
    // The client sends credentials, so CORS must name the origin exactly,
    // as the real server does.
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const body = ROUTES[path];
    if (body === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "x", requestId: "perf" } }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () =>
      resolve({ close: () => new Promise((done) => server.close(() => done())) }),
    );
  });
}
