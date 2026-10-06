/**
 * Shared API mocks for the step-65 accessibility audit and the keyboard
 * journey: one coherent fake account, with realistic content, so every
 * screen is audited as a person would actually see it rather than with
 * one-letter placeholder findings.
 *
 * Not a test file (Playwright only collects *.spec.js).
 */

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export const USER = { id: "u1", email: "person@example.com", state: "ACTIVE" };

export const DOCUMENT = {
  id: "doc1",
  filename: "msa-freelance.pdf",
  sourceType: "UPLOAD",
  wordCount: 1840,
  createdAt: "2026-01-05T00:00:00.000Z",
};

/** Real-length findings, the same wording report.spec.js uses. */
export const FINDINGS = [
  {
    category: "IP",
    severity: "HIGH",
    clauseExcerpt:
      "All right, title and interest in any work product created by Contractor, including pre-existing materials, shall vest in Client immediately upon creation.",
    explanation:
      "This hands over work you made before this project existed, and the assignment takes effect the moment you create something rather than when you’re paid — so an unpaid final invoice leaves you with nothing to hold.",
    suggestedChange:
      "Ask that this cover only deliverables made under this agreement, and that ownership transfer on receipt of final payment.",
  },
  {
    category: "LIABILITY",
    severity: "HIGH",
    clauseExcerpt:
      "Contractor shall indemnify, defend and hold harmless Client from and against any and all claims, losses and damages of any kind whatsoever.",
    explanation:
      "This is an uncapped indemnity — one dispute could cost you far more than the project pays, including claims caused by material the client gave you.",
    suggestedChange:
      "Ask to cap your total liability at the fees paid under this agreement, and to exclude claims arising from client-supplied content or client instructions.",
  },
  {
    category: "PAYMENT",
    severity: "MEDIUM",
    clauseExcerpt:
      "Invoices are payable net ninety (90) days following Client’s written acceptance of the Deliverables.",
    explanation:
      "Net-90 is three months of financing the client’s project, and the clock only starts on acceptance — which the client controls and could delay indefinitely.",
    suggestedChange:
      "Ask for net-14 or net-30 counted from your invoice date, and for deliverables to be treated as accepted if no feedback arrives within five working days.",
  },
  {
    category: "PAYMENT",
    severity: "LOW",
    clauseExcerpt:
      "Contractor shall bear the cost of all fonts, stock imagery and other third-party materials used in the Deliverables.",
    explanation:
      "Minor on its own, but licences for fonts and stock imagery on a branding project can run into hundreds of dollars that come straight out of your fee.",
    suggestedChange:
      "Ask for materials bought specifically for this project to be reimbursed at cost, or add an allowance for them to the fee.",
  },
];

export const ANALYSIS = {
  id: "an1",
  status: "COMPLETED",
  overallRisk: "HIGH",
  summary:
    "A fairly typical freelance services agreement with a handful of clauses worth a second look, mostly around IP transfer, liability and payment timing.",
  findings: FINDINGS,
  missingClauses: [
    "No late payment interest or penalty is specified.",
    "There is no cap on the freelancer's liability.",
  ],
  discardedFindings: 0,
  createdAt: "2026-01-05T00:12:00.000Z",
};

export const HISTORY_ROW = {
  id: "doc1",
  filename: "msa-freelance.pdf",
  wordCount: 1840,
  overallRisk: "HIGH",
  findingCount: 4,
  createdAt: "2026-01-05T00:00:00.000Z",
};

/** A pasted contract comfortably over the 200-word floor. */
export const PASTED_CONTRACT = Array.from(
  { length: 30 },
  (_, i) =>
    `Clause ${i + 1}. The Contractor shall deliver the agreed work on time and to the agreed standard.`,
).join("\n");

const json = (status, body) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   signedIn?: boolean,
 *   analyze?: "complete" | "hang",
 *   history?: "one" | "empty",
 * }} [options]
 * @returns {Promise<{ state: { signedIn: boolean, documentDeleted: boolean, accountDeleted: boolean } }>}
 */
export async function mockApi(
  page,
  { signedIn = true, analyze = "complete", history = "one" } = {},
) {
  const state = { signedIn, documentDeleted: false, accountDeleted: false };

  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill(
      state.signedIn
        ? json(200, { user: USER })
        : json(401, { error: { code: "UNAUTHENTICATED", message: "x", requestId: "r" } }),
    ),
  );
  for (const path of ["login", "register"]) {
    await page.route(`**/api/v1/auth/${path}`, (route) => {
      state.signedIn = true;
      return route.fulfill(json(path === "register" ? 201 : 200, { user: USER }));
    });
  }
  await page.route("**/api/v1/auth/logout", (route) => {
    state.signedIn = false;
    return route.fulfill(json(200, { loggedOut: true }));
  });

  await page.route("**/api/v1/documents", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill(
        json(201, { document: { ...DOCUMENT, filename: null, sourceType: "PASTE" } }),
      );
    }
    const documents = history === "empty" || state.documentDeleted ? [] : [HISTORY_ROW];
    return route.fulfill(
      json(200, { documents, page: { nextCursor: null, hasMore: false } }),
    );
  });
  await page.route("**/api/v1/documents/doc1", (route) => {
    if (route.request().method() === "DELETE") {
      state.documentDeleted = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill(json(200, { document: DOCUMENT, analysis: ANALYSIS }));
  });
  await page.route("**/api/v1/documents/doc1/analyze", (route) => {
    if (analyze === "hang") return undefined; // never fulfilled: holds the analyzing screen
    return route.fulfill(json(200, { analysis: ANALYSIS }));
  });

  // Step 75: FR-1.13's confirmation link.
  await page.route("**/api/v1/auth/confirm-email-change", (route) =>
    route.fulfill(json(200, { changed: true, email: "new-address@example.com" })),
  );

  await page.route("**/api/v1/account", (route) => {
    state.accountDeleted = true;
    state.signedIn = false;
    return route.fulfill({ status: 204 });
  });

  return { state };
}
