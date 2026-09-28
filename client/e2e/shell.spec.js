import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 39 — "Write a test walking the full authenticated
 * journey: login, upload, analyze, report, history, and back." Plus
 * this step's other Done-when items: all nine FR-7.1 routes resolve,
 * unauthenticated access to a non-auth route redirects, app chrome is
 * hidden on auth screens, every route has an error boundary (that last
 * one is tests/unit/App.test.jsx — a thrown render error is easier to
 * inject with a mocked page component than through the real network-
 * shaped mocks this file uses for everything else).
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** @param {import("@playwright/test").Page} page @param {{ authenticated?: boolean }} [options] */
async function mockMe(page, { authenticated = false } = {}) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: authenticated ? 200 : 401,
      contentType: "application/json",
      body: authenticated
        ? JSON.stringify({
            user: { id: "u1", email: "person@example.com", state: "ACTIVE" },
          })
        : JSON.stringify({
            error: { code: "UNAUTHENTICATED", message: "x", requestId: "r" },
          }),
    }),
  );
}

test.describe("route table and guards (BUILD-PLAN step 39, FR-7.1)", () => {
  test.describe("the three password/verification screens — reachable without signing in, no app chrome", () => {
    for (const [path, title] of /** @type {const} */ ([
      ["/verify-email", "This link is incomplete"],
      ["/forgot-password", "Forgot your password?"],
      ["/reset-password", "This link is incomplete"],
    ])) {
      test(path, async ({ page }) => {
        await mockMe(page, { authenticated: false });
        await page.goto(path);

        await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
        await expect(page.getByRole("banner")).toHaveCount(0);
        await expect(page).toHaveURL(path);
      });
    }
  });

  test("/settings redirects an unauthenticated visitor to /login", async ({ page }) => {
    await mockMe(page, { authenticated: false });
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);
  });

  test("/settings renders the settings screen with the app chrome once authenticated", async ({
    page,
  }) => {
    await mockMe(page, { authenticated: true });
    await page.goto("/settings");

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("link", { name: "New contract" })).toBeVisible();
  });

  test("an unmatched path renders the 404 page, in the app's own visual language", async ({
    page,
  }) => {
    await mockMe(page, { authenticated: true });
    await page.goto("/this-does-not-exist");

    await expect(page.getByText("There’s nothing at this address.")).toBeVisible();
    await page.getByRole("link", { name: "Back to ClauseCheck" }).click();
    await expect(page).toHaveURL("/");
  });

  test("axe reports zero violations on an auth-flow screen and on the 404 page", async ({
    page,
  }) => {
    await mockMe(page, { authenticated: false });
    await page.goto("/forgot-password");
    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.goto("/no-such-route");
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("the app chrome (BUILD-PLAN step 39)", () => {
  test("is hidden on /login and /register", async ({ page }) => {
    await mockMe(page, { authenticated: false });
    await page.goto("/login");
    await expect(page.getByRole("banner")).toHaveCount(0);

    await page.goto("/register");
    await expect(page.getByRole("banner")).toHaveCount(0);
  });

  test("is shown on every protected screen, with 'New contract' current on /", async ({
    page,
  }) => {
    await mockMe(page, { authenticated: true });
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
    await page.goto("/");

    await expect(page.getByRole("banner")).toBeVisible();
    const newContract = page.getByRole("link", { name: "New contract" });
    await expect(newContract).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL("/documents");
    await expect(page.getByRole("link", { name: "History" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(newContract).not.toHaveAttribute("aria-current", "page");
  });

  test("'Sign out' calls the real logout endpoint and lands back on /login", async ({
    page,
  }) => {
    await mockMe(page, { authenticated: true });
    let logoutCalled = false;
    await page.route("**/api/v1/auth/logout", (route) => {
      logoutCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });
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
    await page.goto("/");

    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page).toHaveURL(/\/login/);
    expect(logoutCalled).toBe(true);
  });
});

test.describe("the full authenticated journey (BUILD-PLAN step 39)", () => {
  test("login, upload, analyze, report, history, and back", async ({ page }) => {
    // Starts signed out.
    await mockMe(page, { authenticated: false });
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "person@example.com", state: "ACTIVE" },
        }),
      }),
    );
    await page.route("**/api/v1/documents", (route) => {
      if (route.request().method() !== "POST") return route.continue();
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          document: {
            id: "doc1",
            filename: null,
            sourceType: "PASTE",
            wordCount: 250,
            createdAt: "2026-01-05T00:00:00.000Z",
          },
        }),
      });
    });
    await page.route("**/api/v1/documents/doc1/analyze", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          analysis: {
            id: "an1",
            status: "COMPLETED",
            overallRisk: "MEDIUM",
            summary: "A generally fair agreement with one clause worth a second look.",
            findings: [
              {
                category: "PAYMENT",
                severity: "MEDIUM",
                clauseExcerpt: "Payment is due net-60 from invoice date.",
                explanation:
                  "Net-60 means financing the client's project for two months.",
                suggestedChange: "Ask for net-14 or net-30 from the invoice date.",
              },
            ],
            missingClauses: [],
            discardedFindings: 0,
            createdAt: "2026-01-05T00:01:00.000Z",
          },
        }),
      }),
    );
    await page.route("**/api/v1/documents/doc1", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          document: {
            id: "doc1",
            filename: null,
            sourceType: "PASTE",
            wordCount: 250,
            createdAt: "2026-01-05T00:00:00.000Z",
          },
          analysis: {
            id: "an1",
            status: "COMPLETED",
            overallRisk: "MEDIUM",
            summary: "A generally fair agreement with one clause worth a second look.",
            findings: [
              {
                category: "PAYMENT",
                severity: "MEDIUM",
                clauseExcerpt: "Payment is due net-60 from invoice date.",
                explanation:
                  "Net-60 means financing the client's project for two months.",
                suggestedChange: "Ask for net-14 or net-30 from the invoice date.",
              },
            ],
            missingClauses: [],
            discardedFindings: 0,
            createdAt: "2026-01-05T00:01:00.000Z",
          },
        }),
      });
    });

    // 1. Login.
    await page.goto("/login");
    await expect(page.getByRole("banner")).toHaveCount(0);
    await page.getByLabel("Email").fill("person@example.com");
    await page.getByLabel("Password").fill("correcthorsebattery");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/");

    // From here on, every /me check reflects the now-signed-in session.
    await page.unroute("**/api/v1/auth/me");
    await mockMe(page, { authenticated: true });

    // 2. Upload (paste).
    await expect(page.getByRole("banner")).toBeVisible();
    await page.getByRole("tab", { name: "Paste the text" }).click();
    await page
      .getByLabel("Paste the contract text")
      .fill("a contract with enough words to clear the two-hundred-word floor".repeat(6));
    await page.getByRole("button", { name: "Check this contract" }).click();

    // 3. Analyze — not asserting the stage list's text specifically (a
    // mocked analyze route can resolve before Playwright ever observes
    // the intermediate running state, e2e/analyzing.spec.js's own
    // startAnalyzing() helper hit exactly this race); leaving the
    // upload form is the one thing this step can reliably assert.
    await expect(
      page.getByRole("heading", { name: "Hand over the contract." }),
    ).toHaveCount(0);

    // 4. Report.
    await expect(page).toHaveURL("/documents/doc1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Medium");
    await expect(page.getByRole("banner")).toBeVisible();

    // 5. History, reached from the report's own "Back to history" link.
    await page.route("**/api/v1/documents", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [
            {
              id: "doc1",
              filename: "Pasted text",
              wordCount: 250,
              overallRisk: "MEDIUM",
              findingCount: 1,
              createdAt: "2026-01-05T00:01:00.000Z",
            },
          ],
          page: { nextCursor: null, hasMore: false },
        }),
      });
    });
    await page.getByRole("link", { name: "Back to history" }).click();
    await expect(page).toHaveURL("/documents");
    await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
    await expect(page.getByText("Pasted text")).toBeVisible();

    // 6. And back — to the upload screen, via the nav, completing the loop.
    await page.getByRole("link", { name: "New contract" }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByRole("heading", { name: "Hand over the contract." }),
    ).toBeVisible();
  });
});
