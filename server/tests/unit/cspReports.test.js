import { describe, expect, it } from "vitest";
import {
  MAX_VIOLATIONS_PER_REQUEST,
  normalizeCspReports,
  withoutSecrets,
} from "../../src/lib/cspReports.js";

/**
 * FR-7.9's reports, reduced (step 75). Shapes taken from what Chrome and
 * Firefox send: report-uri's single object and the Reporting API's array.
 */

const LEGACY = {
  "csp-report": {
    "document-uri":
      "https://app.clausecheck.example/reset-password?token=SECRET-RESET-TOKEN#x",
    referrer: "https://mail.example/inbox?id=42",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; script-src 'self'",
    disposition: "enforce",
    "blocked-uri": "https://cdn.tracker.example/t.js?uid=person%40example.com",
    "line-number": 12,
    "column-number": 7,
    "source-file": "https://app.clausecheck.example/assets/index-abc.js",
    "status-code": 200,
    "script-sample": "alert('the contract says...')",
  },
};

const REPORTING_API = [
  {
    type: "csp-violation",
    age: 10,
    url: "https://app.clausecheck.example/verify-email?token=SECRET-VERIFY-TOKEN",
    user_agent: "Mozilla/5.0",
    body: {
      documentURL:
        "https://app.clausecheck.example/verify-email?token=SECRET-VERIFY-TOKEN",
      referrer: "",
      blockedURL: "inline",
      effectiveDirective: "style-src-attr",
      originalPolicy: "default-src 'self'",
      sourceFile: "https://app.clausecheck.example/assets/index-abc.js",
      sample: "color: red",
      disposition: "enforce",
      statusCode: 200,
      lineNumber: 3,
      columnNumber: 1,
    },
  },
  { type: "deprecation", body: { id: "x" } },
];

describe("normalizeCspReports (FR-7.9, step 75)", () => {
  it("reads report-uri's format", () => {
    expect(normalizeCspReports(LEGACY)).toEqual([
      {
        directive: "script-src-elem",
        blocked: "https://cdn.tracker.example/t.js",
        document: "https://app.clausecheck.example/reset-password",
        source: "https://app.clausecheck.example/assets/index-abc.js",
        line: 12,
        column: 7,
        disposition: "enforce",
      },
    ]);
  });

  it("reads the Reporting API's format, and only its csp-violation reports", () => {
    expect(normalizeCspReports(REPORTING_API)).toEqual([
      {
        directive: "style-src-attr",
        blocked: "inline",
        document: "https://app.clausecheck.example/verify-email",
        source: "https://app.clausecheck.example/assets/index-abc.js",
        line: 3,
        column: 1,
        disposition: "enforce",
      },
    ]);
  });

  it("keeps no token, address, code sample or referrer from either format", () => {
    const kept = JSON.stringify([
      ...normalizeCspReports(LEGACY),
      ...normalizeCspReports(REPORTING_API),
    ]);
    for (const secret of [
      "SECRET-RESET-TOKEN",
      "SECRET-VERIFY-TOKEN",
      "person%40example.com",
      "the contract says",
      "color: red",
      "mail.example",
      "Mozilla",
      "original",
    ]) {
      expect(kept).not.toContain(secret);
    }
  });

  it("falls back to violated-directive, first token only, when effective-directive is absent", () => {
    const [v] = normalizeCspReports({
      "csp-report": { "violated-directive": "img-src 'self' data:" },
    });
    expect(v.directive).toBe("img-src");
  });

  it("an unknown directive is 'other', so the metric label cannot grow without bound", () => {
    const [v] = normalizeCspReports({
      "csp-report": { "effective-directive": "made-up-directive-1234" },
    });
    expect(v.directive).toBe("other");
  });

  it("takes at most MAX_VIOLATIONS_PER_REQUEST from one body", () => {
    const many = Array.from({ length: 100 }, () => REPORTING_API[0]);
    expect(normalizeCspReports(many)).toHaveLength(MAX_VIOLATIONS_PER_REQUEST);
  });

  it.each([
    null,
    undefined,
    "text",
    42,
    {},
    { "csp-report": "x" },
    [1, "a", null],
    [{ type: "csp-violation" }],
  ])("a body in neither shape yields nothing: %j", (body) => {
    expect(normalizeCspReports(body)).toEqual([]);
  });

  it("fields of the wrong type become null, never thrown", () => {
    const [v] = normalizeCspReports({
      "csp-report": {
        "effective-directive": 5,
        "blocked-uri": { a: 1 },
        "line-number": "12",
        "column-number": -1,
        disposition: "maybe",
      },
    });
    expect(v).toEqual({
      directive: "other",
      blocked: null,
      document: null,
      source: null,
      line: null,
      column: null,
      disposition: null,
    });
  });
});

describe("withoutSecrets", () => {
  it.each([
    ["https://a.example/p?q=1#f", "https://a.example/p"],
    [
      "http://localhost:4173/reset-password?token=t",
      "http://localhost:4173/reset-password",
    ],
    ["data:image/png;base64,AAAA", "data:"],
    ["blob:https://a.example/uuid", "blob:"],
    ["eval", "eval"],
    ["inline", "inline"],
    ["not a url at all", "unparseable"],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(withoutSecrets(input)).toBe(expected);
  });

  it("caps a long URL", () => {
    expect(withoutSecrets(`https://a.example/${"x".repeat(1000)}`)?.length).toBe(300);
  });
});
