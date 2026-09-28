import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * BUILD-PLAN step 38 — "the list paginates; deleting from the list
 * updates it without duplicating rows; timestamps render in the browser
 * timezone; axe clean on both states." See playwright.config.js's file
 * comment for why the API is mocked rather than a live backend.
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

/** @param {string} id @param {object} [overrides] */
function row(id, overrides = {}) {
  return {
    id,
    filename: `contract-${id}.pdf`,
    wordCount: 900,
    overallRisk: "MEDIUM",
    findingCount: 2,
    createdAt: "2026-01-05T00:00:00.000Z",
    ...overrides,
  };
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe("the history list (BUILD-PLAN step 38, FR-4.1 / FR-7.14)", () => {
  test("matches the prototype's empty state and links to the upload screen", async ({
    page,
  }) => {
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
    await page.goto("/documents");

    await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
    await expect(page.getByText("No contracts checked yet.")).toBeVisible();
    await expect(
      page.getByText("Every contract you check is listed here."),
    ).toBeVisible();

    await page.getByRole("link", { name: "Check your first contract" }).click();
    await expect(page).toHaveURL("/");
  });

  test("lists rows matching the prototype's typography, and opening one goes to its report", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [
            row("a", { filename: "msa.pdf", overallRisk: "HIGH", findingCount: 5 }),
          ],
          page: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await page.route("**/api/v1/documents/a", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          document: {
            id: "a",
            filename: "msa.pdf",
            sourceType: "UPLOAD",
            wordCount: 900,
          },
          analysis: {
            id: "an1",
            status: "COMPLETED",
            overallRisk: "HIGH",
            summary: "x",
            findings: [],
            missingClauses: [],
            discardedFindings: 0,
            createdAt: "2026-01-05T00:00:00.000Z",
          },
        }),
      }),
    );
    await page.goto("/documents");

    await expect(page.getByText("msa.pdf")).toBeVisible();
    await expect(page.getByText("900 words")).toBeVisible();
    await expect(page.getByText("High", { exact: true })).toBeVisible();
    await expect(page.getByText("5 findings")).toBeVisible();
    await expect(
      page.getByText("Open a report again, or delete a contract for good."),
    ).toBeVisible();

    await page.getByRole("link", { name: /msa\.pdf/ }).click();
    await expect(page).toHaveURL("/documents/a");
  });

  test("formats the UTC timestamp in the browser's own timezone via Intl, not the raw server string", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [row("a", { createdAt: "2026-01-05T00:00:00.000Z" })],
          page: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await page.goto("/documents");

    const expected = await page.evaluate(() =>
      new Date("2026-01-05T00:00:00.000Z").toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    await expect(page.getByText("2026-01-05T00:00:00.000Z")).toHaveCount(0);
  });

  test('"Load more" paginates without a full-page reload, appending rows without duplicates', async ({
    page,
  }) => {
    let requestedCursor = null;
    await page.route("**/api/v1/documents*", (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get("cursor");
      requestedCursor = cursor;
      if (cursor === "cursor-1") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            documents: [row("b")],
            page: { nextCursor: null, hasMore: false },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [row("a")],
          page: { nextCursor: "cursor-1", hasMore: true },
        }),
      });
    });

    // A full reload would show up as a new navigation; this marks the
    // page instance so a reload (not just a fetch) is directly observable.
    await page.goto("/documents");
    await page.evaluate(() => {
      /** @type {any} */ (window).__loadedOnce = true;
    });

    await expect(page.locator("li.cc-history__row")).toHaveCount(1);
    await page.getByRole("button", { name: "Load more" }).click();

    await expect(page.locator("li.cc-history__row")).toHaveCount(2);
    expect(requestedCursor).toBe("cursor-1");
    expect(await page.evaluate(() => /** @type {any} */ (window).__loadedOnce)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  });

  test("deleting a row removes exactly that row, leaving the rest without duplicating any", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [
            row("a", { filename: "a.pdf" }),
            row("b", { filename: "b.pdf" }),
            row("c", { filename: "c.pdf" }),
          ],
          page: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await page.route("**/api/v1/documents/b", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ deleted: true, message: "x" }),
      }),
    );
    await page.goto("/documents");
    await expect(page.locator("li.cc-history__row")).toHaveCount(3);

    await page.getByRole("button", { name: "Delete b.pdf" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently" })
      .click();

    await expect(page.getByText("b.pdf")).toHaveCount(0);
    await expect(page.locator("li.cc-history__row")).toHaveCount(2);
    await expect(page.getByText("a.pdf")).toBeVisible();
    await expect(page.getByText("c.pdf")).toBeVisible();
  });

  test("a document with no completed analysis reads 'Not yet analyzed', not a false 'No findings'", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [row("a", { overallRisk: null, findingCount: 0 })],
          page: { nextCursor: null, hasMore: false },
        }),
      }),
    );
    await page.goto("/documents");

    await expect(page.getByText("Not yet analyzed")).toBeVisible();
    await expect(page.getByText("No findings")).toHaveCount(0);
  });

  test("axe reports zero violations on the empty state", async ({ page }) => {
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
    await page.goto("/documents");
    await expect(page.getByText("No contracts checked yet.")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });

  test("axe reports zero violations on the populated state, with the delete dialog open", async ({
    page,
  }) => {
    await page.route("**/api/v1/documents", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          documents: [row("a"), row("b", { overallRisk: null, findingCount: 0 })],
          page: { nextCursor: "cursor-1", hasMore: true },
        }),
      }),
    );
    await page.goto("/documents");
    await expect(page.locator("li.cc-history__row")).toHaveCount(2);

    let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole("button", { name: /Delete contract-a\.pdf/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
});
