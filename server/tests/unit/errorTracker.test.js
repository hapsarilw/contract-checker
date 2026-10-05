import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DATA_COLLECTION,
  SENSITIVE_ROUTE,
  WITHHELD,
  scrubEvent,
} from "../../src/observability/errorTracker.js";

/**
 * TR-16's error-tracking half (BUILD-PLAN step 74): scrubEvent, the
 * beforeSend hook, on events shaped like the ones Sentry builds; and the
 * dataCollection settings, against the SDK's own type definition so an
 * upgrade that adds a new collecting field cannot slip past.
 */

/** @param {Record<string, unknown>} [over] */
const event = (over = {}) =>
  /** @type {any} */ ({
    exception: {
      values: [
        {
          type: "PrismaClientValidationError",
          value: "Invalid invocation: data: { rawText: 'CONFIDENTIAL CLAUSE TEXT' }",
          stacktrace: {
            frames: [
              {
                function: "createDocument",
                vars: { rawText: "CONFIDENTIAL CLAUSE TEXT" },
              },
            ],
          },
        },
      ],
    },
    request: {
      url: "https://api.example.com/api/v1/documents?draft=CONFIDENTIAL",
      method: "POST",
      data: { text: "CONFIDENTIAL CLAUSE TEXT" },
      cookies: { clausecheck_token: "session" },
      headers: { cookie: "clausecheck_token=session", authorization: "Bearer x" },
      query_string: "draft=CONFIDENTIAL",
    },
    extra: { body: "CONFIDENTIAL CLAUSE TEXT" },
    user: { email: "person@example.com", ip_address: "203.0.113.9" },
    breadcrumbs: [
      {
        category: "console",
        message: "CONFIDENTIAL CLAUSE TEXT",
        data: { arguments: ["CONFIDENTIAL"] },
      },
    ],
    tags: { route: "/api/v1/documents", method: "POST" },
    ...over,
  });

describe("scrubEvent", () => {
  it("removes everything about the request but its method and path, on any route", () => {
    for (const route of ["/api/v1/documents", "/api/health"]) {
      const out = /** @type {any} */ (scrubEvent(event({ tags: { route } })));
      expect(out.request).toEqual({
        url: "https://api.example.com/api/v1/documents",
        method: "POST",
      });
      expect(out.extra).toBeUndefined();
      expect(out.user).toBeUndefined();
      expect(out.breadcrumbs).toEqual([{ category: "console" }]);
      expect(out.exception.values[0].stacktrace.frames[0].vars).toBeUndefined();
    }
  });

  it("withholds the exception message on a document route, and keeps the type and stack", () => {
    const out = /** @type {any} */ (scrubEvent(event()));
    expect(out.exception.values[0].value).toBe(WITHHELD);
    expect(out.exception.values[0].type).toBe("PrismaClientValidationError");
    expect(out.exception.values[0].stacktrace.frames[0].function).toBe("createDocument");
    expect(JSON.stringify(out)).not.toContain("CONFIDENTIAL");
  });

  it("treats the account routes as sensitive too: the export returns every document", () => {
    const out = /** @type {any} */ (
      scrubEvent(event({ tags: { route: "/api/v1/account/export" } }))
    );
    expect(out.exception.values[0].value).toBe(WITHHELD);
  });

  it("withholds when the error came before routing, by the path the reporter classified", () => {
    const out = /** @type {any} */ (
      scrubEvent(
        event({
          tags: { route: "unmatched", sensitive_route: "yes" },
          request: undefined,
        }),
      )
    );
    expect(out.exception.values[0].value).toBe(WITHHELD);
  });

  it("keeps the message on a route that never carries a document", () => {
    const out = /** @type {any} */ (
      scrubEvent(event({ tags: { route: "/api/health" }, request: undefined }))
    );
    expect(out.exception.values[0].value).toMatch(/^Invalid invocation/);
  });

  it("classifies the routes SRS §6.5 names, and no others", () => {
    for (const path of [
      "/api/v1/documents",
      "/api/v1/documents/abc/analyze",
      "/api/v1/account",
      "/api/v1/account/export",
    ]) {
      expect(SENSITIVE_ROUTE.test(path), path).toBe(true);
    }
    for (const path of ["/api/v1/auth/login", "/api/health", "/api/v1/documentsX"]) {
      expect(SENSITIVE_ROUTE.test(path), path).toBe(false);
    }
  });
});

describe("dataCollection: nothing, field by field", () => {
  it("covers every field the installed SDK defines, so a new default cannot collect unnoticed", () => {
    const require = createRequire(import.meta.url);
    const core = dirname(require.resolve("@sentry/core/package.json"));
    const dts = readFileSync(
      join(core, "build", "types", "types", "datacollection.d.ts"),
      "utf8",
    );
    const body = dts.slice(
      dts.indexOf("export interface DataCollection"),
      dts.indexOf("}\n/**\n * Fully resolved"),
    );
    const fields = [...body.matchAll(/^ {4}(\w+)\?:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(5);
    // Source lines around a frame are this repository's own code, which is
    // public; everything else must be explicitly off.
    const missing = fields.filter(
      (f) => f !== "frameContextLines" && !(f in DATA_COLLECTION),
    );
    expect(missing).toEqual([]);
  });

  it("turns every collector off", () => {
    expect(DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    });
  });
});

describe("reportError: an error before any route matched", () => {
  it("is classified by its path, so a document route still has its message withheld", async () => {
    const Sentry = await import("@sentry/node");
    const { startErrorTracking, reportError, stopErrorTracking } =
      await import("../../src/observability/errorTracker.js");
    /** @type {string[]} */
    const sent = [];
    startErrorTracking({
      dsn: "https://publickey@o0.ingest.sentry.io/0",
      transport: (options) =>
        Sentry.createTransport(options, async (req) => {
          sent.push(
            typeof req.body === "string"
              ? req.body
              : Buffer.from(req.body).toString("utf8"),
          );
          return { statusCode: 200 };
        }),
    });
    try {
      reportError(new Error("rawText: CONFIDENTIAL-BEFORE-ROUTING"), {
        method: "POST",
        route: "unmatched",
        path: "/api/v1/documents",
      });
      await Sentry.flush(2_000);
    } finally {
      await stopErrorTracking();
    }
    const envelope = sent.join("\n");
    expect(envelope).toContain('"sensitive_route":"yes"');
    expect(envelope).toContain(WITHHELD.slice(0, 30));
    expect(envelope).not.toContain("CONFIDENTIAL-BEFORE-ROUTING");
  });
});
