/**
 * BUILD-PLAN step 33 — the prototype's UPLOAD_ERRORS map
 * (docs/design/ClauseCheck.html), ported with its exact copy, each entry
 * mapped to the real server error code (SRS §4.2) instead of a fixture
 * simulation. "Keep [the copy], substituting real values for the
 * prototype's hardcoded numbers" (step 33) is this file's whole job.
 *
 * Two entries share one server code, disambiguated by WHICH tab the
 * request came from, not by anything in the response: `scan` and
 * `short` are both DOCUMENT_TOO_SHORT (§4.2's error table has one code
 * for "not enough extractable text," full stop), but the prototype's
 * copy for them is different because the LIKELY CAUSE is different — a
 * scanned upload almost never has an exact word count worth stating (the
 * server's own message calls this out: "This usually means a scanned
 * image with no selectable text"), a too-short paste always does.
 */

/**
 * `action` is set only where the primary button does something other
 * than pick a file or dismiss: "history" takes the person to their
 * contracts, where deleting one frees space.
 *
 * @typedef {{ code: string, title: string, body: string, primary: string, action?: "history" }} UploadErrorCopy
 */

/**
 * Every server code this module has specific copy for. Tests walk it to
 * check that each names a next step.
 */
export const MAPPED_UPLOAD_CODES = Object.freeze([
  "FILE_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "DOCUMENT_TOO_SHORT",
  "DOCUMENT_TOO_LONG",
  "RATE_LIMITED",
  "ENCRYPTED_DOCUMENT",
  "MALFORMED_DOCUMENT",
  "STORAGE_QUOTA_EXCEEDED",
  "SERVER_BUSY",
]);

/** en-US grouping, matching server/src/services/intake.js's own formatCount exactly. */
const formatCount = (n) => n.toLocaleString("en-US");

/**
 * Server messages embed the real word count as free text (SRS §4's own
 * example: "Document is 6,200 words. Phase 1 supports up to 4,000.") —
 * there is nowhere else to read it from: AppError's `details` field is
 * server-side only and never serialized onto the wire (server/src/lib/
 * AppError.js), on purpose, so this is the one place a real number
 * SHOULD be recovered from prose rather than a structured field.
 *
 * @param {string} message
 * @returns {string | null} the matched number, comma grouping intact, or null if the message didn't have the expected shape
 */
export function extractWordCount(message) {
  const match = message.match(/([\d,]+)\s*words/);
  return match ? match[1] : null;
}

/** @param {number} bytes */
export function formatMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * FR-7.2's client pre-check, run before any request is made. Returns
 * the SAME error shape a server round trip for the same problem would
 * — "never let a client pass imply a server pass" cuts both ways: a
 * client-side REJECTION must look and read exactly like the server's,
 * or a user who hits it learns two different vocabularies for one
 * failure.
 *
 * @param {File} file
 * @param {{ maxBytes: number }} limits
 * @returns {{ code: string, title: string, body: string, primary: string } | null}
 */
export function checkFileBeforeUpload(file, { maxBytes }) {
  if (file.size > maxBytes) {
    return {
      code: "FILE_TOO_LARGE · 413",
      title: `That file is ${formatMegabytes(file.size)} MB — a little too large.`,
      body: "ClauseCheck takes files up to 5 MB. Exporting the PDF at a smaller size usually gets it well under the limit, or you can paste the text instead.",
      primary: "Choose another file",
    };
  }

  const lower = file.name.toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".docx")) {
    return {
      code: "UNSUPPORTED_FILE_TYPE · 422",
      title: "This file isn’t a PDF or a DOCX.",
      body: "The name ends in .pdf, but the file itself is something else — that usually means it was renamed. Check you picked the right file, or paste the text of the contract.",
      primary: "Choose another file",
    };
  }

  return null;
}

/**
 * Maps a failed POST /api/v1/documents response to the prototype's
 * copy. `file` is the file that was actually submitted (for FILE_TOO_LARGE
 * arriving from the server rather than the client pre-check above — the
 * exact byte count is never in the server's message, but the file is
 * still sitting in this component's own state, which is authoritative
 * about what was just sent).
 *
 * @param {{ code: string, message: string }} apiError
 * @param {{ intakeMode: "file" | "paste", file?: File | null }} context
 * @returns {UploadErrorCopy}
 */
