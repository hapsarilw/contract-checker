import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import http from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import app from "../../src/app.js";
import prisma from "../../src/lib/prisma.js";
import { createUser, createDocument, createAnalysis } from "./factories.js";
import { buildDocx } from "../helpers/buildDocx.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readFixture = (name) => readFileSync(join(fixturesDir, name));

/** Same convention as authMiddleware.test.js. */
const cookieFor = (token) => [`${SESSION_COOKIE_NAME}=${token}`];
const tokenFor = (user) =>
  signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });

async function loggedInCookie(overrides = {}) {
  const user = await createUser(overrides);
  return { user, cookie: cookieFor(tokenFor(user)) };
}

/** n whitespace-separated tokens — matches intake.test.js's convention. */
const wordsOfLength = (n) => Array(n).fill("word").join(" ");

describe("POST /api/v1/documents — paste intake (FR-2.1, §4.3)", () => {
  it("matches the §4.3 response shape exactly", async () => {
    const { cookie } = await loggedInCookie();
    const text = "INDEPENDENT CONTRACTOR AGREEMENT\n" + wordsOfLength(250);

    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .send({ text });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(["document"]);
    expect(Object.keys(res.body.document).sort()).toEqual(
      ["createdAt", "filename", "id", "sourceType", "wordCount"].sort(),
    );
    expect(res.body.document.filename).toBeNull();
    expect(res.body.document.sourceType).toBe("PASTE");
    expect(res.body.document.wordCount).toBe(253); // "INDEPENDENT CONTRACTOR AGREEMENT" (3) + 250
    expect(res.body.document.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("persists the normalised text, word count, hash and byte size", async () => {
    const { cookie, user } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .send({ text: wordsOfLength(300) });

    const stored = await prisma.document.findUnique({
      where: { id: res.body.document.id },
    });
    if (!stored) throw new Error("expected the document to have been persisted");
    expect(stored.userId).toBe(user.id);
    expect(stored.wordCount).toBe(300);
    expect(stored.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.byteSize).toBe(Buffer.byteLength(stored.rawText, "utf8"));
  });

  it("returns 422 DOCUMENT_TOO_SHORT through the real route, with the actual count in the message", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .send({ text: wordsOfLength(50) });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DOCUMENT_TOO_SHORT");
    expect(res.body.error.message).toContain("50");
  });

  it("returns 401 without a session", async () => {
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Content-Type", "application/json")
      .send({ text: wordsOfLength(250) });
    expect(res.status).toBe(401);
  });

  it("returns 400 VALIDATION_ERROR when text is missing entirely", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 422 DOCUMENT_TOO_SHORT, not 400, for an all-whitespace paste — one gate for the same failure, not two", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .send({ text: "    \n\n   " });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DOCUMENT_TOO_SHORT");
  });
});

