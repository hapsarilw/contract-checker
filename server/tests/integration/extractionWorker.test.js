import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import app from "../../src/app.js";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { extractInWorker, extractionSlots } from "../../src/services/extractionWorker.js";
import {
  uploadsInFlight,
  resetUploadConcurrencyForTests,
} from "../../src/middleware/uploadConcurrency.js";
import { createUser } from "./factories.js";
import { buildPdf } from "../helpers/hostileFiles.js";

/**
 * FR-2.11, FR-2.12 and NFR-1.4 — parsing off the main thread, bounded,
 * and a cap on how many uploads may be in flight at once.
 *
 * The assertion that matters for NFR-1.4 is not "the parse finished" but
 * "everything else kept working while it ran". A parse that blocks the
 * event loop still returns the right answer to its own request; what it
 * breaks is every other request behind it, which is invisible to a test
 * that only looks at the upload.
 */

const execFileAsync = promisify(execFile);

async function signedIn() {
  const user = await createUser();
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const upload = (cookie, buffer, filename = "contract.pdf") =>
  request(testServer())
    .post("/api/v1/documents")
    .set("Cookie", cookie)
    .attach("file", buffer, filename);

/** A contract long enough to clear the 200-word floor. */
const wordyPdf = () =>
  buildPdf({ text: Array.from({ length: 300 }, (_unused, i) => `clause${i}`).join(" ") });

afterEach(() => {
  resetUploadConcurrencyForTests();
});

describe("FR-2.11 — extraction runs in a worker, bounded to ten seconds", () => {
  it("parses a real document through the worker and returns its text", async () => {
    const pdf = await buildPdf({ text: "MASTER SERVICES AGREEMENT" });
    await expect(extractInWorker(pdf, "UPLOAD_PDF")).resolves.toContain(
      "MASTER SERVICES AGREEMENT",
    );
  }, 30_000);

  it("aborts a parse that outlives its bound with 422 MALFORMED_DOCUMENT", async () => {
    // A 50 ms bound against a real parse: the point is the timeout path,
    // not how slow a document can be made to be. Producing a genuinely
    // ten-second document would make the suite ten seconds slower for
    // the same assertion.
    const pdf = await buildPdf({ pages: 40 });
    const err = await extractInWorker(pdf, "UPLOAD_PDF", { timeoutMs: 1 }).catch(
      (e) => e,
    );

    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.status).toBe(422);
  }, 30_000);

  it("terminates the worker rather than abandoning the promise", async () => {
    // An abandoned promise leaves the parse running: CPU busy, buffer
    // resident, and under load the abandoned parses accumulate — the
    // failure the bound exists to prevent, reached by another route.
    const before = activeWorkers();
    await extractInWorker(await buildPdf({ pages: 40 }), "UPLOAD_PDF", {
      timeoutMs: 1,
    }).catch(() => {});
    // Termination is async; give the thread a tick to actually go.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(activeWorkers()).toBeLessThanOrEqual(before);
  }, 30_000);

  it("carries step 48's error codes back across the worker boundary intact", async () => {
    // An AppError cannot survive structured cloning as itself. If it were
    // not rebuilt on the parent side, ENCRYPTED_DOCUMENT would arrive as
    // an anonymous object and be reported as a 500 — undoing step 48
    // while implementing step 49.
    const locked = await buildPdf({ password: "secret" });
    const err = await extractInWorker(locked, "UPLOAD_PDF").catch((e) => e);
    expect(err.code).toBe("ENCRYPTED_DOCUMENT");
  }, 30_000);

  it("keeps the event loop responsive while a heavy parse runs (NFR-1.4)", async () => {
    const { cookie } = await signedIn();
    const heavy = await buildPdf({ pages: 120, text: "CONSULTING AGREEMENT" });

    const uploadPromise = upload(cookie, heavy);
    // /api/health makes no dependency calls by design (step 8), so a slow
    // answer here can only mean the event loop was blocked.
    const startedAt = Date.now();
    const health = await request(testServer()).get("/api/health");
    const elapsed = Date.now() - startedAt;

    expect(health.status).toBe(200);
    expect(elapsed).toBeLessThan(1_000);
    await uploadPromise;
  }, 60_000);
});

