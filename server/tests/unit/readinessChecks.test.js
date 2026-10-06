import { describe, it, expect, vi, afterEach } from "vitest";
import { checkPostgres, checkRedis } from "../../src/lib/readinessChecks.js";
import { pingRedis } from "../../src/lib/redis.js";

vi.mock("../../src/lib/redis.js", () => ({ pingRedis: vi.fn() }));
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
    const prismaStyleError = new Error(
      "\nInvalid `prisma.$queryRaw()` invocation:\n\n\n",
    );
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

// checkRedis has sent a real PING since step 44, so this used to pass only
// on a machine with a Redis on localhost:6379 and fail on any other (found
// in step 75, after a restart left the development Redis stopped). The
// client is mocked, so both outcomes are tested wherever this runs.
describe("checkRedis (FR-4.7, a real PING since step 44)", () => {
  it("returns ok: true when Redis answers", async () => {
    vi.mocked(pingRedis).mockResolvedValueOnce(undefined);
    expect(await checkRedis()).toEqual({ ok: true });
  });

  it("reports the code when Redis does not answer", async () => {
    vi.mocked(pingRedis).mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), {
        code: "ECONNREFUSED",
      }),
    );
    expect(await checkRedis()).toEqual({ ok: false, error: "ECONNREFUSED" });
  });
});
