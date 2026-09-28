import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { createUser, createDocument, createAnalysis } from "./factories.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";

const cookieFor = (token) => [`${SESSION_COOKIE_NAME}=${token}`];
const tokenFor = (user) =>
  signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });

async function loggedInCookie(overrides = {}) {
  const user = await createUser(overrides);
  return { user, cookie: cookieFor(tokenFor(user)) };
}

/**
 * Creates `count` documents for `userId`, each `stepMs` apart, oldest
 * first in creation order (so the LAST one created is the NEWEST, and
 * should be first in the reverse-chronological list). Returns them in
 * NEWEST-FIRST order, matching what the API itself should return —
 * tests read as "compare the response to this list" rather than having
 * to reverse anything themselves.
 */
async function createDocumentSeries(
  userId,
  count,
  { stepMs = 1000, baseTime = Date.now() - 1_000_000 } = {},
) {
  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(
      await createDocument({
        userId,
        filename: `doc-${String(i).padStart(3, "0")}.pdf`,
        createdAt: new Date(baseTime + i * stepMs),
      }),
    );
  }
  return created.slice().reverse();
}

describe("GET /api/v1/documents — FR-4.1, §4.4", () => {
  it("returns 401 without a session", async () => {
    const res = await request(testServer()).get("/api/v1/documents");
    expect(res.status).toBe(401);
  });

  it("returns an empty page for a user with no documents", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      documents: [],
      page: { nextCursor: null, hasMore: false },
    });
  });

  it("matches the §4.4 response shape and FR-4.1's row shape exactly", async () => {
    const { cookie, user } = await loggedInCookie();
    await createDocument({ userId: user.id, filename: "contract.pdf" });

    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);

    expect(Object.keys(res.body).sort()).toEqual(["documents", "page"]);
    expect(Object.keys(res.body.page).sort()).toEqual(["hasMore", "nextCursor"]);
    expect(Object.keys(res.body.documents[0]).sort()).toEqual(
      ["createdAt", "filename", "findingCount", "id", "overallRisk", "wordCount"].sort(),
    );
  });

  it('substitutes "Pasted text" for a null filename', async () => {
    const { cookie, user } = await loggedInCookie();
    await createDocument({ userId: user.id, filename: null, sourceType: "PASTE" });

    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);
    expect(res.body.documents[0].filename).toBe("Pasted text");
  });

  it("orders reverse chronological — newest first", async () => {
    const { cookie, user } = await loggedInCookie();
    const series = await createDocumentSeries(user.id, 5);

    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);
    expect(res.body.documents.map((d) => d.id)).toEqual(series.map((d) => d.id));
  });

  it("only shows this user's documents, never another user's", async () => {
    const { cookie, user } = await loggedInCookie();
    const otherUser = await createUser();
    await createDocument({ userId: user.id });
    await createDocument({ userId: otherUser.id });

    const res = await request(testServer())
      .get("/api/v1/documents")
      .set("Cookie", cookie);
    expect(res.body.documents).toHaveLength(1);
  });

  describe("overallRisk and findingCount — the latest COMPLETED analysis specifically", () => {
    it("is null/0 when no analysis exists yet", async () => {
      const { cookie, user } = await loggedInCookie();
      await createDocument({ userId: user.id });

      const res = await request(testServer())
        .get("/api/v1/documents")
        .set("Cookie", cookie);
      expect(res.body.documents[0].overallRisk).toBeNull();
      expect(res.body.documents[0].findingCount).toBe(0);
    });

    it("ignores a PENDING analysis even if it's the most recent one", async () => {
      const { cookie, user } = await loggedInCookie();
      const document = await createDocument({ userId: user.id });
      await createAnalysis({
        documentId: document.id,
        status: "COMPLETED",
        overallRisk: "LOW",
        createdAt: new Date(Date.now() - 10_000),
        findings: [{ severity: "LOW" }],
      });
      await createAnalysis({
        documentId: document.id,
        status: "PENDING",
        overallRisk: null,
        completedAt: null,
        createdAt: new Date(), // newer than the COMPLETED one above
      });

      const res = await request(testServer())
        .get("/api/v1/documents")
        .set("Cookie", cookie);
      // The PENDING analysis is newer but must not be picked — FR-4.1
      // says "latest COMPLETED analysis", and step 18's GET /:id
      // deliberately uses a different rule (latest of any status) for a
      // different endpoint. Conflating the two would report LOW here
      // correctly by luck, or null/wrong wherever the PENDING one had no
      // overallRisk at all.
      expect(res.body.documents[0].overallRisk).toBe("LOW");
      expect(res.body.documents[0].findingCount).toBe(1);
    });

    it("ignores a FAILED analysis even if it's the most recent one", async () => {
      const { cookie, user } = await loggedInCookie();
      const document = await createDocument({ userId: user.id });
      await createAnalysis({
        documentId: document.id,
        status: "COMPLETED",
        overallRisk: "HIGH",
        createdAt: new Date(Date.now() - 10_000),
        findings: [{ severity: "HIGH" }, { severity: "LOW" }],
      });
      await createAnalysis({
        documentId: document.id,
        status: "FAILED",
        overallRisk: null,
        errorCode: "LLM_INVALID_OUTPUT",
        createdAt: new Date(),
      });

      const res = await request(testServer())
        .get("/api/v1/documents")
        .set("Cookie", cookie);
      expect(res.body.documents[0].overallRisk).toBe("HIGH");
      expect(res.body.documents[0].findingCount).toBe(2);
    });

    it("picks the NEWEST completed analysis when several exist", async () => {
      const { cookie, user } = await loggedInCookie();
      const document = await createDocument({ userId: user.id });
      await createAnalysis({
        documentId: document.id,
        status: "COMPLETED",
        overallRisk: "LOW",
        createdAt: new Date(Date.now() - 20_000),
        findings: [{ severity: "LOW" }],
      });
      await createAnalysis({
        documentId: document.id,
        status: "COMPLETED",
        overallRisk: "HIGH",
        createdAt: new Date(Date.now() - 10_000),
        findings: [{ severity: "HIGH" }, { severity: "MEDIUM" }],
      });

      const res = await request(testServer())
        .get("/api/v1/documents")
        .set("Cookie", cookie);
      expect(res.body.documents[0].overallRisk).toBe("HIGH");
      expect(res.body.documents[0].findingCount).toBe(2);
    });
  });

  describe("a malformed or tampered cursor (§4.4)", () => {
    it("returns 400 VALIDATION_ERROR for outright garbage, never a decode stack trace", async () => {
      const { cookie } = await loggedInCookie();
      const res = await request(testServer())
        .get("/api/v1/documents")
        .query({ cursor: "not-a-valid-cursor-at-all!!!" })
        .set("Cookie", cookie);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error).not.toHaveProperty("stack");
    });

    it("returns 400 for a cursor that is valid base64 of the wrong JSON shape", async () => {
      const { cookie } = await loggedInCookie();
      const tampered = Buffer.from(JSON.stringify({ wrong: "shape" }), "utf8").toString(
        "base64url",
      );

      const res = await request(testServer())
        .get("/api/v1/documents")
        .query({ cursor: tampered })
        .set("Cookie", cookie);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  it("limit=500 clamps to 100, proven by actually having more than 100 rows", async () => {
    // A meaningful wiring-level proof, not just re-asserting
    // resolvePageLimit's own arithmetic (already covered in
    // pagination.test.js): with only a handful of documents, "clamped to
    // 100" and "not clamped at all" would look identical. 101 rows makes
    // the difference observable — createMany rather than 101 sequential
    // factory calls, since only bulk row shape matters here, not the
    // factory's other defaults.
    const { cookie, user } = await loggedInCookie();
    const baseTime = Date.now() - 1_000_000;
    await prisma.document.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        userId: user.id,
        sourceType: "PASTE",
        rawText: `document number ${i}`,
        textSha256: `hash-${i}`,
        wordCount: 10,
        byteSize: 20,
        createdAt: new Date(baseTime + i * 1000),
      })),
    });

    const res = await request(testServer())
      .get("/api/v1/documents")
      .query({ limit: 500 })
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(100);
    expect(res.body.page.hasMore).toBe(true);
  });

  describe("25 documents across two pages (the prompt's own scenario)", () => {
    it("paginates with no duplicates and no gaps", async () => {
      const { cookie, user } = await loggedInCookie();
      const series = await createDocumentSeries(user.id, 25);

      const page1 = await request(testServer())
        .get("/api/v1/documents")
        .set("Cookie", cookie);
      expect(page1.body.documents).toHaveLength(20);
      expect(page1.body.page.hasMore).toBe(true);
      expect(page1.body.page.nextCursor).toBeTypeOf("string");

      const page2 = await request(testServer())
        .get("/api/v1/documents")
        .query({ cursor: page1.body.page.nextCursor })
        .set("Cookie", cookie);
      expect(page2.body.documents).toHaveLength(5);
      expect(page2.body.page.hasMore).toBe(false);
      expect(page2.body.page.nextCursor).toBeNull();

      const combinedIds = [...page1.body.documents, ...page2.body.documents].map(
        (d) => d.id,
      );
      expect(combinedIds).toEqual(series.map((d) => d.id));
      expect(new Set(combinedIds).size).toBe(25);
    });
  });

  describe("deleting a document between page fetches (§4.4's stated reason for cursor over offset)", () => {
    it("causes no shifted, skipped, or duplicated row on the next page", async () => {
      const { cookie, user } = await loggedInCookie();
      // Oldest -> newest: doc0 ... doc9. Newest-first order: doc9 ... doc0.
      const series = await createDocumentSeries(user.id, 10);

      const page1 = await request(testServer())
        .get("/api/v1/documents")
        .query({ limit: 5 })
        .set("Cookie", cookie);
      const page1Ids = page1.body.documents.map((d) => d.id);
      expect(page1Ids).toEqual(series.slice(0, 5).map((d) => d.id)); // the 5 newest

      // Delete one of the documents ALREADY RETURNED on page 1 — the
      // case offset pagination gets wrong: deleting a row before the
      // cursor position shifts every row after it up by one, so a
      // "skip 5" second fetch silently skips whatever used to be row 6.
      // Keyset pagination has no "row 6" concept to shift.
      const deletedId = page1Ids[2];
      await request(testServer())
        .delete(`/api/v1/documents/${deletedId}`)
        .set("Cookie", cookie)
        .set("Content-Type", "application/json");

      const page2 = await request(testServer())
        .get("/api/v1/documents")
        .query({ limit: 5, cursor: page1.body.page.nextCursor })
        .set("Cookie", cookie);

      const expectedPage2Ids = series.slice(5, 10).map((d) => d.id); // the 5 oldest, untouched
      expect(page2.body.documents.map((d) => d.id)).toEqual(expectedPage2Ids);
      expect(page2.body.page.hasMore).toBe(false);

      // No overlap between the two pages — page1 was already fetched
      // (and received by the client) before the delete happened, so it
      // legitimately still contains deletedId; that's not the thing
      // under test. What matters is that page2 doesn't duplicate
      // anything from page1, and it doesn't skip a neighbour of the
      // deleted row either — already covered by the exact-equality
      // assertion on expectedPage2Ids above.
      const allIds = [...page1Ids, ...page2.body.documents.map((d) => d.id)];
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it("also holds when the deleted document is one NOT yet returned", async () => {
      const { cookie, user } = await loggedInCookie();
      const series = await createDocumentSeries(user.id, 10);

      const page1 = await request(testServer())
        .get("/api/v1/documents")
        .query({ limit: 5 })
        .set("Cookie", cookie);

      // Delete one of the 5 OLDEST documents — not yet seen, and (unlike
      // the case above) BEFORE the cursor in keyset terms, which is
      // exactly the position where offset pagination would duplicate a
      // row on the next fetch instead of skipping one.
      const notYetSeenIds = series.slice(5, 10).map((d) => d.id);
      const deletedId = notYetSeenIds[1];
      await request(testServer())
        .delete(`/api/v1/documents/${deletedId}`)
        .set("Cookie", cookie)
        .set("Content-Type", "application/json");

      const page2 = await request(testServer())
        .get("/api/v1/documents")
        .query({ limit: 5, cursor: page1.body.page.nextCursor })
        .set("Cookie", cookie);

      const expectedRemaining = notYetSeenIds.filter((id) => id !== deletedId);
      expect(page2.body.documents.map((d) => d.id)).toEqual(expectedRemaining);
      expect(page2.body.documents).toHaveLength(4);
    });
  });
});
