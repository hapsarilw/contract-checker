import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { register } from "prom-client";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";
import { countWords } from "../../src/services/extraction.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createDocument, createUser } from "./factories.js";

/**
 * BUILD-PLAN step 75: a database outage is a STATED 503, through the real
 * routes. The error thrown here has the shape measured against a real
 * Postgres that was stopped under the app (lib/databaseErrors.js): Prisma's
 * P1001 with the pg adapter's DatabaseNotReachable. The end-to-end version,
 * with Postgres really stopped and the alerts watched, is the database
 * outage drill (ops/drills/provider-outage, FAULT=database).
 */

const CONTRACT = [
  "MASTER SERVICES AGREEMENT",
  "1. Fees. Client shall pay each invoice within thirty (30) days.",
  "2. Term. Either party may terminate on thirty (30) days' notice.",
].join("\n\n");

const unreachable = () =>
  Object.assign(new Error("Can't reach database server at db.internal:5432"), {
    name: "PrismaClientKnownRequestError",
    code: "P1001",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { kind: "DatabaseNotReachable", host: "db.internal", port: 5432 },
      },
    },
  });

/** @param {string} name @param {Record<string, string>} labels */
async function counterValue(name, labels) {
  const metric = /** @type {import("prom-client").Metric} */ (
    register.getSingleMetric(name)
  );
  const { values } = await metric.get();
  return values
    .filter((v) => Object.entries(labels).every(([key, want]) => v.labels[key] === want))
    .reduce((total, v) => total + v.value, 0);
}

async function signedIn() {
  const user = await createUser();
  const document = await createDocument({
    userId: user.id,
    rawText: CONTRACT,
    wordCount: countWords(CONTRACT),
  });
  const cookie = `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
  return { user, document, cookie };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a database outage is a stated 503 (step 75)", () => {
  it("a read answers 503 DATABASE_UNAVAILABLE with Retry-After and the nothing-lost message", async () => {
    const { cookie } = await signedIn();
    vi.spyOn(prisma.document, "findMany").mockRejectedValue(unreachable());

    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DATABASE_UNAVAILABLE");
    expect(res.body.error.message).toBe(ERROR_CODES.DATABASE_UNAVAILABLE.message);
    expect(res.headers["retry-after"]).toBe("30");
    expect(JSON.stringify(res.body)).not.toContain("db.internal");
  });

  it("an analysis whose database goes away before it is saved fails as DATABASE_UNAVAILABLE, and is counted so", async () => {
    const { document, cookie } = await signedIn();
    const before = await counterValue("analysis_total", {
      outcome: "failed",
      error_code: "DATABASE_UNAVAILABLE",
    });
    // The provider answers; the database is gone by the time the report
    // would be written, and still gone for the FAILED update after it.
    vi.spyOn(prisma, "$transaction").mockRejectedValue(unreachable());
    vi.spyOn(prisma.analysis, "update").mockRejectedValue(unreachable());

    const res = await request(testServer())
      .post(`/api/v1/documents/${document.id}/analyze`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("DATABASE_UNAVAILABLE");
    expect(res.headers["retry-after"]).toBe("30");
    // analysis_failure_rate's first query names the cause, not INTERNAL.
    await expect(
      counterValue("analysis_total", {
        outcome: "failed",
        error_code: "DATABASE_UNAVAILABLE",
      }),
    ).resolves.toBe(before + 1);
  });

  it("an ordinary defect is still INTERNAL: only the database being unreachable is stated as such", async () => {
    const { cookie } = await signedIn();
    vi.spyOn(prisma.document, "findMany").mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
  });
});
