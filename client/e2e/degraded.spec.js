import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 64 (FR-7.10, FR-7.12): degraded mode and session expiry,
 * in a browser against a mocked API.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const USER = { id: "u1", email: "person@example.com", state: "ACTIVE" };
const PASTE = "a contract with enough words to pass the floor";

const json = (status, body, headers = {}) => ({
  status,
  contentType: "application/json",
  headers,
  body: JSON.stringify(body),
});
const failure = (status, code, message, headers = {}) =>
  json(status, { error: { code, message, requestId: "req_e2e" } }, headers);

const HISTORY_ROW = {
  id: "a",
  filename: "old-msa.pdf",
  wordCount: 900,
  overallRisk: "HIGH",
  findingCount: 5,
  createdAt: "2026-01-05T00:00:00.000Z",
};

/** @param {import("@playwright/test").Page} page */
async function mockReads(page) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill(json(200, { user: USER })),
  );
  await page.route("**/api/v1/documents", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill(
        json(201, {
          document: { id: "doc1", filename: null, sourceType: "PASTE", wordCount: 250 },
        }),
      );
    }
    return route.fulfill(
      json(200, { documents: [HISTORY_ROW], page: { nextCursor: null, hasMore: false } }),
    );
  });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} code
 * @param {string} message
 * @param {number} retryAfter
 */
async function mockAnalyzeDegraded(page, code, message, retryAfter) {
  let calls = 0;
  await page.route("**/api/v1/documents/doc1/analyze", (route) => {
    calls += 1;
    return route.fulfill(
      failure(503, code, message, {
        "Retry-After": String(retryAfter),
        "Access-Control-Expose-Headers": "Retry-After",
      }),
    );
  });
  return () => calls;
}

/** @param {import("@playwright/test").Page} page */
async function pasteAndCheck(page) {
  await page.getByRole("tab", { name: "Paste the text" }).click();
  await page.getByLabel("Paste the contract text").fill(PASTE);
  await page.getByRole("button", { name: "Check this contract" }).click();
}

test.describe("degraded mode (FR-7.10)", () => {
  test("LLM_UNAVAILABLE: the attempt explains itself, then the banner stays, analyze is disabled, and history still loads", async ({
    page,
  }) => {
    await mockReads(page);
    const analyzeCalls = await mockAnalyzeDegraded(
      page,
      "LLM_UNAVAILABLE",
      "The analysis service is temporarily unavailable.",
      60,
    );
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Check this contract" })).toHaveCount(
      0,
    );

    await pasteAndCheck(page);

    // The attempt that discovered it gets the specific card, and its way
    // forward is the saved reports, not a retry that cannot work.
    await expect(
      page.getByRole("heading", { level: 1, name: "Checking is paused for a moment." }),
    ).toBeVisible();
    await page.getByRole("link", { name: "See your saved reports" }).click();

    // PRD D13: reads keep working.
    await expect(page).toHaveURL("/documents");
    await expect(page.getByText("old-msa.pdf")).toBeVisible();

    // Back on the upload screen: the banner, and a disabled button.
    await page.getByRole("link", { name: "New contract" }).click();
    const banner = page.getByRole("status").filter({
      hasText: "Analysis is temporarily unavailable — your saved reports are still here",
    });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("in about a minute");
    await page.getByRole("tab", { name: "Paste the text" }).click();
    await page.getByLabel("Paste the contract text").fill(PASTE);
    await expect(
      page.getByRole("button", { name: "Check this contract" }),
    ).toBeDisabled();
    await expect(page.locator("#main")).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    // A reload does not hand the person a working-looking button that
    // would fail again.
    await page.reload();
    await expect(banner).toBeVisible();

    // The banner's own link goes to the reports.
    await banner.getByRole("link", { name: "Go to your saved reports" }).click();
    await expect(page).toHaveURL("/documents");

    expect(analyzeCalls()).toBe(1);
  });

  test("SPEND_LIMIT_REACHED shows the server's own words, which say something different for an operator's pause", async ({
    page,
  }) => {
    await mockReads(page);
    const paused =
      "Contract analysis is paused while we look into something. Your existing reports are unaffected and still readable.";
    await mockAnalyzeDegraded(page, "SPEND_LIMIT_REACHED", paused, 3600);
    await page.goto("/");
    await pasteAndCheck(page);
    await expect(
      page.getByRole("heading", { level: 1, name: "Checking is paused for now." }),
    ).toBeVisible();
    await expect(page.getByText(paused)).toBeVisible();

    await page.getByRole("button", { name: "Back to upload" }).click();
    const banner = page.getByRole("status").filter({ hasText: paused });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("in about an hour");
  });

  test("the banner goes and analyze comes back once Retry-After has passed, without a reload", async ({
    page,
  }) => {
    await page.clock.install();
    await mockReads(page);
    await mockAnalyzeDegraded(page, "LLM_UNAVAILABLE", "x", 60);
    await page.goto("/");
    await pasteAndCheck(page);
    await page.getByRole("button", { name: "Back to upload" }).click();
    await expect(page.getByText("Analysis is temporarily unavailable")).toBeVisible();

    await page.clock.fastForward(61_000);

    await expect(page.getByText("Analysis is temporarily unavailable")).toHaveCount(0);
    await page.getByRole("tab", { name: "Paste the text" }).click();
    await page.getByLabel("Paste the contract text").fill(PASTE);
    await expect(page.getByRole("button", { name: "Check this contract" })).toBeEnabled();
  });
});

test.describe("session expiry (FR-7.12)", () => {
  test("SESSION_REVOKED explains why, passes axe, and signing in again returns to where the person was", async ({
    page,
  }) => {
    // Signed in until the server says the session was revoked; from then
    // on /me says so too, as the real server would.
    let revoked = false;
    let revokedOnce = false;
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill(
        revoked ? failure(401, "SESSION_REVOKED", "x") : json(200, { user: USER }),
      ),
    );
    await page.route("**/api/v1/documents", (route) => {
      if (!revokedOnce) {
        revokedOnce = true;
        revoked = true;
        return route.fulfill(failure(401, "SESSION_REVOKED", "x"));
      }
      return route.fulfill(
        json(200, {
          documents: [HISTORY_ROW],
          page: { nextCursor: null, hasMore: false },
        }),
      );
    });
    await page.route("**/api/v1/auth/login", (route) => {
      revoked = false;
      return route.fulfill(json(200, { user: USER }));
    });

    await page.goto("/documents");

    await expect(page).toHaveURL(
      /\/login\?reason=session_revoked&returnTo=%2Fdocuments$/,
    );
    await expect(
      page.getByText("You were signed out because your password changed"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "reset your password" })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.getByLabel("Email").fill("person@example.com");
    await page.getByLabel("Password").fill("the-new-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL("/documents");
    await expect(page.getByText("old-msa.pdf")).toBeVisible();
  });

  test("an expired session (UNAUTHENTICATED) says it expired, not that the password changed", async ({
    page,
  }) => {
    let expired = false;
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill(
        expired ? failure(401, "UNAUTHENTICATED", "x") : json(200, { user: USER }),
      ),
    );
    await page.route("**/api/v1/documents", (route) => {
      expired = true;
      return route.fulfill(failure(401, "UNAUTHENTICATED", "x"));
    });

    await page.goto("/documents");

    await expect(page).toHaveURL(/reason=session_expired/);
    await expect(page.getByText("Your session expired.")).toBeVisible();
    await expect(page.getByText(/password changed/)).toHaveCount(0);
  });
});
