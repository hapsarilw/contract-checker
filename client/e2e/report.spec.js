import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 35 — "Write a Playwright test at 375 px asserting the
 * risk level is above the fold, plus axe assertions." See
 * playwright.config.js's file comment for why the API is mocked rather
 * than a live backend.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** @param {import("@playwright/test").Page} page */
async function signIn(page) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "u1", email: "person@example.com", accountState: "VERIFIED" },
      }),
    }),
  );
}

const DOCUMENT = {
  id: "doc1",
  filename: "msa-freelance.pdf",
  sourceType: "UPLOAD",
  wordCount: 1840,
  createdAt: "2026-01-05T00:00:00.000Z",
};

const SEVEN_FINDINGS = [
  {
    category: "PAYMENT",
    severity: "HIGH",
    clauseExcerpt: "a",
    explanation: "a",
    suggestedChange: "a",
  },
  {
    category: "IP",
    severity: "HIGH",
    clauseExcerpt: "b",
    explanation: "b",
    suggestedChange: "b",
  },
  {
    category: "SCOPE",
    severity: "HIGH",
    clauseExcerpt: "c",
    explanation: "c",
    suggestedChange: "c",
  },
  {
    category: "TERMINATION",
    severity: "MEDIUM",
    clauseExcerpt: "d",
    explanation: "d",
    suggestedChange: "d",
  },
  {
    category: "LIABILITY",
    severity: "MEDIUM",
    clauseExcerpt: "e",
    explanation: "e",
    suggestedChange: "e",
  },
  {
    category: "CONFIDENTIALITY",
    severity: "MEDIUM",
    clauseExcerpt: "f",
    explanation: "f",
    suggestedChange: "f",
  },
  {
    category: "DISPUTE",
    severity: "LOW",
    clauseExcerpt: "g",
    explanation: "g",
    suggestedChange: "g",
  },
];

/** @param {{ findings?: object[], overallRisk?: string }} [overrides] */
function analysisPayload(overrides = {}) {
  return {
    document: DOCUMENT,
    analysis: {
      id: "an1",
      status: "COMPLETED",
      overallRisk: "HIGH",
      summary:
        "This is a fairly typical freelance services agreement with a handful of clauses worth a second look, mostly around payment timing and IP transfer.",
      findings: SEVEN_FINDINGS,
      missingClauses: [],
      discardedFindings: 0,
      createdAt: "2026-01-05T00:12:00.000Z",
      ...overrides,
    },
  };
}

/** @param {import("@playwright/test").Page} page @param {object} [overrides] */
async function mockReport(page, overrides) {
  await page.route("**/api/v1/documents/doc1", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(analysisPayload(overrides)),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe("the report screen's masthead and severity filter (BUILD-PLAN step 35)", () => {
  test("the overall risk is visible without scrolling on a 375px-wide phone (PRD §6 acceptance criterion)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mockReport(page);
    await page.goto("/documents/doc1");

    const risk = page.getByRole("heading", { level: 1 });
    await expect(risk).toHaveText("High");
    await expect(risk).toBeInViewport({ ratio: 1 });
  });

  test("renders one h1 (the risk value) and h2s for the breakdown and findings sections, never modelRisk", async ({
    page,
  }) => {
    await mockReport(page, { overallRisk: "HIGH" });
    // A stray modelRisk field, as if a future server bug leaked it
    // (PRD D7: the client must never display it even if present).
    await page.route("**/api/v1/documents/doc1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          document: DOCUMENT,
          analysis: { ...analysisPayload().analysis, modelRisk: "LOW" },
        }),
      }),
    );
    await page.goto("/documents/doc1");

    const h1s = page.getByRole("heading", { level: 1 });
    await expect(h1s).toHaveCount(1);
    await expect(h1s).toHaveText("High");
    await expect(h1s).toHaveAttribute("aria-label", "Overall risk: High");

    const h2s = page.getByRole("heading", { level: 2 });
    await expect(h2s).toHaveCount(3); // "The shape of it", "Where the problems are", findings head

    const bodyText = /** @type {string} */ (await page.locator("body").innerText());
    expect(bodyText).not.toMatch(/modelRisk/i);
  });

  test("the category breakdown and severity filter match the prototype's copy and counts", async ({
    page,
  }) => {
    await mockReport(page);
    await page.goto("/documents/doc1");

    await expect(page.getByText("The shape of it")).toBeVisible();
    await expect(page.getByText("3 high")).toBeVisible();
    await expect(page.getByText("3 medium")).toBeVisible();
    await expect(page.getByText("1 low")).toBeVisible();

    await expect(page.getByText("Where the problems are")).toBeVisible();
    await expect(page.getByText("Payment · 1")).toBeVisible();
    await expect(page.getByText("Dispute resolution · 1")).toBeVisible();

    await expect(page.getByRole("button", { name: "All 7" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("showing all 7")).toBeVisible();
  });

  test("the severity filter is reachable and operable by keyboard, and announces the filtered count politely", async ({
    page,
  }) => {
    await mockReport(page);
    await page.goto("/documents/doc1");

    const highFilter = page.getByRole("button", { name: "High 3" });
    await highFilter.focus();
    await expect(highFilter).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(highFilter).toHaveAttribute("aria-pressed", "true");
    const countRegion = page.getByText("showing 3 of 7");
    await expect(countRegion).toBeVisible();
    await expect(countRegion).toHaveAttribute("aria-live", "polite");
  });

  test("hides the breakdown and filter bar for a clean, zero-finding report without crashing", async ({
    page,
  }) => {
    await mockReport(page, { findings: [], overallRisk: "LOW" });
    await page.goto("/documents/doc1");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Low");
    await expect(page.getByText("The shape of it")).toHaveCount(0);
    await expect(page.getByText("Where the problems are")).toHaveCount(0);
    await expect(page.getByRole("group")).toHaveCount(0);
  });

  test("a document with no completed analysis renders a real state, not a crash", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents/doc1", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ document: DOCUMENT, analysis: null }),
      }),
    );
    await page.goto("/documents/doc1");

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "hasn’t been checked yet",
    );
  });

  test("a 404 from the server renders an error state with a way back", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents/doc1", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "NOT_FOUND",
            message:
              "We couldn't find that. It may have been deleted, or it doesn't belong to your account.",
            requestId: "req_e2e",
          },
        }),
      }),
    );
    await page.goto("/documents/doc1");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: /back to upload/i })).toBeVisible();
  });

  test("axe reports zero violations at default desktop width", async ({ page }) => {
    await mockReport(page);
    await page.goto("/documents/doc1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("usable at 320px width with no horizontal scrolling, axe clean (SRS §7.15)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await mockReport(page);
    await page.goto("/documents/doc1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("usable at 200% zoom with no horizontal scrolling, axe clean (SRS §7.15)", async ({
    page,
  }) => {
    // A real desktop viewport, then Chromium's own `zoom` CSS property
    // to simulate a user zooming their browser to 200% — the effective
    // CSS layout width becomes half the real viewport, the same reflow
    // a real zoomed browser produces (Chromium-only, which matches
    // playwright.config.js's single "chromium" project).
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockReport(page);
    await page.goto("/documents/doc1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
