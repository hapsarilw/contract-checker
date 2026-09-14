import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 32 — "Write a Playwright test with axe assertions on
 * both screens." See playwright.config.js's file comment for why these
 * mock the API rather than requiring a live backend.
 */

/** @param {import("@playwright/test").Page} page */
function mockUnauthenticated(page) {
  return page.route("**/api/v1/auth/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "UNAUTHENTICATED", message: "x", requestId: "req_e2e" },
      }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  // Every screen this file visits calls GET /api/v1/auth/me on load
  // (AuthProvider, FR-7.7) — mocked to "nobody's signed in" by default so
  // /login and /register render as a first-time visitor would see them,
  // not flash through a loading state waiting on a real network call.
  await mockUnauthenticated(page);
});

test.describe("/login", () => {
  test("renders the sign-in form matching the prototype's copy, one h1, no password rules shown", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    // Login doesn't need a password RULE reminder — the account already
    // exists. This is the prototype's own distinction (pwHint is blank
    // outside register mode), kept.
    await expect(page.getByText(/No symbol requirements/)).toHaveCount(0);
  });

  test("has a working skip link as the first focusable element", async ({ page }) => {
    await page.goto("/login");
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("a short/empty field shows an error associated via aria-describedby with aria-invalid set", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();

    const email = page.getByLabel("Email");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    const describedBy = await email.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The error text names the fix (NFR-4.3 / SRS §7.15), not only what
    // failed.
    await expect(page.locator(`#${describedBy}`)).toHaveText(
      /Enter a valid email address/,
    );
  });

  test("a 401 INVALID_CREDENTIALS shows the failure banner, announced as an alert", async ({
    page,
  }) => {
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "INVALID_CREDENTIALS",
            message:
              "The email or password you entered is incorrect. Check your details and try again.",
            requestId: "req_e2e_2",
          },
        }),
      }),
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password").fill("wrongpasswordhere");
    await page.getByRole("button", { name: "Sign in" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("incorrect");
    await expect(alert).toContainText("INVALID_CREDENTIALS");
  });

  test("a successful sign-in navigates to /", async ({ page }) => {
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "person@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );
    // Once "signed in", subsequent /me checks (RequireAuth on "/") must
    // reflect that — otherwise the redirect just bounces straight back
    // to /login.
    await page.unroute("**/api/v1/auth/me");
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "person@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("person@example.com");
    await page.getByLabel("Password").fill("correcthorsebattery");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL("/");
  });

  test("axe reports zero violations", async ({ page }) => {
    await page.goto("/login");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("axe reports zero violations in the field-error state", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("/register", () => {
  test("states the password rule before any submission — PRD §6", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Create your account",
    );
    // Present immediately, with an untouched, never-submitted form.
    await expect(
      page.getByText(
        "At least 10 characters. No symbol requirements — length does the work.",
      ),
    ).toBeVisible();
  });

  test("a too-short password is rejected client-side with an accessible, fix-naming error", async ({
    page,
  }) => {
    await page.goto("/register");
    await page.getByLabel("Email").fill("new@example.com");
    await page.getByLabel("Password").fill("short1");
    await page.getByRole("button", { name: "Create account" }).click();

    const password = page.getByLabel("Password");
    await expect(password).toHaveAttribute("aria-invalid", "true");
    const describedBy = await password.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // Register's password field is described by BOTH the static rule
    // hint and the error once one exists (TextField, step 30) — two
    // space-separated ids, so each is queried by its own #id rather than
    // treating the whole attribute value as a single CSS selector.
    const errorId = /** @type {string} */ (describedBy).split(" ").at(-1);
    await expect(page.locator(`#${errorId}`)).toContainText("at least 10 characters");
  });

  test("registering routes to the upload screen (FR-1.7: UNVERIFIED can still sign in)", async ({
    page,
  }) => {
    await page.route("**/api/v1/auth/register", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u2", email: "new@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );
    await page.unroute("**/api/v1/auth/me");
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u2", email: "new@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );

    await page.goto("/register");
    await page.getByLabel("Email").fill("new@example.com");
    await page.getByLabel("Password").fill("a-perfectly-fine-password");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByText("Signed in.")).toBeVisible();
  });

  test("a 409 EMAIL_TAKEN shows the failure banner", async ({ page }) => {
    await page.route("**/api/v1/auth/register", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "EMAIL_TAKEN",
            message:
              "An account with that email already exists. Try logging in, or reset your password if you've forgotten it.",
            requestId: "req_e2e_3",
          },
        }),
      }),
    );

    await page.goto("/register");
    await page.getByLabel("Email").fill("taken@example.com");
    await page.getByLabel("Password").fill("a-perfectly-fine-password");
    await page.getByRole("button", { name: "Create account" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("already exists");
    await expect(alert).toContainText("EMAIL_TAKEN");
  });

  test("axe reports zero violations", async ({ page }) => {
    await page.goto("/register");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe("route guard (FR-7.1)", () => {
  test("unauthenticated access to / redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  });

  test("that redirect carries NO session_expired reason — a visitor who was never signed in is not told their session expired", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page).not.toHaveURL(/reason=session_expired/);
    await expect(page.getByText("You were signed out")).toHaveCount(0);
  });

  test("the returnTo path survives the round trip through login", async ({ page }) => {
    await page.route("**/api/v1/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "person@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );

    await page.goto("/");
    await expect(page).toHaveURL(/returnTo=%2F/);

    await page.unroute("**/api/v1/auth/me");
    await page.route("**/api/v1/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "person@example.com", accountState: "UNVERIFIED" },
        }),
      }),
    );
    await page.getByLabel("Email").fill("person@example.com");
    await page.getByLabel("Password").fill("correcthorsebattery");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL("/");
  });
});
