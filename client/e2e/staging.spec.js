import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AXE_TAGS } from "./support/mockApi.js";

/**
 * BUILD-PLAN step 71 / SRS §8: "E2E and accessibility suite against
 * staging". Every other spec in this directory mocks the API with
 * page.route(), which is right for gating a pull request and says nothing
 * about a deployed system; account-live.spec.js talks to a real API but
 * reads its emails from a local sink staging does not have. This one does
 * neither: it drives the DEPLOYED frontend against the DEPLOYED API, with
 * nothing intercepted, as the synthetic account.
 *
 *   PLAYWRIGHT_BASE_URL=https://staging.example.com \
 *   E2E_STAGING=1 E2E_ACCOUNT_EMAIL=... E2E_ACCOUNT_PASSWORD=... \
 *   npx playwright test e2e/staging.spec.js
 *
 * One journey, in order, with axe (the same WCAG 2.0-2.2 A/AA rule sets as
 * a11y.spec.js) on every screen it reaches: sign in, paste a synthetic
 * contract, wait out a REAL analysis, read the report, see it in the
 * history, delete it, sign out. It deletes what it creates, so staging
 * holds nothing from it afterwards (SRS §2.3: synthetic data only, and no
 * more of it than needed).
 *
 * If the journey fails part-way, the document it created stays behind (the
 * rehearsal's scenario 7b saw exactly that); it is synthetic, and the
 * retention job removes it with everything else after 90 days.
 *
 * The contract is fixture 03 (synthetic, and the "clean" one, so a correct
 * analysis is short and cheap). It costs one real analysis per run on
 * staging's own provider key and its own spend ceiling.
 */

const STAGING = Boolean(process.env.E2E_STAGING);
test.skip(
  !STAGING,
  "E2E_STAGING is unset: this spec runs against a deployed environment only",
);

const CONTRACT = STAGING
  ? readFileSync(
      join(
        process.cwd(),
        "..",
        "server",
        "tests",
        "fixtures",
        "03-copywriting-clean.txt",
      ),
      "utf8",
    )
  : "";

/** @param {import("@playwright/test").Page} page @param {string} screen */
async function expectNoAxeViolations(page, screen) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const violations = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    targets: v.nodes.map((n) => n.target.join(" ")),
  }));
  expect(violations, `axe on ${screen}`).toEqual([]);
}

test("the deployed build: sign in, a real analysis, the report, history, delete, sign out", async ({
  page,
}) => {
  // Longer than the whole server-side chain (120 s) plus the rest of the
  // journey: the analysis is real, and FR-3.7 allows it up to 90 s.
  test.setTimeout(240_000);
  const email = process.env.E2E_ACCOUNT_EMAIL ?? "";
  const password = process.env.E2E_ACCOUNT_PASSWORD ?? "";
  expect(
    email && password,
    "E2E_ACCOUNT_EMAIL and E2E_ACCOUNT_PASSWORD are required",
  ).toBeTruthy();

  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expectNoAxeViolations(page, "login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("tab", { name: "Paste the text" })).toBeVisible();
  await expectNoAxeViolations(page, "upload");
  await page.getByRole("tab", { name: "Paste the text" }).click();
  await page.getByLabel("Paste the contract text").fill(CONTRACT);
  await page.getByRole("button", { name: "Check this contract" }).click();

  await expect(page.locator(".cc-analyzing__stages")).toBeVisible();
  await expectNoAxeViolations(page, "analyzing");

  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 150_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, "report");
  const reportUrl = page.url();

  // exact: the report also has "Back to history".
  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL("/documents");
  await expectNoAxeViolations(page, "history");

  await page.goto(reportUrl);
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(page).toHaveURL("/documents");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
});
