import { describe, expect, it, vi } from "vitest";

/**
 * The one path of step 73's extraction semaphore the integration tests
 * cannot reach safely: `new Worker()` throwing synchronously, which it
 * can when the process is short of memory or threads. No worker means no
 * "exit" event, so without its own release the slot would be gone for the
 * life of the process, and after MAX_CONCURRENT_EXTRACTIONS such failures
 * every upload would wait for ever.
 */
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      throw new Error("ERR_WORKER_INIT_FAILED (simulated)");
    }
  },
}));

const { extractInWorker, extractionSlots } =
  await import("../../src/services/extractionWorker.js");

describe("extraction semaphore: a worker that cannot be created", () => {
  it("rejects with 422 and gives the slot back, every time", async () => {
    const max = extractionSlots().max;
    for (let i = 0; i < max + 2; i += 1) {
      await expect(
        extractInWorker(Buffer.from("%PDF"), "UPLOAD_PDF"),
      ).rejects.toMatchObject({
        code: "MALFORMED_DOCUMENT",
      });
      expect(extractionSlots()).toMatchObject({ running: 0, waiting: 0 });
    }
  });
});
