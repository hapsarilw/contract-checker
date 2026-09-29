import { Worker } from "node:worker_threads";
import config from "../config.js";
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

/**
 * Each worker's own V8 heap ceiling. A document that needs more is
 * pathological whatever it claims to be, and the worker dying with
 * ERR_WORKER_OUT_OF_MEMORY lands in the "error" handler below as 422
 * MALFORMED_DOCUMENT; without a ceiling it could grow until the kernel
 * killed the whole instance, and every request on it. Sized from step 73's
 * measurements with room above them: the corpus and the 5 MB flood PDF
 * parse well inside it. It bounds the JS heap only; the file's own bytes
 * (ArrayBuffers) sit outside it, and are bounded by the 5 MB upload limit.
 */
export const WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
});

/*
 * THE EXTRACTION SEMAPHORE (step 73). At most MAX_CONCURRENT_EXTRACTIONS
 * workers alive at once in this process; the rest wait their turn. A slot
 * is released when the worker has TERMINATED, not when its answer arrives:
 * the memory a worker holds is only given back when it is gone, and
 * counting it free any earlier would let the next one start on top of it.
 * The queue cannot grow without bound: FR-2.12 already caps uploads in
 * flight per instance (MAX_CONCURRENT_UPLOADS), and only uploads get here.
 */
let running = 0;
/** @type {(() => void)[]} */
const waiting = [];

/** @returns {Promise<void>} */
function acquireSlot() {
  if (running < config.MAX_CONCURRENT_EXTRACTIONS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  // Handed straight to the next waiter, so the count never dips and lets a
  // newcomer jump the queue.
  if (next) next();
  else running -= 1;
}

/** For tests and diagnostics: how many workers are alive, how many wait. */
export function extractionSlots() {
  return { running, waiting: waiting.length, max: config.MAX_CONCURRENT_EXTRACTIONS };
}

const WORKER_URL = new URL("../workers/extract.worker.js", import.meta.url);

/**
 * @param {Buffer} buffer
 * @param {"UPLOAD_PDF" | "UPLOAD_DOCX"} sourceType
 * @param {{ timeoutMs?: number, resourceLimits?: import("node:worker_threads").ResourceLimits }} [options]
 * @returns {Promise<string>}
 */
export async function extractInWorker(
  buffer,
  sourceType,
  { timeoutMs = EXTRACTION_TIMEOUT_MS, resourceLimits = WORKER_RESOURCE_LIMITS } = {},
) {
  const requestId = getRequestId();
  // Waiting for a slot is not extraction time: FR-2.11's ten seconds start
  // when this document's worker does.
  await acquireSlot();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseSlot();
  };

  return new Promise((resolve, reject) => {
    /** @type {Worker} */
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
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
        resourceLimits,
      });
    } catch (err) {
      // No worker, so no "exit" to give the slot back: give it back here, or
      // it is lost for the life of the process.
      release();
      logger.error({ err }, "extraction worker could not be started");
      reject(new AppError("MALFORMED_DOCUMENT"));
      return;
    }
    // The slot comes back when the worker is gone, on every path: an
    // answer, an error, a timeout (terminate() below), or an exit.
    worker.once("exit", release);

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
