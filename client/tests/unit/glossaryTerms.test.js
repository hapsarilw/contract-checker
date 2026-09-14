import { describe, expect, it } from "vitest";
import { GLOSSARY_PATTERNS, splitGlossaryTerms } from "../../src/pages/glossaryTerms.js";
import { en } from "../../src/i18n/strings/en.js";
import { id } from "../../src/i18n/strings/id.js";

describe("splitGlossaryTerms (BUILD-PLAN step 36, decision D-C)", () => {
  it("returns one text segment when no term appears", () => {
    expect(splitGlossaryTerms("Payment is due on delivery.")).toEqual([
      { type: "text", text: "Payment is due on delivery." },
    ]);
  });

  it("splits a term out of the surrounding text, preserving the text as written", () => {
    expect(splitGlossaryTerms("This is an uncapped Indemnity — one dispute.")).toEqual([
      { type: "text", text: "This is an uncapped " },
      { type: "term", key: "indemnity", text: "Indemnity" },
      { type: "text", text: " — one dispute." },
    ]);
  });

  it("glosses each term at its first occurrence only", () => {
    const segments = splitGlossaryTerms("acceptance, then acceptance again");
    expect(segments.filter((segment) => segment.type === "term")).toHaveLength(1);
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "acceptance, then acceptance again",
    );
  });

  it("finds several different terms in document order", () => {
    const terms = splitGlossaryTerms(
      "Net-90 is three months, and the clock only starts on acceptance.",
    ).filter((segment) => segment.type === "term");
    expect(terms.map((term) => term.key)).toEqual(["net90", "acceptance"]);
  });

  it("does not match a term inside a longer word", () => {
    expect(
      splitGlossaryTerms("Reassignments and indemnitors").every(
        (segment) => segment.type === "text",
      ),
    ).toBe(true);
  });

  it("recognises the terms as they appear in real model explanations (fixture 13)", () => {
    const keys = [
      "the assignment takes effect the moment you create something",
      "This is an uncapped indemnity — one dispute could cost you",
      "This is a non-compete: two years across an entire industry",
      "there is no kill fee, so the whole cost of a cancellation lands on you",
      "Net-60 means financing the client’s project for two months",
    ].map(
      (text) => splitGlossaryTerms(text).find((segment) => segment.type === "term")?.key,
    );
    expect(keys).toEqual(["assignment", "indemnity", "noncompete", "killfee", "net60"]);
  });

  it("leaves markup in model output as plain text data, never interpreting it", () => {
    const text = '<img src=x onerror="alert(1)"> an indemnity <b>here</b>';
    const segments = splitGlossaryTerms(text);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments[0]).toEqual({
      type: "text",
      text: '<img src=x onerror="alert(1)"> an ',
    });
  });

  it("every pattern key has a definition in both locales", () => {
    for (const [key] of GLOSSARY_PATTERNS) {
      expect(typeof en.glossary[key]).toBe("string");
      expect(typeof id.glossary[key]).toBe("string");
    }
  });
});
