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

// Realistic model output, lifted from fixture 13's explanations and asks
// (server/tests/fixtures/13-stress-long-report.json) so the glossary and
// reflow tests run against the words and lengths the real thing produces.
// Deliberately out of severity order: FR-7.5's ordering is the client's job.
const REAL_FINDINGS = [
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
    category: "LIABILITY",
    severity: "HIGH",
    clauseExcerpt:
      "Contractor shall indemnify, defend and hold harmless Client from and against any and all claims, losses and damages of any kind whatsoever.",
    explanation:
      "This is an uncapped indemnity — one dispute could cost you far more than the project pays, including claims caused by material the client gave you.",
    suggestedChange:
      "Ask to cap your total liability at the fees paid under this agreement, and to exclude claims arising from client-supplied content or client instructions.",
  },
];

test.describe("the findings list (BUILD-PLAN step 36)", () => {
  test("cards render high → medium → low as an ordered list, each with the quote, why, and ask", async ({
    page,
  }) => {
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    const items = page.locator("ol.cc-report__findings > li");
    await expect(items).toHaveCount(4);
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      "IP and ownership",
      "Liability",
      "Payment",
      "Payment",
    ]);

    const first = items.first();
    await expect(first.getByText("High severity")).toBeVisible();
    await expect(first.getByText("Quoted from your contract")).toBeVisible();
    await expect(first.locator("blockquote")).toHaveText(
      `“${REAL_FINDINGS[1].clauseExcerpt}”`,
    );
    await expect(first.getByText("Why it matters")).toBeVisible();
    await expect(first.getByText("What to ask for")).toBeVisible();
    await expect(first.getByText(REAL_FINDINGS[1].suggestedChange)).toBeVisible();
  });

  test("the quote's left rule is coloured, and thickened, by severity", async ({
    page,
  }) => {
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    const quotes = page.locator("ol.cc-report__findings blockquote");
    // evaluateAll doesn't auto-wait; without this it can read an empty list.
    await expect(quotes).toHaveCount(4);
    const rules = await quotes.evaluateAll((quotes) =>
      quotes.map((quote) => {
        const style = getComputedStyle(quote);
        return [style.borderLeftColor, style.borderLeftWidth];
      }),
    );
    expect(rules).toEqual([
      ["rgb(122, 63, 46)", "3px"], // #7A3F2E high
      ["rgb(122, 63, 46)", "3px"],
      ["rgb(122, 101, 32)", "2px"], // #7A6520 medium
      ["rgb(61, 90, 78)", "1px"], // #3D5A4E low
    ]);
  });

  test("the copy control works by keyboard, copies the ask, and shows and announces the confirmation", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    const firstCard = page.locator("ol.cc-report__findings > li").first();
    const copy = firstCard.getByRole("button", { name: "Copy this ask" });
    await copy.focus();
    await page.keyboard.press("Enter");

    const note = firstCard.getByText("Copied — paste it into your reply to the client.");
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("role", "status");
    await expect(note).toHaveAttribute("aria-live", "polite");
    await expect(firstCard.getByRole("button", { name: "Copied" })).toBeFocused();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(REAL_FINDINGS[1].suggestedChange);
  });

  test("a glossary term is keyboard-reachable, opens with Enter, and Escape dismisses it without losing focus", async ({
    page,
  }) => {
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    const term = page.getByRole("button", { name: "indemnity" });
    const meaning = page.getByText(
      "A promise to cover the other side’s losses if a claim is made against them.",
    );
    await term.focus();
    await expect(term).toBeFocused();
    await expect(meaning).toBeHidden();

    await page.keyboard.press("Enter");
    await expect(term).toHaveAttribute("aria-expanded", "true");
    await expect(meaning).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(term).toHaveAttribute("aria-expanded", "false");
    await expect(meaning).toBeHidden();
    await expect(term).toBeFocused();
  });

  test("a finding whose text contains HTML renders it as literal text (FR-7.8)", async ({
    page,
  }) => {
    const hostile =
      '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    await mockReport(page, {
      overallRisk: "HIGH",
      findings: [
        {
          category: "LIABILITY",
          severity: "HIGH",
          clauseExcerpt: hostile,
          explanation: `${hostile} an uncapped indemnity`,
          suggestedChange: hostile,
        },
      ],
    });
    await page.goto("/documents/doc1");

    const card = page.locator("ol.cc-report__findings > li").first();
    await expect(card.locator("blockquote")).toHaveText(`“${hostile}”`);
    await expect(card.getByText(hostile, { exact: true })).toBeVisible();
    await expect(card.locator("img, script")).toHaveCount(0);
    expect(
      await page.evaluate(() => /** @type {any} */ (window).__pwned),
    ).toBeUndefined();
  });

  test("zero findings reads as a clean result, not an error, and is axe clean", async ({
    page,
  }) => {
    await mockReport(page, { findings: [], overallRisk: "LOW" });
    await page.goto("/documents/doc1");

    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Nothing in this contract needs a second look.",
      }),
    ).toBeVisible();
    await expect(page.locator(".cc-report__checked li")).toHaveCount(8);
    await expect(page.getByRole("alert")).toHaveCount(0);

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("axe reports zero violations with a glossary definition open and a copy confirmed", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // GlossaryTerm.css's popover only animates (cc-fade, 120ms) under
    // `prefers-reduced-motion: no-preference` — real user preference,
    // honoured per SRS §7.15's Motion row. Reducing it here isn't a test
    // convenience layered on top of that CSS rule, it's exercising the
    // rule's OTHER branch, which nothing else in this suite reaches:
    // without it, axe intermittently samples the popover mid-fade
    // (partial opacity blends its text into the background, briefly
    // failing color-contrast) — a real race, not a flaky assertion,
    // caught running this file repeatedly while building step 38.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "indemnity" }).click();
    await page.getByRole("button", { name: "Copy this ask" }).first().click();
    await expect(
      page.getByText("Copied — paste it into your reply to the client."),
    ).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("at 320px, real-length findings with a glossary definition open cause no horizontal scrolling", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    // See the comment on the axe test above — same fade/contrast race.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "assignment" }).click();
    await expect(
      page.getByText("Permanently transferring ownership of the work to someone else."),
    ).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("at desktop width, a definition opened near the right edge flips inward instead of overflowing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await mockReport(page, { findings: REAL_FINDINGS, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");

    for (const name of ["assignment", "indemnity", "acceptance"]) {
      await page.getByRole("button", { name }).click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `opening "${name}"`).toBeLessThanOrEqual(1);
      await page.keyboard.press("Escape");
    }
  });
});

