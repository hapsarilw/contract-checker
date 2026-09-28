import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../../../server/src/lib/errorCodes.js";
import {
  MAPPED_ANALYZE_CODES,
  formatResetDate,
  resolveAnalyzeError,
} from "../../src/pages/analyzeErrors.js";
import {
  MAPPED_UPLOAD_CODES,
  resolveServerUploadError,
} from "../../src/pages/uploadErrors.js";

/**
 * BUILD-PLAN step 64: "every error code in the client's map renders a
 * message that names a next step" (NFR-4.3).
 *
 * "Names a next step" is checked as: the body contains an instruction the
 * person can act on (one of the verbs below, as an instruction, not buried
 * in a description) AND the primary button is an action rather than a
 * bare acknowledgement. A heuristic, stated as one; its job is to catch
 * the copy that only says what broke, which is the failure NFR-4.3 names.
 * ("trying again usually works" counts: ALL_FINDINGS_DISCARDED's
 * prototype copy says it that way, and it is a next step.)
 *
 * The server's REAL error table is the source of the messages, imported
 * rather than copied, so a client entry for a code the server does not
 * have (a typo, a renamed code) fails here too.
 */
const NEXT_STEP =
  /\b(try|trying again|paste|upload|choose|delete|wait|split|trim|save|download|send|come back|go back|check it then|open|export)\b/i;

const serverMessage = (code) => ERROR_CODES[code].message;

describe("every mapped code is a real server code", () => {
  it.each([...MAPPED_ANALYZE_CODES, ...MAPPED_UPLOAD_CODES])("%s", (code) => {
    expect(ERROR_CODES).toHaveProperty(code);
  });
});

describe("analyze errors name a next step", () => {
  it.each(MAPPED_ANALYZE_CODES)("%s", (code) => {
    const copy = resolveAnalyzeError({ code, message: serverMessage(code) });
    expect(copy.body).toMatch(NEXT_STEP);
    expect(copy.primary).not.toMatch(/^(ok|got it|close)$/i);
    // The code line shows the real status, never a made-up one.
    expect(copy.code).toBe(`${code} · ${ERROR_CODES[code].status}`);
  });
});

describe("upload errors name a next step", () => {
  it.each(
    MAPPED_UPLOAD_CODES.flatMap((code) => [
      [code, "file"],
      [code, "paste"],
    ]),
  )("%s (%s)", (code, intakeMode) => {
    const copy = resolveServerUploadError(
      { code, message: serverMessage(code) },
      { intakeMode: /** @type {"file" | "paste"} */ (intakeMode), file: null },
    );
    expect(copy.body).toMatch(NEXT_STEP);
    expect(copy.code).toBe(`${code} · ${ERROR_CODES[code].status}`);
  });
});

describe("the step-64 specifics", () => {
  it("QUOTA_EXCEEDED states the reset date, the first of next UTC month, in the server's own format", () => {
    const copy = resolveAnalyzeError(
      { code: "QUOTA_EXCEEDED", message: "x" },
      new Date("2026-09-28T12:00:00Z"),
    );
    expect(copy.body).toContain("1 October 2026");
  });

  it("the reset date rolls the year in December, and follows UTC, not local time", () => {
    expect(formatResetDate(new Date("2026-12-31T23:30:00Z"))).toBe("1 January 2027");
    // 23:30 UTC on 30 September is already 1 October in UTC+7; the quota
    // period is UTC, so the reset is still 1 October.
    expect(formatResetDate(new Date("2026-09-30T23:30:00Z"))).toBe("1 October 2026");
  });

  it("SPEND_LIMIT_REACHED keeps the server's words, which differ for an operator's pause (FR-5.4)", () => {
    const paused = "Contract analysis is paused while we look into something.";
    expect(
      resolveAnalyzeError({ code: "SPEND_LIMIT_REACHED", message: paused }).body,
    ).toContain(paused);
  });

  it.each(["LLM_UNAVAILABLE", "SPEND_LIMIT_REACHED", "QUOTA_EXCEEDED"])(
    "%s sends the person to their saved reports instead of offering a retry that cannot work",
    (code) => {
      expect(resolveAnalyzeError({ code, message: "x" }).action).toBe("reports");
    },
  );

  it("SERVER_BUSY on analyze does offer a retry: it clears in seconds", () => {
    expect(resolveAnalyzeError({ code: "SERVER_BUSY", message: "x" }).action).toBe(
      "retry",
    );
  });

  it("STORAGE_QUOTA_EXCEEDED points at deletion (FR-2.13) and its button goes to the contracts", () => {
    const copy = resolveServerUploadError(
      {
        code: "STORAGE_QUOTA_EXCEEDED",
        message: serverMessage("STORAGE_QUOTA_EXCEEDED"),
      },
      { intakeMode: "file", file: null },
    );
    expect(copy.body).toMatch(/Delete/);
    expect(copy.action).toBe("history");
  });

  it("ENCRYPTED_DOCUMENT asks for an unlocked copy (FR-2.10)", () => {
    const copy = resolveServerUploadError(
      { code: "ENCRYPTED_DOCUMENT", message: "x" },
      { intakeMode: "file", file: null },
    );
    expect(copy.body).toMatch(/unlocked copy/);
  });
});
