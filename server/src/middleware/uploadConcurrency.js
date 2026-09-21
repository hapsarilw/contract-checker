import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import logger from "../observability/logger.js";

/**
 * FR-2.12 — a cap on uploads in flight AT ONCE, per instance.
 *
 * Multer buffers an upload in memory, so each one in flight holds up to
 * MAX_UPLOAD_BYTES (5 MB). Without a cap, concurrency alone is a direct
 * path to an out-of-memory kill: a few dozen simultaneous uploads is
 * trivial to produce and hundreds of megabytes is not trivial to
 * survive. §6.1's capacity model assumes exactly this bound — 10 × 5 MB.
 *
 * THIS COUNTER IS CORRECTLY IN PROCESS MEMORY, which is the opposite of
 * the call made for rate limits at step 44, and the difference is worth
 * stating because the two look alike. A rate limit is a promise about a
 * USER ("10 analyses an hour"), so it has to hold across the fleet or it
 * is not the limit it claims. This is a promise about THIS PROCESS's
 * memory — the resource being protected is local, the number that
 * matters is how many buffers THIS heap is holding, and a shared counter
 * would let one instance's idleness license another's overload.
 *
 * MOUNTED AFTER requireAuth AND BEFORE multer. After auth, so an
 * unauthenticated flood cannot occupy slots that paying requests need;
 * before multer, because a slot taken after the bytes are buffered has
 * already failed to prevent the thing it exists to prevent.
 */

let inFlight = 0;

/** Test and operator visibility. */
export const uploadsInFlight = () => inFlight;

/**
 * Released on `close`, not `finish`. `finish` fires when the response
 * has been written; `close` fires when the request/response pair is
 * done for ANY reason, including a client that disconnected mid-upload.
 * Releasing only on `finish` leaks a slot on every abandoned upload, and
 * an instance that has leaked ten of them stops accepting uploads
 * entirely until it restarts — a slow, quiet failure that looks like
 * nothing at all until it looks like an outage.
 */
export function limitConcurrentUploads(req, res, next) {
  if (inFlight >= config.MAX_CONCURRENT_UPLOADS) {
    logger.warn(
      { upload: { inFlight, max: config.MAX_CONCURRENT_UPLOADS } },
      "FR-2.12: upload concurrency cap reached, shedding load",
    );
    next(new AppError("SERVER_BUSY"));
    return;
  }

  inFlight += 1;
  let released = false;
  res.on("close", () => {
    if (released) return;
    released = true;
    inFlight -= 1;
  });

  next();
}

/** Test-only: clears state a failed test may have left behind. */
export function resetUploadConcurrencyForTests() {
  inFlight = 0;
}
