import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { redactConfig, requestIdMixin } from "../../src/observability/logger.js";
import { requestIdMiddleware } from "../../src/middleware/requestId.js";

function captureLogger(extraOptions = {}) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const testLogger = pino({ redact: redactConfig, ...extraOptions }, stream);
  return {
    logger: testLogger,
    lines: () => chunks.map((line) => JSON.parse(line)),
  };
}

// TR-16 / FR-2.7 / NFR-2.7: this is the enforcement mechanism named in
// SRS §6.5 — without it, the never-logged list is only a document.
describe("logger redaction (TR-16)", () => {
  it("redacts document.rawText instead of emitting the document text", () => {
    const { logger, lines } = captureLogger();
    const secret = "CONFIDENTIAL CONTRACT CLAUSE — do not log this";

    logger.info({ document: { id: "doc_1", rawText: secret } }, "document parsed");

    const [line] = lines();
    expect(line.document.rawText).toBe("[Redacted]");
    expect(line.document.id).toBe("doc_1");
    expect(JSON.stringify(line)).not.toContain(secret);
  });

  it("redacts every field in the never-logged list", () => {
    const { logger, lines } = captureLogger();
    const secret = "must-not-appear";

    logger.info(
      {
        document: {
          rawText: secret,
          text: secret,
          excerpt: secret,
          excerpts: [secret, secret],
          summary: secret,
          suggestedChange: secret,
          filename: secret,
          findings: [{ excerpt: secret, suggestedChange: secret }],
        },
        email: { body: secret, address: secret },
        password: secret,
        token: secret,
        req: { headers: { authorization: secret, cookie: secret }, body: { text: secret } },
      },
      "kitchen sink",
    );

    const [line] = lines();
    expect(JSON.stringify(line)).not.toContain(secret);
  });

  it("does not redact fields outside the never-logged list", () => {
    const { logger, lines } = captureLogger();

    logger.info({ document: { id: "doc_1", wordCount: 812 } }, "document created");

    const [line] = lines();
    expect(line.document.id).toBe("doc_1");
    expect(line.document.wordCount).toBe(812);
  });

  it("does NOT redact a field nested deeper than the documented shape", () => {
    // Documents the exact pitfall the file warns about: pino redaction is
    // path-based. A call site that buries `document` one level deeper
    // than the convention silently defeats redaction — this test proves
    // that failure mode exists, so nobody "fixes" it by loosening the
    // path list instead of fixing the call site.
    const { logger, lines } = captureLogger();
    const secret = "should-have-been-redacted-but-was-not";

    logger.info({ payload: { document: { rawText: secret } } }, "wrong shape");

    const [line] = lines();
    expect(line.payload.document.rawText).toBe(secret);
  });
});

describe("requestIdMixin", () => {
  it("adds no requestId field outside any request context", () => {
    expect(requestIdMixin()).toEqual({});
  });

  it("injects the current request's id when called inside a request context", async () => {
    const req = { headers: {} };
    const res = { setHeader: () => {} };
    /** @type {string} */
    let requestId = "";

    await new Promise((resolve) => {
      requestIdMiddleware(req, res, () => {
        requestId = requestIdMixin().requestId ?? "";
        resolve(undefined);
      });
    });

    expect(requestId).toBeTypeOf("string");
    expect(requestId.length).toBeGreaterThan(0);
  });
});
