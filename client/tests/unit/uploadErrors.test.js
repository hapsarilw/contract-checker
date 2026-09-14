import { describe, expect, it } from "vitest";
import {
  checkFileBeforeUpload,
  extractWordCount,
  formatMegabytes,
  resolveServerUploadError,
} from "../../src/pages/uploadErrors.js";

const MAX_BYTES = 5 * 1024 * 1024;

/** @param {number} bytes @param {string} name @param {string} [type] */
function fakeFile(bytes, name, type = "application/pdf") {
  return /** @type {File} */ ({ size: bytes, name, type });
}

describe("checkFileBeforeUpload (BUILD-PLAN step 33, FR-7.2)", () => {
  it("passes a same-size-as-limit .pdf (the bound is inclusive)", () => {
    expect(
      checkFileBeforeUpload(fakeFile(MAX_BYTES, "contract.pdf"), { maxBytes: MAX_BYTES }),
    ).toBeNull();
  });

  it("passes a well-formed .docx", () => {
    expect(
      checkFileBeforeUpload(fakeFile(1024, "contract.DOCX"), { maxBytes: MAX_BYTES }),
    ).toBeNull();
  });

  it("catches an oversized file with the real size, before any request", () => {
    const sixPointTwoMb = Math.round(6.2 * 1024 * 1024);
    const result = checkFileBeforeUpload(fakeFile(sixPointTwoMb, "contract.pdf"), {
      maxBytes: MAX_BYTES,
    });
    expect(result).toMatchObject({
      code: "FILE_TOO_LARGE · 413",
      title: "That file is 6.2 MB — a little too large.",
      primary: "Choose another file",
    });
  });

  it("catches an unsupported extension", () => {
    const result = checkFileBeforeUpload(fakeFile(1024, "contract.txt"), {
      maxBytes: MAX_BYTES,
    });
    expect(result).toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE · 422",
      title: "This file isn’t a PDF or a DOCX.",
    });
  });

  it("checks size before extension — a huge file with a bad extension still reads as too large first", () => {
    const result = checkFileBeforeUpload(fakeFile(MAX_BYTES + 1, "contract.exe"), {
      maxBytes: MAX_BYTES,
    });
    expect(result?.code).toBe("FILE_TOO_LARGE · 413");
  });
});

describe("extractWordCount", () => {
  it.each([
    ["Document is 4,468 words. Phase 1 supports up to 4,000.", "4,468"],
    [
      "This document is 38 words — under the 200-word minimum. This usually means a scanned image with no selectable text.",
      "38",
    ],
    ["This document is 0 words — under the 200-word minimum.", "0"],
  ])("extracts %s -> %s", (message, expected) => {
    expect(extractWordCount(message)).toBe(expected);
  });

  it("returns null for a message with no word count", () => {
    expect(
      extractWordCount("You've made too many requests. Please wait a moment."),
    ).toBeNull();
  });
});

describe("formatMegabytes", () => {
  it("matches the prototype's exact example: 6.2 MB", () => {
    expect(formatMegabytes(Math.round(6.2 * 1024 * 1024))).toBe("6.2");
  });
});

describe("resolveServerUploadError (BUILD-PLAN step 33 — all five UPLOAD_ERRORS states)", () => {
  it("FILE_TOO_LARGE, with the file still in hand from submission", () => {
    const result = resolveServerUploadError(
      { code: "FILE_TOO_LARGE", message: "That file is over the 5 MB limit." },
      {
        intakeMode: "file",
        file: fakeFile(Math.round(6.2 * 1024 * 1024), "contract.pdf"),
      },
    );
    expect(result).toMatchObject({
      code: "FILE_TOO_LARGE · 413",
      title: "That file is 6.2 MB — a little too large.",
      primary: "Choose another file",
    });
  });

  it("UNSUPPORTED_FILE_TYPE", () => {
    const result = resolveServerUploadError(
      { code: "UNSUPPORTED_FILE_TYPE", message: "x" },
      { intakeMode: "file" },
    );
    expect(result).toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE · 422",
      title: "This file isn’t a PDF or a DOCX.",
    });
  });

  it("DOCUMENT_TOO_SHORT from the FILE tab renders as the scanned-PDF case, no word count needed", () => {
    const result = resolveServerUploadError(
      {
        code: "DOCUMENT_TOO_SHORT",
        message: "This document is 0 words — under the 200-word minimum.",
      },
      { intakeMode: "file" },
    );
    expect(result).toMatchObject({
      code: "DOCUMENT_TOO_SHORT · 422",
      title: "We couldn’t find any text in this PDF.",
      primary: "Choose another file",
    });
  });

  it("DOCUMENT_TOO_SHORT from the PASTE tab renders the real word count", () => {
    const result = resolveServerUploadError(
      {
        code: "DOCUMENT_TOO_SHORT",
        message: "This document is 38 words — under the 200-word minimum.",
      },
      { intakeMode: "paste" },
    );
    expect(result).toMatchObject({
      code: "DOCUMENT_TOO_SHORT · 422",
      title: "That’s 38 words — too little to check.",
      primary: "Paste more text",
    });
  });

  it("DOCUMENT_TOO_LONG renders the real word count, comma-grouped", () => {
    const result = resolveServerUploadError(
      {
        code: "DOCUMENT_TOO_LONG",
        message: "Document is 4,468 words. Phase 1 supports up to 4,000.",
      },
      { intakeMode: "file" },
    );
    expect(result).toMatchObject({
      code: "DOCUMENT_TOO_LONG · 422",
      title: "This document is 4,468 words.",
      primary: "Choose another file",
    });
  });

  it("DOCUMENT_TOO_LONG's primary action differs by tab", () => {
    const result = resolveServerUploadError(
      { code: "DOCUMENT_TOO_LONG", message: "Document is 4,468 words." },
      { intakeMode: "paste" },
    );
    expect(result.primary).toBe("Paste less text");
  });

  it("RATE_LIMITED shows the real server message, not the prototype's invented quota numbers", () => {
    const result = resolveServerUploadError(
      {
        code: "RATE_LIMITED",
        message: "You've made too many requests. Please wait a moment and try again.",
      },
      { intakeMode: "file" },
    );
    expect(result.code).toBe("RATE_LIMITED · 429");
    expect(result.body).toBe(
      "You've made too many requests. Please wait a moment and try again.",
    );
    // Never the prototype's fabricated specifics — rate limiting isn't
    // even implemented yet (BUILD-PLAN step 41), so "10 contracts" and
    // "4:35 pm" are not real numbers this app could honestly show.
    expect(result.title).not.toMatch(/10 contracts/);
    expect(result.body).not.toMatch(/4:35/);
  });

  it("an unrecognised code still renders something actionable, using the server's own message", () => {
    const result = resolveServerUploadError(
      { code: "SOME_FUTURE_CODE", message: "Whatever the server actually said." },
      { intakeMode: "file" },
    );
    expect(result.title).toBeTruthy();
    expect(result.body).toBe("Whatever the server actually said.");
  });

  it("a word-count extraction failure degrades gracefully rather than showing a broken title", () => {
    const result = resolveServerUploadError(
      {
        code: "DOCUMENT_TOO_LONG",
        message: "Something unexpected with no number in it.",
      },
      { intakeMode: "file" },
    );
    expect(result.title).toBe("This document is too long.");
  });
});
