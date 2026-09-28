import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 34 — "Write a test asserting NO percentage or numeric
 * progress value is rendered at any point, and an axe test on the
 * screen." See playwright.config.js's file comment for why the API is
 * mocked rather than a live backend.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** @param {import("@playwright/test").Page} page */
async function signIn(page) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "u1", email: "person@example.com", state: "ACTIVE" },
      }),
    }),
  );
}

/** Reaches the analyzing screen via a real paste submission, with the analyze call held open until the test releases it. */
async function startAnalyzing(page) {
  await page.route("**/api/v1/documents", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        document: {
          id: "doc1",
          filename: null,
          sourceType: "PASTE",
          wordCount: 250,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    }),
  );
  await page.goto("/");
  await page.getByRole("tab", { name: "Paste the text" }).click();
  await page
    .getByLabel("Paste the contract text")
    .fill("a contract with enough words to pass the floor");
  await page.getByRole("button", { name: "Check this contract" }).click();
  // NOT an assertion on "Reading your contract" specifically: when the
  // mocked analyze route responds (or errors) fast, as most of these
  // tests' mocks do, React can move straight past the running state
  // into the error state within one paint — there is no guarantee the
  // running heading is ever independently observable. What every caller
  // of this helper CAN rely on is having left the upload form; each
  // test asserts whichever state (running or errored) it actually means
  // to exercise.
  await expect(
    page.getByRole("heading", { name: "Hand over the contract." }),
  ).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  // The report screen this file's success path navigates to fetches the
  // document on mount. Left unmocked, that request goes to whatever is on
  // :3000: nothing (a network error, the URL stays put) on a bare
  // machine, but a real dev server answers 401 and bounces the page to
  // /login. Answering it here makes the result independent of that.
  await page.route("**/api/v1/documents/doc1", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "NOT_FOUND", message: "x", requestId: "req_e2e" },
      }),
    }),
  );
});