export function resolveServerUploadError(apiError, { intakeMode, file }) {
  switch (apiError.code) {
    case "FILE_TOO_LARGE":
      return {
        code: "FILE_TOO_LARGE · 413",
        title: file
          ? `That file is ${formatMegabytes(file.size)} MB — a little too large.`
          : "That file is a little too large.",
        body: "ClauseCheck takes files up to 5 MB. Exporting the PDF at a smaller size usually gets it well under the limit, or you can paste the text instead.",
        primary: "Choose another file",
      };

    case "UNSUPPORTED_FILE_TYPE":
      return {
        code: "UNSUPPORTED_FILE_TYPE · 422",
        title: "This file isn’t a PDF or a DOCX.",
        body: "The name ends in .pdf, but the file itself is something else — that usually means it was renamed. Check you picked the right file, or paste the text of the contract.",
        primary: "Choose another file",
      };

    case "DOCUMENT_TOO_SHORT": {
      if (intakeMode === "file") {
        return {
          code: "DOCUMENT_TOO_SHORT · 422",
          title: "We couldn’t find any text in this PDF.",
          body: "It looks like a scan or a photo of the pages, so there’s nothing for us to read. Paste the text here, or ask your client for the original file they printed from.",
          primary: "Choose another file",
        };
      }
      const words = extractWordCount(apiError.message);
      return {
        code: "DOCUMENT_TOO_SHORT · 422",
        title: words
          ? `That’s ${words} words — too little to check.`
          : "That's too little text to check.",
        body: "We need at least 200 words, which is about half a page. Paste the whole agreement rather than the one clause you’re unsure about; the surrounding terms are usually what make a clause risky.",
        primary: "Paste more text",
      };
    }

    case "DOCUMENT_TOO_LONG": {
      const words = extractWordCount(apiError.message);
      return {
        code: "DOCUMENT_TOO_LONG · 422",
        title: words
          ? `This document is ${formatCount(Number(words.replace(/,/g, "")))} words.`
          : "This document is too long.",
        body: "This version handles about 8 pages — up to 4,000 words. Trim it to the sections you want checked, or split it and run the halves separately.",
        primary: intakeMode === "file" ? "Choose another file" : "Paste less text",
      };
    }

    case "RATE_LIMITED":
      // The prototype's exact copy names a specific quota and retry
      // time ("10 contracts... at 4:35 pm") that isn't a real,
      // configured policy yet — rate limiting itself is BUILD-PLAN step
      // 41. Nothing here would be a real number, only an invented one,
      // so this shows the server's own message (already NFR-4.3-shaped:
      // "wait a moment and try again") rather than fabricate specifics
      // the prototype's designer had to make up for a mock.
      return {
        code: "RATE_LIMITED · 429",
        title: "You’ve made too many requests.",
        body: apiError.message,
        primary: "Got it",
      };

    // BUILD-PLAN step 64: the four upload errors the prototype had no copy
    // for, in its voice: what went wrong, then what to do about it.
    case "ENCRYPTED_DOCUMENT":
      return {
        code: "ENCRYPTED_DOCUMENT · 422",
        title: "This PDF is locked with a password.",
        body: "We can’t open a password-protected file. Save an unlocked copy (in most PDF viewers, Print and then Save as PDF does it) and upload that, or paste the text of the contract.",
        primary: "Choose another file",
      };
    case "MALFORMED_DOCUMENT":
      return {
        code: "MALFORMED_DOCUMENT · 422",
        title: "We couldn’t open this file.",
        body: "It may be damaged or only partly downloaded. Download it again and choose the new copy, or paste the text of the contract instead.",
        primary: "Choose another file",
      };
    case "STORAGE_QUOTA_EXCEEDED":
      // The server's message carries the real limits (from config), so it
      // is the body; the title and the button point at the fix, which is
      // deleting something (FR-2.13).
      return {
        code: "STORAGE_QUOTA_EXCEEDED · 422",
        title: "Your storage is full.",
        body: apiError.message,
        primary: "Go to your contracts",
        action: "history",
      };
    case "SERVER_BUSY":
      return {
        code: "SERVER_BUSY · 503",
        title: "We’re very busy right now.",
        body: "Too many uploads are being processed at once, so this one didn’t go through and nothing was saved. Wait a few seconds and send it again.",
        primary: "Got it",
      };
    default:
      // Any other code (a validation error, a 500, NETWORK_ERROR from
      // api/client.js) — not one of the five this step maps, but still
      // has to render as SOMETHING rather than leave the user stuck
      // with a disabled button and no explanation.
      return {
        code: `${apiError.code}`,
        title: "Something went wrong.",
        body: apiError.message,
        primary: "Try again",
      };
  }
}
