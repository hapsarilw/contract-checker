import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { requestIdMiddleware } from "../../src/middleware/requestId.js";
import { AppError } from "../../src/lib/AppError.js";
import { ERROR_CODES } from "../../src/lib/errorCodes.js";

function mockRes() {
  const res = {
    statusCode: /** @type {number | undefined} */ (undefined),
    headers: /** @type {Record<string, string>} */ ({}),
    // Loosely typed on purpose: this is a test double whose whole point
    // is to capture whatever errorHandler passes to res.json(), so the
    // assertions below can inspect it freely.
    body: /** @type {any} */ (undefined),
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
    setHeader(name, value) {
      res.headers[name] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

// Runs `fn` inside an established request-correlation context, mirroring
// how errorHandler actually runs in the app (requestIdMiddleware mounted
// first, per step 6).
function withRequestContext(fn) {
  const req = { headers: {} };
  const res = mockRes();
  let result;
  requestIdMiddleware(req, res, () => {
    result = fn(req, res);
  });
  return { req, res, result };
}

describe("errorHandler (SRS §4, NFR-3.2)", () => {
  it("returns the exact { error: { code, message, requestId } } shape for an AppError", () => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError("NOT_FOUND"), req, res, vi.fn());
    });

    expect(res.statusCode).toBe(404);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(Object.keys(res.body.error).sort()).toEqual(["code", "message", "requestId"]);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toBe(ERROR_CODES.NOT_FOUND.message);
    expect(res.body.error.requestId).toBeTypeOf("string");
  });

  it.each(Object.entries(ERROR_CODES))("maps AppError(%s) to status %i", (code, entry) => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError(/** @type {keyof typeof ERROR_CODES} */ (code)), req, res, vi.fn());
    });
    expect(res.statusCode).toBe(entry.status);
    expect(res.body.error.code).toBe(code);
  });

  it("maps an unrecognised error to 500 INTERNAL with no detail leaked", () => {
    const secretDetail = "TypeError: cannot read property 'x' of undefined at /app/src/secret-path.js:42";
    const { res } = withRequestContext((req, res) => {
      errorHandler(new Error(secretDetail), req, res, vi.fn());
    });

    expect(res.statusCode).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL");
    expect(res.body.error.message).toBe(ERROR_CODES.INTERNAL.message);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(secretDetail);
    expect(serialized).not.toContain("secret-path.js");
    expect(serialized).not.toContain("stack");
  });

  it("never includes a stack trace in the response body, even for an AppError", () => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError("INTERNAL"), req, res, vi.fn());
    });
    expect(JSON.stringify(res.body)).not.toContain("stack");
    expect(res.body.error).not.toHaveProperty("stack");
  });

  it("never includes AppError.details in the response body", () => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(
        new AppError("VALIDATION_ERROR", { details: { secretInternalField: "leak-me-not" } }),
        req,
        res,
        vi.fn(),
      );
    });
    expect(JSON.stringify(res.body)).not.toContain("leak-me-not");
    expect(res.body.error).not.toHaveProperty("details");
  });

  it.each(
    /** @type {[keyof typeof ERROR_CODES, { status: number, retryAfter?: number }][]} */ (
      Object.entries(ERROR_CODES).filter(([, entry]) => entry.status === 503)
    ),
  )("attaches Retry-After for %s", (code, entry) => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError(code), req, res, vi.fn());
    });
    expect(res.headers["Retry-After"]).toBe(String(entry.retryAfter));
  });

  it("honors an explicit retryAfter override on the Retry-After header", () => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError("SERVER_BUSY", { retryAfter: 2 }), req, res, vi.fn());
    });
    expect(res.headers["Retry-After"]).toBe("2");
  });

  it("does not attach Retry-After for a non-503 status", () => {
    const { res } = withRequestContext((req, res) => {
      errorHandler(new AppError("NOT_FOUND"), req, res, vi.fn());
    });
    expect(res.headers["Retry-After"]).toBeUndefined();
  });

  it("always includes the requestId from the request-correlation context", () => {
    const req = { headers: { "x-request-id": "known-request-id-123" } };
    const res = mockRes();
    requestIdMiddleware(req, res, () => {
      errorHandler(new AppError("INTERNAL"), req, res, vi.fn());
    });
    expect(res.body.error.requestId).toBe("known-request-id-123");
  });
});
