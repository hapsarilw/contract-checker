import { test, expect } from "@playwright/test";
import { USER, mockApi } from "./support/mockApi.js";

/**
 * Step 75: the session check on a cold load during a database outage.
 * Before this, GET /auth/me answering 503 DATABASE_UNAVAILABLE was read as
 * "not signed in": a signed-in person reloading the app was sent to the
 * sign-in page, where signing in then failed with the same 503. Now a
 * protected route stays where it is, says the service cannot be reached,
 * and opens as soon as the check succeeds, by itself or on request.
 */

const DB_DOWN =
  "We can't reach your saved contracts and reports for a moment. Nothing has been lost. Try again in a minute.";

/**
 * /me answers 503 while `outage.down` is true, then the signed-in user.
 * Registered after mockApi's own /me route, so it takes precedence.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{ retryAfter?: number }} [options]
 */
async function databaseOutage(page, { retryAfter = 30 } = {}) {
  const outage = { down: true, checks: 0 };
  await page.route("**/api/v1/auth/me", (route) => {
    outage.checks += 1;
    return route.fulfill(
      outage.down
        ? {
            status: 503,
            contentType: "application/json",
            // Cross-origin, as the real API is: the server exposes Retry-After
            // through CORS (app.js), so the mock must too.
            headers: {
              "Retry-After": String(retryAfter),
              "Access-Control-Expose-Headers": "Retry-After",
            },
            body: JSON.stringify({
              error: { code: "DATABASE_UNAVAILABLE", message: DB_DOWN, requestId: "r" },
            }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ user: USER }),
          },
    );
  });
  return outage;
}

test.beforeEach(async ({ page }) => {
  await mockApi(page, { signedIn: true });
});

test("a protected route stays put and says the service can't be reached, not 'sign in'", async ({
  page,
}) => {
  await databaseOutage(page);
  await page.goto("/documents");

  await expect(
    page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Nothing has been lost");
  await expect(page).toHaveURL("/documents");
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
});

test("'Try again now' opens the page once the database is back", async ({ page }) => {
  const outage = await databaseOutage(page);
  await page.goto("/documents");
  await expect(
    page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
  ).toBeVisible();

  outage.down = false;
  await page.getByRole("button", { name: "Try again now" }).click();

  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page).toHaveURL("/documents");
  await expect(
    page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
  ).toHaveCount(0);
});

test("it checks again by itself after the server's Retry-After, with nobody pressing anything", async ({
  page,
}) => {
  const outage = await databaseOutage(page, { retryAfter: 1 });
  await page.goto("/documents");
  await expect(
    page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
  ).toBeVisible();

  outage.down = false;
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
    timeout: 5_000,
  });
  expect(outage.checks).toBeGreaterThanOrEqual(2);
});

test("keyboard: the skip link comes first, and focus stays on the button while a retry runs", async ({
  page,
}) => {
  await databaseOutage(page);
  await page.goto("/documents");
  await expect(
    page.getByRole("heading", { level: 1, name: /can’t be reached/ }),
  ).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();

  // Hold the retry's answer, so the "Trying again…" state can be looked at.
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    await held;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: USER }),
    });
  });

  const button = page.getByRole("button", { name: "Try again now" });
  await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");

  const checking = page.getByRole("button", { name: "Trying again…" });
  await expect(checking).toBeFocused();
  await expect(checking).toHaveAttribute("aria-disabled", "true");

  release();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
});

test("the sign-in page is unchanged during the outage: it still renders its form", async ({
  page,
}) => {
  await databaseOutage(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
