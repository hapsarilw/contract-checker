import { describe, expect, it } from "vitest";
import { isDatabaseUnavailable } from "../../src/lib/databaseErrors.js";

/**
 * Step 75: which errors mean "the database is unavailable for the moment".
 * The first shape is the one measured against a real Postgres, stopped
 * under a live connection and refused on a dead port; the rest are the
 * pg adapter's other names for the same condition.
 */

/** @param {string} kind @param {string} [code] */
const prismaError = (kind, code = "P1001") =>
  Object.assign(new Error("Can't reach database server at 127.0.0.1:5432"), {
    name: "PrismaClientKnownRequestError",
    code,
    meta: {
      modelName: "User",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: { kind, host: "127.0.0.1", port: 5432 },
      },
    },
  });

describe("isDatabaseUnavailable", () => {
  it("is true for the measured shape: P1001, DatabaseNotReachable", () => {
    expect(isDatabaseUnavailable(prismaError("DatabaseNotReachable"))).toBe(true);
  });

  it.each(["ConnectionClosed", "SocketTimeout", "TooManyConnections"])(
    "is true for the adapter's %s, whatever the code",
    (kind) => {
      expect(isDatabaseUnavailable(prismaError(kind, "P2010"))).toBe(true);
    },
  );

  it.each(["P1001", "P1002", "P1008", "P1017", "P2024"])(
    "is true for Prisma's %s",
    (code) => {
      expect(isDatabaseUnavailable(Object.assign(new Error("x"), { code }))).toBe(true);
    },
  );

  it.each(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"])(
    "is true for a Prisma error carrying the socket's %s, the shape the drill met first",
    (code) => {
      // Logged in the database outage drill: the first request after
      // Postgres stopped, before the adapter's own mapping took over.
      const err = Object.assign(new Error("getaddrinfo EAI_AGAIN postgres"), {
        name: "PrismaClientKnownRequestError",
        code,
        meta: { modelName: "User" },
      });
      expect(isDatabaseUnavailable(err)).toBe(true);
    },
  );

  it("is FALSE for the same network code on an error that is not Prisma's (Redis, the email provider)", () => {
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      ),
    ).toBe(false);
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("x"), { name: "ReplyError", code: "ECONNRESET" }),
      ),
    ).toBe(false);
  });

  it("is true for a client that never initialised", () => {
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("x"), { name: "PrismaClientInitializationError" }),
      ),
    ).toBe(true);
  });

  it.each(["AuthenticationFailed", "DatabaseAccessDenied", "TlsConnectionError"])(
    "is FALSE for %s: a configuration defect, which waiting does not fix",
    (kind) => {
      expect(isDatabaseUnavailable(prismaError(kind, "P2010"))).toBe(false);
    },
  );

  it("is false for an ordinary query error, a bug, and non-errors", () => {
    expect(
      isDatabaseUnavailable(
        Object.assign(new Error("Unique constraint"), { code: "P2002" }),
      ),
    ).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("cannot read x of undefined"))).toBe(
      false,
    );
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable("P1001")).toBe(false);
  });
});
