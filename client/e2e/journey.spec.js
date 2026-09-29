import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AXE_TAGS } from "./support/mockApi.js";

/**
 * TR-24 (SRS §10.7), BUILD-PLAN step 73: the whole user journey against a
 * deployed system, nothing mocked in the browser:
 *
 *   register -> verify (the real email's link) -> upload fixture 01 ->
 *   read the report -> copy a suggested change -> delete the document ->
 *   delete the account
 *
 * with step 65's axe assertions (WCAG 2.0 to 2.2, A and AA) on each of the
 * seven screens it passes through: register, upload, analyzing, report,
 * history, settings, and sign-in (where account deletion lands).
 *
 *   PLAYWRIGHT_BASE_URL=<the frontend> E2E_JOURNEY=1 \
 *   E2E_MAILBOX=sink:<directory the API writes its emails to> \
 *   npx playwright test e2e/journey.spec.js
 *
 * THE MAILBOX. The verification token comes from the email the API really
 * sent. `sink:<dir>` reads the step-51 mail sink, which is what the local
 * rehearsal runs (ops/load/run-local.sh). Staging cannot: production mode
 * refuses the sink, and staging runs in production mode. So running this
 * against staging needs a second mailbox kind here, for whatever inbox the
 * chosen email provider offers a test to read. That is decided with the
 * email provider (docs/load-test-results.md), and until then E2E_MAILBOX
 * is required, and this fails loudly without it rather than skipping the
 * step that proves email works.
 *
 * It creates one account at a unique address and deletes it as its last
 * step; a failed run leaves at most that one account, synthetic, behind.
 */

const JOURNEY = Boolean(process.env.E2E_JOURNEY);
test.skip(
  !JOURNEY,
  "E2E_JOURNEY is unset: this spec runs against a deployed system only",
);

const FIXTURE = join(
  process.cwd(),
  "..",
  "server",
  "tests",
  "fixtures",
  "01-design-services-hostile.pdf",
);

/**
 * The verification token from the newest email to `to`.
 * @param {string} to
 */
async function verificationToken(to) {
  const mailbox = process.env.E2E_MAILBOX ?? "";
  if (!mailbox.startsWith("sink:")) {
    throw new Error(
      `E2E_MAILBOX is ${mailbox ? `"${mailbox}"` : "unset"}: set sink:<dir> for a mail sink. ` +
        "No other mailbox kind exists yet (see this file's header).",
    );
  }
  const dir = mailbox.slice("sink:".length);
  const pattern = /\/verify-email\?token=([A-Za-z0-9_%.~-]+)/;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const name of (await readdir(dir).catch(() => [])).sort().reverse()) {
      const mail = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (mail.to !== to) continue;
      const match = pattern.exec(mail.text ?? "");
      if (match) return decodeURIComponent(match[1]);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no verification email for ${to} in ${dir}`);
}

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

test("TR-24: register, verify, upload, report, copy, delete the document, delete the account", async ({
  page,
  context,
}) => {
  // Registration, a real analysis (the provider's own latency), and
  // deletion: FR-3.7 allows the analysis alone 90 s.
  test.setTimeout(240_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const email = `tr24-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `tr24-${Math.random().toString(36).slice(2)}-Aa1`;
  /** @type {string[]} */
  const screens = [];
  const audit = async (/** @type {string} */ screen) => {
    await expectNoAxeViolations(page, screen);
    screens.push(screen);
  };

  // 1. Register. Lands signed in and unverified.
  await page.goto("/register");
  await expect(
    page.getByRole("heading", { level: 1, name: "Create your account" }),
  ).toBeVisible();
  await audit("register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  // 2. Verify, with the link from the email the API sent.
  const token = await verificationToken(email);
  await page.goto(`/verify-email?token=${encodeURIComponent(token)}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Email verified" }),
  ).toBeVisible();

  // 3. Upload fixture 01, through the picker, as a user does.
  await page.goto("/");
  await expect(page.getByRole("tab", { name: "Upload a file" })).toBeVisible();
  await audit("upload");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    page.getByRole("button", { name: "Choose a file" }).click(),
  ]);
  await chooser.setFiles(FIXTURE);
  await page.getByRole("button", { name: "Check this contract" }).click();

  await expect(page.locator(".cc-analyzing__stages")).toBeVisible();
  await audit("analyzing");

  // 4. The report.
  await expect(page).toHaveURL(/\/documents\/[^/]+$/, { timeout: 150_000 });
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await audit("report");

  // 5. Copy a suggested change: the clipboard holds exactly the card's ask.
  const firstCard = page.locator("ol.cc-report__findings > li").first();
  await expect(firstCard).toBeVisible();
  const ask = (await firstCard.locator(".cc-finding__ask").innerText()).trim();
  expect(ask.length).toBeGreaterThan(0);
  await firstCard.getByRole("button", { name: "Copy this ask" }).click();
  await expect(firstCard.getByRole("button", { name: "Copied" })).toBeVisible();
  expect((await page.evaluate(() => navigator.clipboard.readText())).trim()).toBe(ask);

  // 6. Delete the document; history is empty again.
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently" })
    .click();
  await expect(page).toHaveURL("/documents");
  await expect(page.getByText("No contracts checked yet.")).toBeVisible();
  await audit("history");

  // 7. Delete the account.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await audit("settings");
  await page.getByRole("button", { name: "Delete my account…" }).click();
  await page.getByLabel("Enter your password to confirm").fill(password);
  await page.getByRole("button", { name: "Delete everything permanently" }).click();
  await expect(page).toHaveURL(/\/login\?reason=account_deleted/);
  await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await audit("sign-in");

  // And it is gone: the credentials no longer sign in.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Sign in failed")).toBeVisible();

  expect(screens).toEqual([
    "register",
    "upload",
    "analyzing",
    "report",
    "history",
    "settings",
    "sign-in",
  ]);
});