describe("POST /api/v1/documents — upload intake stores the right sourceType", () => {
  it("stores UPLOAD_PDF for a real PDF fixture", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach("file", readFixture("01-design-services-hostile.pdf"), "contract.pdf");

    expect(res.status).toBe(201);
    expect(res.body.document.sourceType).toBe("UPLOAD_PDF");
    expect(res.body.document.filename).toBe("contract.pdf");
  });

  it("stores UPLOAD_DOCX for a real DOCX", async () => {
    const { cookie } = await loggedInCookie();
    const docx = await buildDocx({ paragraphs: [wordsOfLength(250)] });

    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach("file", docx, "contract.docx");

    expect(res.status).toBe(201);
    expect(res.body.document.sourceType).toBe("UPLOAD_DOCX");
  });

  it("sanitises the stored filename (FR-2.14)", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach(
        "file",
        readFixture("01-design-services-hostile.pdf"),
        "../../etc/passwd.pdf",
      );

    expect(res.status).toBe(201);
    expect(res.body.document.filename).not.toContain("/");
    expect(res.body.document.filename).not.toContain("..\\");
  });

  it("returns 422 UNSUPPORTED_FILE_TYPE for a renamed .txt, never touching a parser", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach(
        "file",
        Buffer.from("plain text pretending to be a pdf", "utf8"),
        "contract.pdf",
      );

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  // PRD §9 Phase 1 DoD item 3 (BUILD-PLAN step 43). intake.test.js already
  // proves intakeUpload() rejects this fixture; this proves the same
  // outcome survives the real route — Multer, magic-byte detection and the
  // error translator all sit between the upload and that service, and any
  // of them could turn a scan into a generic 500 or a 400 instead.
  it("returns 422 DOCUMENT_TOO_SHORT naming a scanned image for an image-only PDF (fixture 06), and stores nothing", async () => {
    const { cookie, user } = await loggedInCookie();
    const res = await request(testServer())
      .post("/api/v1/documents")
      .set("Cookie", cookie)
      .attach("file", readFixture("06-scanned-no-text-layer.pdf"), "scan.pdf");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DOCUMENT_TOO_SHORT");
    expect(res.body.error.message).toMatch(/scanned image/i);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(0);
  });

  it("returns 413 FILE_TOO_LARGE on the declared size alone, before reading the body", async () => {
    // Declares a 6 MB multipart body but sends only its first bytes. The
    // rejection happens on Content-Length (upload.js), so the server has to
    // answer without the rest; a server that waited for the body would never
    // respond, and the 5 s socket timeout below fails the test.
    //
    // Supertest cannot express this. It streams all 6 MB, and when the server
    // answers and closes the socket mid-upload, the client's next write fails
    // with EPIPE, sometimes before the response is read: 5 requests in 100
    // when measured, which made this test flaky in full runs.
    const { cookie } = await loggedInCookie();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

    try {
      const { status, body } =
        await /** @type {Promise<{ status: number | undefined, body: any }>} */ (
          new Promise((resolve, reject) => {
            const req = http.request(
              {
                host: "127.0.0.1",
                port,
                method: "POST",
                path: "/api/v1/documents",
                headers: {
                  cookie: cookie.join("; "),
                  "content-type": "multipart/form-data; boundary=clausecheck",
                  "content-length": String(6 * 1024 * 1024),
                },
              },
              (res) => {
                let text = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (text += chunk));
                res.on("end", () => {
                  req.destroy();
                  resolve({ status: res.statusCode, body: JSON.parse(text) });
                });
              },
            );
            // A write after the server has answered and closed may fail; the
            // response is what is under test.
            req.on("error", (err) => {
              const code = /** @type {NodeJS.ErrnoException} */ (err).code;
              if (code !== "EPIPE" && code !== "ECONNRESET") reject(err);
            });
            req.setTimeout(5000, () =>
              reject(
                new Error(
                  "no response on the declared size alone: the server is waiting for the body",
                ),
              ),
            );
            req.write(
              '--clausecheck\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n',
            );
          })
        );

      expect(status).toBe(413);
      expect(body.error.code).toBe("FILE_TOO_LARGE");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("GET /api/v1/documents/:id (§4's endpoint table)", () => {
  it("returns the document with analysis: null when nothing has been analysed yet", async () => {
    const { cookie, user } = await loggedInCookie();
    const document = await createDocument({ userId: user.id });

    const res = await request(testServer())
      .get(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.document.id).toBe(document.id);
    expect(res.body.analysis).toBeNull();
  });

  it("returns the latest analysis, matching the §4.3 analyze-success shape", async () => {
    const { cookie, user } = await loggedInCookie();
    const document = await createDocument({ userId: user.id });
    await createAnalysis({
      documentId: document.id,
      overallRisk: "HIGH",
      summary: "A test summary.",
      missingClauses: ["No late payment clause."],
      findings: [{ severity: "LOW" }, { severity: "HIGH" }, { severity: "MEDIUM" }],
    });

    const res = await request(testServer())
      .get(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.analysis).sort()).toEqual(
      [
        "createdAt",
        "discardedFindings",
        "findings",
        "id",
        "missingClauses",
        "overallRisk",
        "status",
        "summary",
      ].sort(),
    );
    // Ordered HIGH -> MEDIUM -> LOW (FR-4.2 / §2.2 step 12), regardless
    // of the order they were created in.
    expect(res.body.analysis.findings.map((f) => f.severity)).toEqual([
      "HIGH",
      "MEDIUM",
      "LOW",
    ]);
  });

  it("never returns modelRisk in the response body, anywhere", async () => {
    const { cookie, user } = await loggedInCookie();
    const document = await createDocument({ userId: user.id });
    await createAnalysis({
      documentId: document.id,
      overallRisk: "LOW",
      modelRisk: "HIGH", // the model's claim disagrees with the server-derived risk on purpose
      findings: [{ severity: "LOW" }],
    });

    const res = await request(testServer())
      .get(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.analysis).not.toHaveProperty("modelRisk");
    // Belt and braces: the string "modelRisk" must not appear ANYWHERE
    // in the serialized body, not just as a top-level key — guards
    // against a future nested/renamed leak the property check wouldn't
    // catch.
    expect(JSON.stringify(res.body)).not.toContain("modelRisk");
  });

  it("returns 404, not 403, for another user's document (TR-4)", async () => {
    const { cookie: cookieA } = await loggedInCookie();
    const userB = await createUser();
    const documentOfB = await createDocument({ userId: userB.id });

    const res = await request(testServer())
      .get(`/api/v1/documents/${documentOfB.id}`)
      .set("Cookie", cookieA);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for a nonexistent document id", async () => {
    const { cookie } = await loggedInCookie();
    const res = await request(testServer())
      .get("/api/v1/documents/nonexistent-id-12345")
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
  });

  it("returns 401 without a session", async () => {
    const document = await createDocument();
    const res = await request(testServer()).get(`/api/v1/documents/${document.id}`);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/v1/documents/:id (FR-4.3, PRD D2 — hard delete)", () => {
  it("permanently removes the document, its analyses, and its findings — verified by direct row counts", async () => {
    const { cookie, user } = await loggedInCookie();
    const document = await createDocument({ userId: user.id });
    const analysis = await createAnalysis({
      documentId: document.id,
      findings: [{ severity: "HIGH" }, { severity: "LOW" }],
    });

    // Counted directly against the database, not inferred from the API's
    // own 200 response — the point of this test is proving the cascade
    // actually happened, not that the route claims it did.
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(1);
    expect(await prisma.analysis.count({ where: { id: analysis.id } })).toBe(1);
    expect(await prisma.finding.count({ where: { analysisId: analysis.id } })).toBe(2);

    const res = await request(testServer())
      .delete(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.message).toContain("30 days");

    expect(await prisma.document.count({ where: { id: document.id } })).toBe(0);
    expect(await prisma.analysis.count({ where: { id: analysis.id } })).toBe(0);
    expect(await prisma.finding.count({ where: { analysisId: analysis.id } })).toBe(0);
  });

  it("deletes a document with no analysis at all", async () => {
    const { cookie, user } = await loggedInCookie();
    const document = await createDocument({ userId: user.id });

    const res = await request(testServer())
      .delete(`/api/v1/documents/${document.id}`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(await prisma.document.count({ where: { id: document.id } })).toBe(0);
  });

  it("returns 404, not 403, for another user's document (TR-4), and does not delete it", async () => {
    const { cookie: cookieA } = await loggedInCookie();
    const userB = await createUser();
    const documentOfB = await createDocument({ userId: userB.id });

    const res = await request(testServer())
      .delete(`/api/v1/documents/${documentOfB.id}`)
      .set("Cookie", cookieA)
      .set("Content-Type", "application/json");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(await prisma.document.count({ where: { id: documentOfB.id } })).toBe(1);
  });

  it("returns 401 without a session", async () => {
    const document = await createDocument();
    const res = await request(testServer())
      .delete(`/api/v1/documents/${document.id}`)
      .set("Content-Type", "application/json");
    expect(res.status).toBe(401);
  });
});
