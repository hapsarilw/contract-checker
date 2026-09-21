import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/app.js";
import prisma from "../../src/lib/prisma.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { MAX_ENTRIES } from "../../src/services/zipLimits.js";
import { createUser } from "./factories.js";
import {
  buildManyEntryDocx,
  buildPdf,
  buildTruncatedPdf,
  buildZipBomb,
  lieAboutUncompressedSizes,
} from "../helpers/hostileFiles.js";

/**
 * TR-18 through the real upload route (FR-2.9, FR-2.10).
 *
 * tests/unit/documentLimits.test.js proves WHICH CHECK fires and why,
 * threshold by threshold. This file proves the other half of the
 * Done-when: that none of it reaches the client as a 500, and that
 * nothing hostile is stored.
 *
 * It deliberately uses the SMALLEST input that reaches each code path
 * rather than repeating the unit tier's threshold sweep. The first
 * version built three 60 MB archives here, and the memory churn made an
 * unrelated test in a later file time out once in a run — a suite that
 * fails intermittently is one people stop reading. Only the lying-header
 * case still needs a large file, because tripping the measured-expansion
 * budget is the whole point of it. A
 * malformed file is the user's problem to fix; reporting it as a server
 * error would both mislabel that and hide real defects in the error-rate
 * metric.
 */

async function signedIn() {
  const user = await createUser();
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

const upload = (cookie, buffer, filename) =>
  request(app)
    .post("/api/v1/documents")
    .set("Cookie", cookie)
    .attach("file", buffer, filename);

describe("TR-18 — hostile uploads are refused as 4xx, never 500", () => {
  it.each([
    ["a zip bomb over the ratio cap", () => buildZipBomb({ megabytes: 10 }), "ratio.docx", "MALFORMED_DOCUMENT"],
    ["an archive with too many entries", () => buildManyEntryDocx(MAX_ENTRIES + 100), "many.docx", "MALFORMED_DOCUMENT"],
    ["a bomb that lies about its declared sizes", async () => lieAboutUncompressedSizes(await buildZipBomb({ megabytes: 60 })), "liar.docx", "MALFORMED_DOCUMENT"],
    ["a 200-page PDF", () => buildPdf({ pages: 200 }), "long.pdf", "DOCUMENT_TOO_LONG"],
    ["an encrypted PDF", () => buildPdf({ password: "secret" }), "locked.pdf", "ENCRYPTED_DOCUMENT"],
    ["a truncated PDF", () => buildTruncatedPdf(), "cut.pdf", "MALFORMED_DOCUMENT"],
  ])("%s → 422 %s, and stores nothing", async (_label, build, filename, code) => {
    const { user, cookie } = await signedIn();

    const res = await upload(cookie, await build(), filename);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.requestId).toEqual(expect.any(String));
    // Never a 500: a malformed upload is not a server defect, and
    // labelling it as one would hide the real ones.
    expect(res.status).not.toBe(500);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(0);
  }, 90_000);

  it("never puts document content into the error body", async () => {
    // FR-2.7 bars document content from logs and error output, and a
    // parser exception is exactly where an internal fragment would leak.
    const { cookie } = await signedIn();
    const res = await upload(cookie, await buildTruncatedPdf(), "cut.pdf");

    expect(JSON.stringify(res.body)).not.toMatch(/CONSULTING AGREEMENT/);
    expect(Object.keys(res.body.error).sort()).toEqual(["code", "message", "requestId"]);
  }, 60_000);

  it("still accepts an ordinary PDF, so the limits are not a tax on the common case", async () => {
    const { user, cookie } = await signedIn();
    const words = Array.from({ length: 300 }, (_unused, index) => `clause${index}`).join(" ");

    const res = await upload(cookie, await buildPdf({ text: words }), "ordinary.pdf");

    expect(res.status).toBe(201);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(1);
  }, 60_000);
});
