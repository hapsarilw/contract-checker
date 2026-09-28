import { describe, it, expect } from "vitest";
import { extractDocxText } from "../../src/services/docx.js";
import { buildDocx } from "../helpers/buildDocx.js";
import { AppError } from "../../src/lib/AppError.js";

describe("extractDocxText (FR-2.10)", () => {
  it("extracts real text from a valid DOCX", async () => {
    const docx = await buildDocx({
      paragraphs: ["INDEPENDENT CONTRACTOR AGREEMENT", "This is the second paragraph."],
    });
    const text = await extractDocxText(docx);
    expect(text).toContain("INDEPENDENT CONTRACTOR AGREEMENT");
    expect(text).toContain("This is the second paragraph.");
  });

  it("extracts correctly whether [Content_Types].xml is deflated or stored", async () => {
    // The same distinction step 16's typing had to get right (a deflated
    // entry hides the content-type string from a naive scan) has no
    // bearing here — mammoth unzips properly either way. This just
    // confirms the fixture-building helper itself is compression-agnostic.
    const deflated = await buildDocx({
      paragraphs: ["deflate text"],
      compression: "DEFLATE",
    });
    const stored = await buildDocx({ paragraphs: ["store text"], compression: "STORE" });

    expect(await extractDocxText(deflated)).toContain("deflate text");
    expect(await extractDocxText(stored)).toContain("store text");
  });

  it("throws AppError MALFORMED_DOCUMENT for bytes that are not a ZIP at all", async () => {
    const err = await extractDocxText(Buffer.from("not a docx", "utf8")).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
    expect(err.status).toBe(422);
  });

  it("throws MALFORMED_DOCUMENT for a truncated DOCX — a valid ZIP header with a corrupted central directory", async () => {
    const docx = await buildDocx({ paragraphs: ["a document long enough to matter"] });
    const truncated = docx.subarray(0, 30);

    const err = await extractDocxText(truncated).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
  });

  it("throws MALFORMED_DOCUMENT for an empty buffer", async () => {
    const err = await extractDocxText(Buffer.alloc(0)).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("MALFORMED_DOCUMENT");
  });

  it("never leaks mammoth's own error message, which can quote the archive's internal structure", async () => {
    const err = await extractDocxText(Buffer.from("garbage", "utf8")).catch((e) => e);
    expect(err.message).not.toMatch(/zip|central directory/i);
  });
});
