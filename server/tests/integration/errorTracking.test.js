import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import * as Sentry from "@sentry/node";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { createUser } from "./factories.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import {
  startErrorTracking,
  stopErrorTracking,
} from "../../src/observability/errorTracker.js";

/**
 * BUILD-PLAN step 74's "error tracker proven to scrub bodies before
 * production use", against the REAL SDK: Sentry initialised the way
 * index.js does it, with a transport that records every envelope instead
 * of sending it. A paste fails with a 500 whose error message quotes the
 * document (the shape of a Prisma validation error, which prints the data
 * it rejected), and the document's text must appear NOWHERE in what would
 * have left the server: not in the body, not in the message, not anywhere.
 *
 * The failure is injected on the shared Prisma client rather than by
 * mocking a module: setup.js has loaded the app, and every module it
 * imports, before this file runs, so a vi.mock here would never be seen.
 */

const MARKER = "SECRET-CLAUSE-7f3a9 the Client shall pay within ninety days";

/** @type {string[]} */
const sent = [];

beforeAll(() => {
  startErrorTracking({
    dsn: "https://publickey@o0.ingest.sentry.io/0",
    environment: "test",
    release: "test",
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
});

afterAll(async () => {
  await stopErrorTracking();
});

async function signedIn() {
  const user = await createUser();
  return `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
}

describe("error tracking never carries a document", () => {
  it("a 500 on the upload route reaches the tracker, with no trace of the document", async () => {
    const cookie = await signedIn();
    const text = `${MARKER}. `.repeat(40);
    // What PrismaClientValidationError does: quote the data it rejected.
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      new Error(
        `Invalid prisma.document.create() invocation: { data: { rawText: "${text.slice(0, 200)}" } }`,
      ),
    );
    const res = await request(testServer())
      .post("/api/v1/documents?ref=SECRET-QUERY-55")
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({ text });
    expect(res.status).toBe(500);

    await Sentry.flush(2_000);
    const envelope = sent.join("\n");
    // It was reported: an empty transport would pass everything below.
    expect(sent.length).toBeGreaterThan(0);
    expect(envelope).toContain('"route":"/api/v1/documents"');
    expect(envelope).toContain('"sensitive_route":"yes"');
    expect(envelope).toContain('"type":"Error"');
    // And it carries nothing of the document, the query, or the session.
    expect(envelope).not.toContain("SECRET-CLAUSE");
    expect(envelope).not.toContain("ninety days");
    expect(envelope).not.toContain("SECRET-QUERY");
    expect(envelope).not.toContain(cookie.split("=")[1]);
    expect(envelope).not.toContain(SESSION_COOKIE_NAME);
  });

  it("a 4xx is not an error to track at all", async () => {
    const before = sent.length;
    const res = await request(testServer()).get("/api/v1/documents"); // no session: 401
    expect(res.status).toBe(401);
    await Sentry.flush(2_000);
    expect(sent.length).toBe(before);
  });
});

describe("the route label a failure is recorded under (step 67's metric, fixed in step 74)", () => {
  it("a 500 on POST /api/v1/documents is counted under that route, not under /", async () => {
    const { default: config } = await import("../../src/config.js");
    const cookie = await signedIn();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("boom"));
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({ text: "word ".repeat(300) });
    expect(res.status).toBe(500);
    const metrics = await request(testServer())
      .get("/metrics")
      .set("Authorization", `Bearer ${config.METRICS_TOKEN}`);
    expect(metrics.text).toMatch(
      /http_request_duration_seconds_count\{route="\/api\/v1\/documents",method="POST",status="500"\} \d/,
    );
    expect(metrics.text).not.toMatch(/route="\/",method="POST",status="500"/);
  });
});
