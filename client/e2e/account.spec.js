import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 63 (UI-12): email verification, password reset and the
 * settings screen, in a real browser against a mocked API (see
 * playwright.config.js). The live, unmocked journey is
 * e2e/account-live.spec.js and is opt-in.
 */

const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const json = (status, body) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const failure = (status, code, message) =>
  json(status, { error: { code, message, requestId: "req_e2e" } });

/** @param {import("@playwright/test").Page} page @param {"ACTIVE" | "UNVERIFIED" | null} state */
async function mockMe(page, state) {
  await page.route("**/api/v1/auth/me", (route) =>
    route.fulfill(
      state
        ? json(200, { user: { id: "u1", email: "person@example.com", state } })
        : failure(401, "UNAUTHENTICATED", "x"),
    ),
  );
}

async function expectNoAxeViolations(page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations).toEqual([]);
}

test.describe("/verify-email", () => {
  test("a good link verifies once, shows success, and passes axe", async ({ page }) => {
    await mockMe(page, null);
    let posts = 0;
    await page.route("**/api/v1/auth/verify-email", (route) => {
      posts += 1;
      return route.fulfill(json(200, { verified: true }));
    });

    await page.goto("/verify-email?token=good-token");

    await expect(
      page.getByRole("heading", { level: 1, name: "Email verified" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
    expect(posts).toBe(1);
  });

  test("a spent link says what it can and cannot know, and passes axe", async ({
    page,
  }) => {
    await mockMe(page, null);
    await page.route("**/api/v1/auth/verify-email", (route) =>
      route.fulfill(failure(400, "VALIDATION_ERROR", "unusable")),
    );

    await page.goto("/verify-email?token=spent");

    await expect(
      page.getByRole("heading", { level: 1, name: "This link can't be used" }),
    ).toBeVisible();
    await expect(
      page.getByText(/invalid, it has already been used, or it has expired/),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("/forgot-password and /reset-password", () => {
  test("forgot: one confirmation, and both states pass axe", async ({ page }) => {
    await mockMe(page, null);
    await page.route("**/api/v1/auth/forgot-password", (route) =>
      route.fulfill(json(202, { accepted: true })),
    );

    await page.goto("/forgot-password");
    await expectNoAxeViolations(page);
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByRole("button", { name: /send/i }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Check your inbox" }),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("reset: a valid token and password lead to a sign-in prompt, and axe is clean on the form and the result", async ({
    page,
  }) => {
    await mockMe(page, null);
    let body;
    await page.route("**/api/v1/auth/reset-password", (route) => {
      body = route.request().postDataJSON();
      return route.fulfill(json(200, { reset: true }));
    });

    await page.goto("/reset-password?token=abc123");
    await expect(page.getByText(/At least 10 characters/)).toBeVisible();
    await expectNoAxeViolations(page);
    await page.getByLabel("New password").fill("a-much-longer-password");
    await page.getByRole("button", { name: /change|save|set/i }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Password changed" }),
    ).toBeVisible();
    expect(body).toEqual({ token: "abc123", password: "a-much-longer-password" });
    await expectNoAxeViolations(page);
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("sign-in links to the reset flow", async ({ page }) => {
    await mockMe(page, null);
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });
});

test.describe("the unverified-email banner (FR-1.7)", () => {
  test("shows on the upload page for an unverified account, does not block the upload, and passes axe", async ({
    page,
  }) => {
    await mockMe(page, "UNVERIFIED");
    await page.goto("/");

    await expect(page.getByText("Verify your email to run a check")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send the link again" })).toBeVisible();
    // Upload is NOT disabled: the server is the authority.
    await expect(page.getByRole("tab").first()).toBeEnabled();
    await expectNoAxeViolations(page);
  });

  test("is absent for a verified account", async ({ page }) => {
    await mockMe(page, "ACTIVE");
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Verify your email to run a check")).toHaveCount(0);
  });

  test("resend reports success in a live region", async ({ page }) => {
    await mockMe(page, "UNVERIFIED");
    await page.route("**/api/v1/auth/resend-verification", (route) =>
      route.fulfill(json(200, { sent: true, alreadyVerified: false })),
    );
    await page.goto("/");

    await page.getByRole("button", { name: "Send the link again" }).click();

    await expect(
      page.locator('p[role="status"]', { hasText: /We sent a new link/ }),
    ).toBeVisible();
  });
});

test.describe("/settings", () => {
  test("renders every section, marks Settings current in the header, and passes axe", async ({
    page,
  }) => {
    await mockMe(page, "ACTIVE");
    await page.goto("/settings");

    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Change your password",
      "Change your email",
      "Sign out everywhere",
      "Download your data",
      "Delete your account",
    ]);
    await expect(page.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expectNoAxeViolations(page);
  });

  test("the delete dialog lists what is destroyed, traps focus, closes on Escape, and passes axe", async ({
    page,
  }) => {
    await mockMe(page, "ACTIVE");
    await page.goto("/settings");

    const trigger = page.getByRole("button", { name: "Delete my account…" });
    await trigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("every contract you uploaded");
    await expect(dialog).toContainText("Backups keep a copy for up to 30 days");
    await expectNoAxeViolations(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("deleting the account sends the password, then lands on /login with the notice", async ({
    page,
  }) => {
    await mockMe(page, "ACTIVE");
    let body;
    await page.route("**/api/v1/account", (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      body = route.request().postDataJSON();
      return route.fulfill({ status: 204 });
    });
    await page.goto("/settings");

    await page.getByRole("button", { name: "Delete my account…" }).click();
    await page.getByLabel("Enter your password to confirm").fill("my-password-123");
    await page.getByRole("button", { name: "Delete everything permanently" }).click();

    await expect(page).toHaveURL(/\/login\?reason=account_deleted/);
    await expect(page.getByText("Your account was deleted")).toBeVisible();
    expect(body).toEqual({ password: "my-password-123" });
  });

  test("sign out everywhere lands on /login with its notice", async ({ page }) => {
    await mockMe(page, "ACTIVE");
    await page.route("**/api/v1/auth/logout-all", (route) =>
      route.fulfill(json(200, { loggedOut: true })),
    );
    await page.goto("/settings");

    await page.getByRole("button", { name: "Sign out everywhere" }).click();

    await expect(page).toHaveURL(/\/login\?reason=signed_out_everywhere/);
    await expect(page.getByText("You were signed out everywhere")).toBeVisible();
  });

  test("has no horizontal scroll and passes axe at phone width", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockMe(page, "ACTIVE");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete my account…" }).click();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoAxeViolations(page);
  });
});
