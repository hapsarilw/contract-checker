import { parentPort, workerData } from "node:worker_threads";
import { AppError } from "../lib/AppError.js";
import { runWithRequestId } from "../middleware/requestId.js";
import logger from "../observability/logger.js";
import { extractDocxText } from "../services/docx.js";
import { extractPdfText } from "../services/pdf.js";

/**
 * FR-2.11 / NFR-1.4 — document parsing, off the main thread.
 *
 * A PDF or DOCX parser is synchronous, CPU-bound work on a buffer the
 * user chose. On the main thread a pathological document does not just
 * slow its own request down: it stops the event loop, so every other
 * user's request — a login, a history page, /api/health — waits behind
 * it. Moving the parse here means the worst a hostile document can do is
 * occupy one worker for the ten seconds before it is terminated.
 *
 * THE REQUEST ID IS PASSED EXPLICITLY, in workerData. A worker is a
 * separate JavaScript context with its own AsyncLocalStorage, so the
 * parent's store is invisible here and log lines would otherwise carry no
 * correlation id — missing at precisely the moment a parse hangs and you
 * want to know which request it belonged to. runWithRequestId puts it
 * back into the same store the middleware uses, so logger.js's mixin
 * works in here unchanged.
 *
 * ERRORS CROSS AS DATA. An AppError cannot survive structured cloning
 * with its class intact, so it is sent as its parts and rebuilt on the
 * parent side (services/extractionWorker.js). Without that, step 48's
 * ENCRYPTED_DOCUMENT and DOCUMENT_TOO_LONG would arrive as anonymous
 * errors and be flattened into a 500 — undoing the whole point of that
 * step in the process of doing this one.
 */

const { buffer, sourceType, requestId } = workerData;

runWithRequestId(requestId, async () => {
  try {
    const text =
      sourceType === "UPLOAD_PDF"
        ? await extractPdfText(Buffer.from(buffer))
        : await extractDocxText(Buffer.from(buffer));

    logger.debug(
      { document: { sourceType, chars: text.length } },
      "extraction finished in worker",
    );
    parentPort?.postMessage({ ok: true, text });
  } catch (err) {
    if (err instanceof AppError) {
      parentPort?.postMessage({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    // Anything else is a defect rather than a rejected document. The
    // message is kept for the parent to log; it is never shown to a user.
    logger.error({ err }, "unexpected failure inside the extraction worker");
    parentPort?.postMessage({
      ok: false,
      error: {
        code: "MALFORMED_DOCUMENT",
        unexpected: String(err instanceof Error ? err.message : err),
      },
    });
  }
});
