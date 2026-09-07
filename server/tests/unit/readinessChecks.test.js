import { describe, it, expect, vi, afterEach } from "vitest";
import { checkPostgres, checkRedis } from "../../src/lib/readinessChecks.js";
import prisma from "../../src/lib/prisma.js";

describe("checkPostgres (FR-4.7)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ok: true when the query succeeds", async () => {
    vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);
    expect(await checkPostgres()).toEqual({ ok: true });
  });

  it("surfaces err.code over the generic boilerplate message when both are present", async () => {
    // Mirrors what Prisma's driver adapter actually throws on a refused
    // connection — verified directly against a real unreachable Postgres:
    // a generic "Invalid `prisma.$queryRaw()` invocation:" message with
    // no further detail, and the useful part on `.code` instead.
    const prismaStyleError = new Error("\nInvalid `prisma.$queryRaw()` invocation:\n\n\n");
    // @ts-expect-error — attaching a non-standard field, same as Prisma does
    prismaStyleError.code = "ECONNREFUSED";
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(prismaStyleError);

    expect(await checkPostgres()).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  it("falls back to the plain message when there is no code", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));
    expect(await checkPostgres()).toEqual({ ok: false, error: "connection refused" });
  });
});

describe("checkRedis (stubbed until step 44)", () => {
  it("always reports ok — not wired into the request path yet", async () => {
    expect(await checkRedis()).toEqual({ ok: true });
  });
});