// The prototype's own locked disclaimer wording (docs/design/ClauseCheck.html
// / docs/PRD.md §7), asserted against directly rather than re-typed, so a
// paraphrase anywhere fails this file the same way it fails the unit test.
const DISCLAIMER =
  "ClauseCheck highlights clauses worth a second look before you sign. It isn’t a lawyer and this isn’t legal advice — for a high-stakes contract, have a professional review it.";

/** @param {import("@playwright/test").Page} page @param {object} [overrides] @param {{status:number, body:object}} [deleteResult] */
async function mockReportAndDelete(page, overrides, deleteResult) {
  await page.route("**/api/v1/documents/doc1", (route) => {
    if (route.request().method() === "DELETE") {
      const result = deleteResult ?? {
        status: 200,
        body: { deleted: true, message: "x" },
      };
      return route.fulfill({
        status: result.status,
        contentType: "application/json",
        body: JSON.stringify(result.body),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(analysisPayload(overrides)),
    });
  });
}

test.describe("the disclaimer and missing protections (BUILD-PLAN step 37, NFR-4.1 / PRD §7)", () => {
  test("shows the exact locked disclaimer text, as body text", async ({ page }) => {
    await mockReport(page);
    await page.goto("/documents/doc1");

    const disclaimer = page.getByText(DISCLAIMER);
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toHaveJSProperty("tagName", "P");
  });

  test("the disclaimer is above the fold at desktop width, both for a short report and a long one", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    await mockReport(page, { findings: [], overallRisk: "LOW" });
    await page.goto("/documents/doc1");
    await expect(page.getByText(DISCLAIMER)).toBeInViewport({ ratio: 1 });

    // 12 findings — long enough that the findings list alone runs well
    // past a typical desktop viewport height.
    const severities = /** @type {const} */ (["HIGH", "MEDIUM", "LOW"]);
    const twelveFindings = Array.from({ length: 12 }, (_, i) => ({
      category: "PAYMENT",
      severity: severities[i % 3],
      clauseExcerpt: `Clause ${i}`,
      explanation: `Explanation ${i}`,
      suggestedChange: `Ask ${i}`,
    }));
    await mockReport(page, { findings: twelveFindings, overallRisk: "HIGH" });
    await page.goto("/documents/doc1");
    await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(12);
    await expect(page.getByText(DISCLAIMER)).toBeInViewport({ ratio: 1 });
  });

  test("lists each missing protection as the server's own sentence, under the prototype's heading and sub-copy", async ({
    page,
  }) => {
    await mockReport(page, {
      findings: SEVEN_FINDINGS,
      missingClauses: [
        "No late payment interest or penalty is specified.",
        "There is no cap on the freelancer's liability.",
      ],
    });
    await page.goto("/documents/doc1");

    await expect(
      page.getByRole("heading", { name: "Protections the contract doesn’t include" }),
    ).toBeVisible();
    await expect(
      page.getByText("Nothing here is quoted, because there’s nothing to quote", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("No late payment interest or penalty is specified."),
    ).toBeVisible();
    await expect(
      page.getByText("There is no cap on the freelancer's liability."),
    ).toBeVisible();
  });

  test("renders no missing-protections section when there is nothing missing", async ({
    page,
  }) => {
    await mockReport(page, { findings: SEVEN_FINDINGS, missingClauses: [] });
    await page.goto("/documents/doc1");

    await expect(
      page.getByRole("heading", { name: "Protections the contract doesn’t include" }),
    ).toHaveCount(0);
  });

  test("renders no jurisdiction section (decision D-A)", async ({ page }) => {
    await mockReport(page, {
      findings: SEVEN_FINDINGS,
      missingClauses: ["No late payment interest or penalty is specified."],
    });
    await page.goto("/documents/doc1");

    await expect(page.getByText(/jurisdiction/i)).toHaveCount(0);
  });

  test("axe reports zero violations with missing protections shown", async ({ page }) => {
    await mockReport(page, {
      findings: SEVEN_FINDINGS,
      missingClauses: ["No late payment interest or penalty is specified."],
    });
    await page.goto("/documents/doc1");

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("delete (BUILD-PLAN step 37, FR-7.6)", () => {
  test("requires confirmation naming permanence before anything is deleted", async ({
    page,
  }) => {
    await mockReportAndDelete(page);
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "Delete permanently" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Delete this contract permanently?" }),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "The document and this report will be removed from our database. This can’t be undone, and we won’t be able to recover them for you.",
      ),
    ).toBeVisible();
  });

  test("'Keep it' closes the dialog and deletes nothing", async ({ page }) => {
    let deleteCalls = 0;
    await page.route("**/api/v1/documents/doc1", (route) => {
      if (route.request().method() === "DELETE") {
        deleteCalls += 1;
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(analysisPayload()),
      });
    });
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "Delete permanently" }).click();
    await page.getByRole("button", { name: "Keep it" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/documents\/doc1$/);
    expect(deleteCalls).toBe(0);
  });

  test("confirming deletes the document and redirects to history", async ({ page }) => {
    await mockReportAndDelete(page);
    // The redirect target is the real HistoryPage (step 38) now, not a
    // placeholder — it fetches on mount, so it needs its own mock too.
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [],
          page: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "Delete permanently" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently" })
      .click();

    await expect(page).toHaveURL("/documents");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  });

  test("a failed delete keeps the dialog open and shows the server's error", async ({
    page,
  }) => {
    await mockReportAndDelete(page, undefined, {
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "We couldn't find that. It may have been deleted already.",
          requestId: "req_e2e",
        },
      },
    });
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "Delete permanently" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently" })
      .click();

    await expect(
      page.getByText("We couldn't find that. It may have been deleted already."),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveURL(/\/documents\/doc1$/);
  });

  test("Escape closes the dialog and returns focus to the trigger", async ({ page }) => {
    await mockReportAndDelete(page);
    await page.goto("/documents/doc1");

    const trigger = page.getByRole("button", { name: "Delete permanently" });
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("axe reports zero violations with the delete dialog open", async ({ page }) => {
    await mockReportAndDelete(page);
    await page.goto("/documents/doc1");

    await page.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
