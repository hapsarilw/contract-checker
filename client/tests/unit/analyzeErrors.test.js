import { describe, expect, it } from "vitest";
import { ANALYZE_ERRORS, resolveAnalyzeError } from "../../src/pages/analyzeErrors.js";

describe("resolveAnalyzeError (BUILD-PLAN step 34 — all four ANALYZE_ERRORS states)", () => {
  it.each([
    ["LLM_INVALID_OUTPUT", "The check didn’t finish."],
    ["LLM_TIMEOUT", "This took longer than expected, so we stopped."],
    ["ALL_FINDINGS_DISCARDED", "We couldn’t verify any of what came back."],
    ["ANALYSIS_IN_PROGRESS", "This contract is already being checked."],
  ])("maps %s to its exact title", (code, title) => {
    const result = resolveAnalyzeError({
      code,
      message: "server message, unused for these",
    });
    expect(result.title).toBe(title);
    expect(result.code).toBe(ANALYZE_ERRORS[code].code);
  });

  it.each(["LLM_INVALID_OUTPUT", "LLM_TIMEOUT", "ALL_FINDINGS_DISCARDED"])(
    "%s offers Try again",
    (code) => {
      expect(resolveAnalyzeError({ code, message: "x" }).primary).toBe("Try again");
    },
  );

  it("ANALYSIS_IN_PROGRESS states the honest range (30s usually, up to ~6 minutes if the earlier attempt crashed) rather than the prototype's flat 30-second promise", () => {
    const result = resolveAnalyzeError({ code: "ANALYSIS_IN_PROGRESS", message: "x" });
    expect(result.body).toMatch(/30 seconds/);
    expect(result.body).toMatch(/6 minutes/);
    expect(result.primary).toBe("Wait for it");
  });

  it("an unrecognised code still renders something actionable, using the server's own message", () => {
    const result = resolveAnalyzeError({
      code: "SOME_FUTURE_CODE",
      message: "server said this",
    });
    expect(result.title).toBeTruthy();
    expect(result.body).toBe("server said this");
    expect(result.primary).toBe("Try again");
  });
});