describe("FR-2.12 — concurrent uploads are capped per instance", () => {
  it("rejects beyond the cap with 503 SERVER_BUSY and Retry-After", async () => {
    const { cookie } = await signedIn();
    const pdf = await wordyPdf();

    // One more than the cap, all in flight together.
    const responses = await Promise.all(
      Array.from({ length: config.MAX_CONCURRENT_UPLOADS + 1 }, () =>
        upload(cookie, pdf),
      ),
    );

    const shed = responses.filter((res) => res.status === 503);
    expect(shed.length).toBeGreaterThanOrEqual(1);
    expect(shed[0].body.error.code).toBe("SERVER_BUSY");
    expect(shed[0].headers["retry-after"]).toBeDefined();
  }, 90_000);

  it("releases every slot afterwards, so the cap is a ceiling and not a countdown", async () => {
    const { cookie } = await signedIn();
    const pdf = await wordyPdf();

    await Promise.all(Array.from({ length: 5 }, () => upload(cookie, pdf)));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(uploadsInFlight()).toBe(0);
    // And the next upload is accepted, which is what a leaked slot would
    // eventually prevent.
    expect((await upload(cookie, pdf)).status).toBe(201);
  }, 90_000);

  it("releases the slot when a client disconnects mid-upload", async () => {
    // Released on `close`, not `finish`. `finish` fires when the response
    // has been written; `close` fires when the exchange ends for ANY
    // reason, a client that vanished included. Releasing only on finish
    // leaks a slot per abandoned upload, and ten leaks stop the instance
    // accepting uploads at all until it restarts — quiet until it is an
    // outage.
    //
    // supertest's own .abort() does NOT reproduce this: the response
    // still finishes, so the mutation "close -> finish" passed against
    // that version of this test. A real socket has to be opened and then
    // destroyed mid-body.
    const { cookie } = await signedIn();
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

    const boundary = "----clausecheckTestBoundary";
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="contract.pdf"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`;

    await new Promise((resolve) => {
      const req = httpRequest(
        {
          port,
          path: "/api/v1/documents",
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            // Promises far more than will be sent, so the server is still
            // waiting for the body when the socket goes away.
            "Content-Length": String(head.length + 500_000),
          },
        },
        () => {},
      );
      req.on("error", () => {});
      req.write(head);
      req.write("%PDF-1.4 partial");
      // Give the server time to enter the middleware and take a slot.
      setTimeout(() => {
        expect(uploadsInFlight()).toBe(1);
        req.destroy();
        setTimeout(resolve, 300);
      }, 300);
    });

    expect(uploadsInFlight()).toBe(0);
    await new Promise((resolve) => server.close(resolve));
  }, 30_000);
});

describe("the requestId survives the worker boundary", () => {
  it("appears on a log line emitted from INSIDE the worker", async () => {
    // AsyncLocalStorage does not cross into a worker thread — a worker is
    // a separate JS context with its own store — so a naive
    // implementation loses correlation at exactly the point a hanging
    // parse makes you want it. The id is passed in workerData and
    // re-established there.
    const requestId = `test-${Date.now()}`;
    const lines = await runWorkerCapturingLogs(
      await buildPdf({ text: "AGREEMENT" }),
      requestId,
    );

    const fromWorker = lines.filter((line) =>
      line.msg?.includes("extraction finished in worker"),
    );
    expect(fromWorker.length).toBeGreaterThan(0);
    expect(fromWorker[0].requestId).toBe(requestId);
  }, 30_000);

  it("is the id the HTTP request carried, end to end", async () => {
    const { cookie } = await signedIn();
    const requestId = `e2e-${Date.now()}`;

    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .set("X-Request-Id", requestId)
      .attach("file", await wordyPdf(), "contract.pdf");

    expect(res.status).toBe(201);
    expect(res.headers["x-request-id"]).toBe(requestId);
    expect(await prisma.document.count()).toBe(1);
  }, 60_000);
});

/** How many worker threads this process currently holds. */
function activeWorkers() {
  return process.getActiveResourcesInfo().filter((kind) => kind === "Worker").length;
}

/**
 * Runs the real extraction worker inside a CHILD PROCESS and captures
 * that process's stdout.
 *
 * `new Worker(..., { stdout: true })` does not work for this: pino writes
 * through sonic-boom to file descriptor 1 directly, bypassing the
 * worker's stdout stream entirely — verified by watching a pino line
 * reach the terminal while the captured buffer held only console.log
 * output. A child process's fd 1 IS capturable, and a worker inherits
 * it, so this observes exactly the path production uses rather than a
 * test-only substitute.
 *
 * @param {Buffer} buffer @param {string} requestId
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function runWorkerCapturingLogs(buffer, requestId) {
  const serverDir = fileURLToPath(new URL("../..", import.meta.url));
  const workerPath = fileURLToPath(
    new URL("../../src/workers/extract.worker.js", import.meta.url),
  );
  const documentPath = join(tmpdir(), `clausecheck-worker-${randomUUID()}.pdf`);
  await writeFile(documentPath, buffer);

  const script = `
    import { readFileSync } from "node:fs";
    import { Worker } from "node:worker_threads";
    const worker = new Worker(${JSON.stringify(workerPath)}, {
      workerData: {
        buffer: readFileSync(${JSON.stringify(documentPath)}),
        sourceType: "UPLOAD_PDF",
        requestId: ${JSON.stringify(requestId)},
      },
      // Mirrors services/extractionWorker.js: without this the worker
      // inherits the child's --input-type=module and refuses to load.
      execArgv: [],
    });
    worker.on("message", () => { void worker.terminate(); });
  `;

  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: serverDir,
        env: { ...process.env, LOG_LEVEL: "debug" },
      },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } finally {
    await rm(documentPath, { force: true });
  }
}

describe("step 73: at most MAX_CONCURRENT_EXTRACTIONS workers at once", () => {
  /**
   * Runs `work` while polling the semaphore every millisecond, and returns
   * the most workers ever running and the most ever waiting.
   * @param {() => Promise<unknown>} work
   */
  async function watch(work) {
    let maxRunning = 0;
    let maxWaiting = 0;
    let maxWorkers = 0;
    const timer = setInterval(() => {
      const { running, waiting } = extractionSlots();
      maxRunning = Math.max(maxRunning, running);
      maxWaiting = Math.max(maxWaiting, waiting);
      maxWorkers = Math.max(maxWorkers, activeWorkers());
    }, 1);
    try {
      await work();
    } finally {
      clearInterval(timer);
    }
    return { maxRunning, maxWaiting, maxWorkers };
  }

  it("queues extractions past the limit and runs every one of them", async () => {
    const pdf = await wordyPdf();
    const max = config.MAX_CONCURRENT_EXTRACTIONS;
    /** @type {PromiseSettledResult<string>[]} */
    let results = [];
    const seen = await watch(async () => {
      results = await Promise.allSettled(
        Array.from({ length: max + 4 }, () => extractInWorker(pdf, "UPLOAD_PDF")),
      );
    });
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(seen.maxRunning).toBe(max);
    expect(seen.maxWorkers).toBeLessThanOrEqual(max);
    expect(seen.maxWaiting).toBeGreaterThan(0);
    // Slots come back on the worker's exit, which follows its answer.
    await expect.poll(() => extractionSlots().running, { timeout: 5_000 }).toBe(0);
    expect(extractionSlots().waiting).toBe(0);
  }, 60_000);

  it("holds the slot until the worker has EXITED, not merely answered", async () => {
    // The answer arrives first and the exit a turn of the event loop later:
    // a slot freed on the answer would let the next worker start while this
    // one still holds its memory.
    const pdf = await wordyPdf();
    await extractInWorker(pdf, "UPLOAD_PDF");
    expect(extractionSlots().running).toBe(1);
    await expect.poll(() => extractionSlots().running, { timeout: 5_000 }).toBe(0);
  });

  it("gives the slot back when the worker times out", async () => {
    const pdf = await wordyPdf();
    await expect(
      extractInWorker(pdf, "UPLOAD_PDF", { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: "MALFORMED_DOCUMENT",
    });
    await expect.poll(() => extractionSlots().running, { timeout: 5_000 }).toBe(0);
  });

  it("a worker that runs out of heap is a 422, never the instance, and gives its slot back", async () => {
    // 8 MB is far below what a parse needs, so the worker dies of
    // ERR_WORKER_OUT_OF_MEMORY. (Degenerate limits, 1 MB or negative, are
    // not this case: V8 aborts the whole PROCESS starting such a worker,
    // measured while writing this. The production limits are constants in
    // extractionWorker.js, not configuration, so that cannot be reached.)
    const pdf = await wordyPdf();
    await expect(
      extractInWorker(pdf, "UPLOAD_PDF", {
        resourceLimits: { maxOldGenerationSizeMb: 8 },
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_DOCUMENT" });
    await expect.poll(() => extractionSlots().running, { timeout: 5_000 }).toBe(0);
  });
});
