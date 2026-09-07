import { describe, it, expect, vi } from "vitest";
import { requestIdMiddleware, getRequestId } from "../../src/middleware/requestId.js";

function runMiddleware(headers = {}) {
  const req = { headers };
  const res = { setHeader: vi.fn() };
  let handlerRan = false;
  const next = () => {
    handlerRan = true;
  };
  requestIdMiddleware(req, res, next);
  return { req, res, handlerRan };
}

describe("requestId middleware (SRS §6.5 — request correlation)", () => {
  it("returns undefined outside any request context", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("generates a fresh id when no inbound X-Request-Id is present", () => {
    const { res, handlerRan } = runMiddleware({});
    expect(handlerRan).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", expect.any(String));
    const [, generatedId] = res.setHeader.mock.calls[0];
    expect(generatedId.length).toBeGreaterThan(0);
  });

  it("accepts and echoes back an inbound X-Request-Id", () => {
    const { res } = runMiddleware({ "x-request-id": "client-supplied-id-123" });
    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", "client-supplied-id-123");
  });

  it("generates a fresh id when the inbound header is empty or oversized", () => {
    const oversized = "x".repeat(200);
    const { res } = runMiddleware({ "x-request-id": oversized });
    const [, resolvedId] = res.setHeader.mock.calls[0];
    expect(resolvedId).not.toBe(oversized);
  });

  it("returns the same id from inside a nested async call", async () => {
    const req = { headers: {} };
    const res = { setHeader: vi.fn() };
    let idBeforeAwait;
    let idAfterAwait;
    let idInsideTimer;

    await new Promise((resolve) => {
      requestIdMiddleware(req, res, async () => {
        idBeforeAwait = getRequestId();
        await Promise.resolve();
        idAfterAwait = getRequestId();
        await new Promise((r) => setTimeout(r, 5));
        idInsideTimer = getRequestId();
        resolve(undefined);
      });
    });

    const [, assignedId] = res.setHeader.mock.calls[0];
    expect(idBeforeAwait).toBe(assignedId);
    expect(idAfterAwait).toBe(assignedId);
    expect(idInsideTimer).toBe(assignedId);
  });

  it("keeps concurrent requests' ids isolated from each other", async () => {
    const results = [];
    const run = (id) =>
      new Promise((resolve) => {
        requestIdMiddleware({ headers: { "x-request-id": id } }, { setHeader: vi.fn() }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 10));
          results.push(getRequestId());
          resolve(undefined);
        });
      });

    await Promise.all([run("req-a"), run("req-b"), run("req-c")]);

    expect(results.sort()).toEqual(["req-a", "req-b", "req-c"]);
  });
});