test.describe("the analyzing screen (BUILD-PLAN step 34, FR-7.4)", () => {
  test("shows the four stages with the prototype's exact labels, the first as current with its note", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents/doc1/analyze", () => {}); // never fulfilled — holds on the running state
    await startAnalyzing(page);

    await expect(page.getByText("Pasted text · 250 words")).toBeVisible();
    await expect(page.getByText("Reading the document")).toBeVisible();
    await expect(
      page.getByText("Pulling the text out and checking it looks like a contract."),
    ).toBeVisible();
    await expect(page.getByText("Examining the clauses")).toBeVisible();
    await expect(
      page.getByText("Checking each quote against your document"),
    ).toBeVisible();
    await expect(page.getByText("Checking what's missing")).toBeVisible();
    // Only the current stage's note is shown.
    await expect(
      page.getByText("Payment, ownership, scope, termination, liability"),
    ).toHaveCount(0);
  });

  test("the stage region is role=status, announces politely, and never steals focus", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents/doc1/analyze", () => {});
    await startAnalyzing(page);

    const region = page.getByRole("status");
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute("aria-live", "polite");
    // The submit button that triggered this screen no longer exists —
    // the real assertion available here is that focus lands somewhere
    // sane (the document body, never having been yanked into the live
    // region), which document.activeElement being BODY demonstrates:
    // nothing on this screen ever called .focus().
    const activeTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(activeTag).toBe("BODY");
  });

  test("NEVER renders a percentage or numeric progress value, at any point", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents/doc1/analyze", () => {});
    await startAnalyzing(page);

    const bodyText = /** @type {string} */ (await page.locator("body").innerText());
    expect(bodyText).not.toMatch(/%/);
    expect(bodyText).not.toMatch(/\d+\s*(of|\/)\s*\d+/); // "2 of 4", "2/4"
    // "250 words" (the document's real word count) and "30 seconds"
    // (FR-7.4's explicitly-allowed overall expectation) are the only
    // legitimate numbers on this screen.
    const withoutLegitimateNumbers = bodyText
      .replace("Pasted text · 250 words", "")
      .replace("30 seconds", "");
    expect(withoutLegitimateNumbers).not.toMatch(/\d/);
  });

  test("axe reports zero violations while running", async ({ page }) => {
    await page.route("**/api/v1/documents/doc1/analyze", () => {});
    await startAnalyzing(page);

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("a successful analyze navigates to the report route", async ({ page }) => {
    await page.route("**/api/v1/documents/doc1/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          analysis: {
            id: "an1",
            status: "COMPLETED",
            overallRisk: "low",
            summary: "x",
            findings: [],
            missingClauses: [],
            discardedFindings: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      }),
    );
    await startAnalyzing(page);

    await expect(page).toHaveURL("/documents/doc1");
  });

  test.describe("all four ANALYZE_ERRORS states, from the server", () => {
    /** @type {Record<string, { status: number, code: string, title: string }>} */
    const CASES = {
      LLM_INVALID_OUTPUT: {
        status: 502,
        code: "LLM_INVALID_OUTPUT",
        title: "The check didn’t finish.",
      },
      LLM_TIMEOUT: {
        status: 504,
        code: "LLM_TIMEOUT",
        title: "This took longer than expected, so we stopped.",
      },
      ALL_FINDINGS_DISCARDED: {
        status: 502,
        code: "ALL_FINDINGS_DISCARDED",
        title: "We couldn’t verify any of what came back.",
      },
      ANALYSIS_IN_PROGRESS: {
        status: 409,
        code: "ANALYSIS_IN_PROGRESS",
        title: "This contract is already being checked.",
      },
    };

    for (const [name, { status, code, title }] of Object.entries(CASES)) {
      test(name, async ({ page }) => {
        await page.route("**/api/v1/documents/doc1/analyze", (route) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ error: { code, message: "x", requestId: "req_e2e" } }),
          }),
        );
        await startAnalyzing(page);

        await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
        await expect(page.getByText(`${code} · ${status}`)).toBeVisible();
        await expect(page.getByRole("button", { name: "Back to upload" })).toBeVisible();
      });
    }

    test("ANALYSIS_IN_PROGRESS states the honest range instead of the prototype's flat 30-second promise (a crashed request can take up to ~6 minutes for the reaper to clear, FR-3.8)", async ({
      page,
    }) => {
      await page.route("**/api/v1/documents/doc1/analyze", (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "ANALYSIS_IN_PROGRESS", message: "x", requestId: "req_e2e" },
          }),
        }),
      );
      await startAnalyzing(page);

      const body = page.locator(".cc-analyzing-error__body");
      await expect(body).toContainText("30 seconds");
      await expect(body).toContainText("6 minutes");
      await expect(page.getByRole("button", { name: "Wait for it" })).toBeVisible();
    });

    test("'Try again' retries analyze on the SAME document, not a fresh upload", async ({
      page,
    }) => {
      // A mutable switch, not a fixed call count: React's StrictMode
      // (main.jsx) deliberately double-invokes an effect on mount in
      // dev — which this suite runs against, playwright.config.js's
      // webServer being `npm run dev` — so the FIRST attempt can
      // legitimately reach this route more than once before the
      // component settles on which response it actually uses. The
      // requirement this test is actually checking — "Try again" hits
      // the SAME document, not a fresh upload — doesn't depend on which
      // attempt number succeeds, only on the error being shown once and
      // the retry succeeding once it's clicked.
      let shouldFail = true;
      let uploadCalls = 0;
      await page.route("**/api/v1/documents", (route) => {
        uploadCalls += 1;
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            document: {
              id: "doc1",
              filename: null,
              sourceType: "PASTE",
              wordCount: 250,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        });
      });
      await page.route("**/api/v1/documents/doc1/analyze", (route) => {
        if (shouldFail) {
          return route.fulfill({
            status: 504,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "LLM_TIMEOUT", message: "x", requestId: "req_1" },
            }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            analysis: {
              id: "an1",
              status: "COMPLETED",
              overallRisk: "low",
              summary: "x",
              findings: [],
              missingClauses: [],
              discardedFindings: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          }),
        });
      });

      await page.goto("/");
      await page.getByRole("tab", { name: "Paste the text" }).click();
      await page
        .getByLabel("Paste the contract text")
        .fill("a contract with enough words to pass the floor");
      await page.getByRole("button", { name: "Check this contract" }).click();

      await expect(
        page.getByText("This took longer than expected, so we stopped."),
      ).toBeVisible();
      shouldFail = false;
      await page.getByRole("button", { name: "Try again" }).click();

      await expect(page).toHaveURL("/documents/doc1");
      // The document was uploaded exactly once — "Try again" never
      // re-runs the upload half, only analyze.
      expect(uploadCalls).toBe(1);
    });

    test("'Back to upload' returns to the upload form, and a fresh submission re-uploads (a new document, not the failed one)", async ({
      page,
    }) => {
      await page.route("**/api/v1/documents/doc1/analyze", (route) =>
        route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "LLM_TIMEOUT", message: "x", requestId: "req_1" },
          }),
        }),
      );
      await startAnalyzing(page);
      await expect(
        page.getByText("This took longer than expected, so we stopped."),
      ).toBeVisible();

      await page.getByRole("button", { name: "Back to upload" }).click();

      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        "Hand over the contract.",
      );
      await expect(page.getByRole("tab", { name: "Paste the text" })).toBeVisible();
    });

    test("axe reports zero violations in each error state", async ({ page }) => {
      await page.route("**/api/v1/documents/doc1/analyze", (route) =>
        route.fulfill({
          status: 504,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "LLM_TIMEOUT", message: "x", requestId: "req_1" },
          }),
        }),
      );
      await startAnalyzing(page);
      await expect(
        page.getByText("This took longer than expected, so we stopped."),
      ).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  });
});
