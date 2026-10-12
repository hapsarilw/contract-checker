import { readFileSync } from "node:fs";
import process from "node:process";
import { test, expect } from "@playwright/test";
import { PASTED_CONTRACT, mockApi } from "./support/mockApi.js";

/**
 * BUILD-PLAN step 75: FR-7.9's Content Security Policy, exactly as the
 * static host will serve it (scripts/staticHostHeaders.js writes it into
 * dist/_headers), against the BUILT client. Every screen must load and work
 * with no violation: a policy that breaks the app is found here, not by the
 * first user after a deploy.
 *
 * A production build only. The dev server's HMR client is an inline script,
 * which this policy rightly refuses:
 *
 *   npm run build && npx vite preview --host 127.0.0.1 --port 4173 --strictPort &
 *   PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 E2E_CSP=1 npx playwright test e2e/csp.spec.js
 */

test.skip(
  process.env.E2E_CSP !== "1",
  "needs a production build behind vite preview (E2E_CSP=1)",
);

/** The policy from the built _headers file, so what is tested is what ships. */
function builtPolicy() {
  const file = readFileSync(new URL("../dist/_headers", import.meta.url), "utf8");
  const match = /Content-Security-Policy: (.+)/.exec(file);
  if (!match) throw new Error("dist/_headers has no Content-Security-Policy");
  return match[1];
}

/**
 * Serves every document with the policy, as Netlify will, and records each
 * violation. Registered after mockApi, so it runs first and hands every
 * request that is not a document back to the API mock.
 * @param {import("@playwright/test").Page} page
 */
async function underPolicy(page) {
  const policy = builtPolicy();
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    return route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": policy },
    });
  });
  /** @type {string[]} */
  const violations = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  page.on("pageerror", (error) => violations.push(`page error: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const w = /** @type {any} */ (window);
      (w.__cspViolations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

/** @param {import("@playwright/test").Page} page */
const recorded = (page) =>
  page.evaluate(() => /** @type {any} */ (window).__cspViolations ?? []);

const SCREENS = [
  { name: "login", signedIn: false, path: "/login", heading: "Sign in" },
  {
    name: "register",
    signedIn: false,
    path: "/register",
    heading: "Create your account",
  },
  { name: "upload", signedIn: true, path: "/" },
  { name: "report", signedIn: true, path: "/documents/doc1" },
  { name: "history", signedIn: true, path: "/documents" },
  { name: "settings", signedIn: true, path: "/settings", heading: "Settings" },
  {
    name: "confirm-email-change",
    signedIn: false,
    path: "/confirm-email-change?token=t",
    heading: "Email changed",
  },
  { name: "privacy", signedIn: false, path: "/privacy", heading: "Privacy policy" },
];

for (const screen of SCREENS) {
  test(`${screen.name} loads under the shipped policy with no violation`, async ({
    page,
  }) => {
    await mockApi(page, { signedIn: screen.signedIn });
    const violations = await underPolicy(page);
    await page.goto(screen.path);
    const heading = screen.heading
      ? page.getByRole("heading", { level: 1, name: screen.heading })
      : page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();
    // Fonts and lazy chunks load after first paint.
    await page.waitForLoadState("networkidle");
    expect([...violations, ...(await recorded(page))]).toEqual([]);
  });
}

test("an analysis runs end to end under the shipped policy", async ({ page }) => {
  await mockApi(page);
  const violations = await underPolicy(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Paste the text" }).click();
  await page.getByLabel("Paste the contract text").fill(PASTED_CONTRACT);
  await page.getByRole("button", { name: "Check this contract" }).click();
  await expect(page.locator("ol.cc-report__findings > li")).toHaveCount(4);
  await page.waitForLoadState("networkidle");
  expect([...violations, ...(await recorded(page))]).toEqual([]);
});

test("the policy itself is FR-7.9's: no inline script, no eval, no third-party origin", () => {
  const policy = builtPolicy();
  expect(policy).toContain("script-src 'self';");
  expect(policy).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  // Every origin named is the API's: connect-src, and the report endpoint.
  const origins = new Set(
    (policy.match(/https?:\/\/[^\s;]+/g) ?? []).map((url) => new URL(url).origin),
  );
  expect(origins.size).toBeLessThanOrEqual(1);
  // FR-7.9: violations report to the API (step 75).
  expect(policy).toMatch(/report-uri \S*\/api\/csp-report(;|$)/);
  // Not report-to: in Chromium it silences report-uri (staticHostHeaders.js).
  expect(policy).not.toContain("report-to");
});

test("a violation reaches the API's report endpoint (FR-7.9, step 75)", async ({
  page,
  context,
}) => {
  await mockApi(page, { signedIn: false });
  /** @type {{ contentType: string, body: string }[]} */
  const reports = [];
  await context.route("**/api/csp-report", (route) => {
    const request = route.request();
    reports.push({
      contentType: request.headers()["content-type"] ?? "",
      body: request.postData() ?? "",
    });
    return route.fulfill({ status: 204 });
  });
  await underPolicy(page);
  await page.goto("/login");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();

  // An inline script: the one thing script-src 'self' exists to refuse.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__inlineRan = true";
    document.body.append(script);
  });
  expect(
    await page.evaluate(() => /** @type {any} */ (window).__inlineRan),
  ).toBeUndefined();

  await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(reports[0].contentType).toBe("application/csp-report");
  expect(reports[0].body).toContain("script-src");
});
