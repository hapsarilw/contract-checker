import { Worker } from "node:worker_threads";
import { AppError } from "../lib/AppError.js";
import { getRequestId } from "../middleware/requestId.js";
import logger from "../observability/logger.js";

/**
 * FR-2.11 — the main-thread half of worker extraction: spawn, bound,
 * collect, and guarantee the worker is gone afterwards.
 *
 * TEN SECONDS OF WALL CLOCK, enforced by terminating the worker rather
 * than by abandoning a promise. An abandoned promise leaves the parse
 * running: the CPU stays busy, the buffer stays resident, and under load
 * the abandoned parses accumulate — which is the failure this bound
 * exists to prevent, arrived at by a different route. `terminate()` is
 * what actually stops the work.
 *
 * ONE WORKER PER EXTRACTION rather than a pool. A pool amortises the
 * ~30 ms startup, but a hung worker has to be terminated and replaced
 * anyway, so a pool's fast path is bought with a slow path that has to
 * handle exactly what the simple version does by construction. At
 * MAX_CONCURRENT_UPLOADS (10) the startup cost is bounded and small
 * beside a parse; if profiling later says otherwise, a pool is a local
 * change behind this function.
 */

/** FR-2.11's bound. */
export const EXTRACTION_TIMEOUT_MS = 10_000;

const WORKER_URL = new URL("../workers/extract.worker.js", import.meta.url);

/**
 * @param {Buffer} buffer
 * @param {"UPLOAD_PDF" | "UPLOAD_DOCX"} sourceType
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export function extractInWorker(
  buffer,
  sourceType,
  { timeoutMs = EXTRACTION_TIMEOUT_MS } = {},
) {
  const requestId = getRequestId();

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      // The buffer is COPIED rather than transferred. Transferring would
      // detach it from the parent, and the parent still needs it: the
      // route reports the uploaded byte size, and an intake failure must
      // not leave a caller holding a zero-length buffer.
      workerData: { buffer, sourceType, requestId },
      // A worker INHERITS the parent's execArgv by default, and a flag
      // that is legal for the parent can be illegal for a worker loading
      // a file — `--input-type=module` is one, and it fails the worker
      // before it runs a line, which would surface as every upload
      // returning MALFORMED_DOCUMENT for a reason nothing in this file
      // mentions. Observed directly while writing the test for this step.
      // This worker needs no flags of its own: process.env is inherited
      // regardless, which is what config.js actually reads.
      execArgv: [],
    });

    let settled = false;
    /** @param {() => void} finish */
    const once = (finish) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Always terminated, on every path including success: a worker left
      // alive holds its buffer and keeps the event loop from draining at
      // shutdown.
      void worker.terminate();
      finish();
    };

    const timer = setTimeout(() => {
      once(() => {
        logger.warn(
          { document: { sourceType }, timeoutMs },
          "FR-2.11: extraction exceeded its wall-clock bound and was terminated",
        );
        reject(new AppError("MALFORMED_DOCUMENT"));
      });
    }, timeoutMs);

    worker.on("message", (message) => {
      once(() => {
        if (message?.ok) {
          resolve(message.text);
          return;
        }
        const { code, message: text, details, unexpected } = message?.error ?? {};
        if (unexpected) {
          logger.error(
            { err: { message: unexpected } },
            "extraction worker reported an unexpected failure",
          );
        }
        // Rebuilt here, because an AppError cannot survive structured
        // cloning as itself. Step 48's ENCRYPTED_DOCUMENT and
        // DOCUMENT_TOO_LONG depend on this: without it they would arrive
        // as plain objects and be reported as 500s.
        reject(new AppError(code ?? "MALFORMED_DOCUMENT", { message: text, details }));
      });
    });

    worker.on("error", (err) => {
      once(() => {
        logger.error({ err }, "extraction worker failed to run");
        reject(new AppError("MALFORMED_DOCUMENT"));
      });
    });

    worker.on("exit", (code) => {
      // Only meaningful if it beats every other path: a worker that exits
      // without answering has failed, and leaving the promise pending
      // would hang the request for ever.
      once(() => {
        logger.error(
          { worker: { exitCode: code } },
          "extraction worker exited without a result",
        );
        reject(new AppError("MALFORMED_DOCUMENT"));
      });
    });
  });
}
