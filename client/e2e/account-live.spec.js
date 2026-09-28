import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

/**
 * BUILD-PLAN step 63's "recover-password journey", against the REAL server
 * and database, with the real emails read from the development mail sink.
 * Nothing on the API is mocked here, which is the point: the mocked specs
 * prove the screens, this proves the screens and the server agree.
 *
 * OPT-IN. It needs a running backend that writes its emails to a sink
 * directory, and it creates (then deletes) a real account in whatever
 * database that backend uses, so it never runs by default:
 *
 *   # terminal 1, in server/   (development, EMAIL_PROVIDER=sink)
 *   npm run dev
 *   # terminal 2, in client/
 *   E2E_LIVE_API=1 npx playwright test e2e/account-live.spec.js
 *
 * `E2E_MAIL_SINK_DIR` overrides where the emails are read from; it defaults
 * to ../server/.mail-sink, where a backend started from server/ writes them.
 * The account it makes is deleted by the test's last step, and its address
 * is unique per run, so a failed run leaves at most one stray *@example.test
 * account behind.
 */

const LIVE = Boolean(process.env.E2E_LIVE_API);
const SINK_DIR =
  process.env.E2E_MAIL_SINK_DIR ?? join(process.cwd(), "..", "server", ".mail-sink");

/**
 * The newest email to `to` whose body links to `route`, polled for up to
 * ten seconds because the server sends after it responds.
 * @param {string} to
 * @param {"verify-email" | "reset-password"} route
 * @returns {Promise<string>} the token from the link
 */
async function tokenFromMail(to, route) {
  const pattern = new RegExp(`/${route}\\?token=([A-Za-z0-9_%.~-]+)`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const names = (await readdir(SINK_DIR).catch(() => [])).sort().reverse();
    for (const name of names) {
      const mail = JSON.parse(await readFile(join(SINK_DIR, name), "utf8"));
      if (mail.to !== to) continue;
      const match = pattern.exec(mail.text ?? "");
      if (match) return decodeURIComponent(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no ${route} email for ${to} appeared in ${SINK_DIR}`);
}

test.describe("account lifecycle against the real API (opt-in: E2E_LIVE_API=1)", () => {
  test.skip(!LIVE, "set E2E_LIVE_API=1 with a running backend to run this");
  test.setTimeout(90_000);

  test("register, verify, forget the password, reset it, sign in, change it, sign out everywhere, delete", async ({
    page,
  }) => {
    const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const first = "first-password-123";
    const second = "second-password-456";
    const third = "third-password-789";

    // Register: lands signed in, UNVERIFIED, with the banner.
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(first);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText("Verify your email to run a check")).toBeVisible();

    // Verify with the link from the real email. The banner goes with it.
    const verifyToken = await tokenFromMail(email, "verify-email");
    await page.goto(`/verify-email?token=${encodeURIComponent(verifyToken)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Email verified" }),
    ).toBeVisible();
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /Hand over the contract/ }),
    ).toBeVisible();
    await expect(page.getByText("Verify your email to run a check")).toHaveCount(0);

    // The same link, used again, is refused by the server, and the screen
    // says so without pretending to know which of the three reasons it is.
    // (Signed in and verified, so the honest answer is "already verified".)
    await page.goto(`/verify-email?token=${encodeURIComponent(verifyToken)}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "You're already verified" }),
    ).toBeVisible();

    // Sign out (the header's button, on a page that has the header), then
    // recover the password.
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: /send/i }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Check your inbox" }),
    ).toBeVisible();

    const resetToken = await tokenFromMail(email, "reset-password");
    await page.goto(`/reset-password?token=${encodeURIComponent(resetToken)}`);
    await page.getByLabel("New password").fill(second);
    await page.getByRole("button", { name: /change|save|set/i }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Password changed" }),
    ).toBeVisible();

    // The old password no longer works; the new one does.
    await page.getByRole("link", { name: "Sign in" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(first);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign in failed")).toBeVisible();
    await page.getByLabel("Password").fill(second);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/");

    // The reset link is single-use.
    await page.goto(`/reset-password?token=${encodeURIComponent(resetToken)}`);
    await page.getByLabel("New password").fill("another-password-000");
    await page.getByRole("button", { name: /change|save|set/i }).click();
    await expect(page.getByText("That didn’t work")).toBeVisible();

    // Settings: change the password with the wrong current one, then the right one.
    await page.goto("/settings");
    await page.getByLabel("Current password").fill("not-the-password");
    await page.getByLabel("New password").fill(third);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("That is not your current password.")).toBeVisible();
    await page.getByLabel("Current password").fill(second);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/Your other devices were signed out/)).toBeVisible();

    // This device is still signed in after its own password change.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

    // Sign out everywhere, then back in.
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page).toHaveURL(/\/login\?reason=signed_out_everywhere/);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(third);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/");

    // Delete the account: wrong password first, then the right one.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Delete my account…" }).click();
    await page.getByLabel("Enter your password to confirm").fill("wrong-password-1");
    await page.getByRole("button", { name: "Delete everything permanently" }).click();
    await expect(
      page.getByRole("dialog").getByText("That is not your current password."),
    ).toBeVisible();
    await page.getByLabel("Enter your password to confirm").fill(third);
    await page.getByRole("button", { name: "Delete everything permanently" }).click();
    await expect(page).toHaveURL(/\/login\?reason=account_deleted/);

    // And it is really gone: the credentials no longer sign in.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(third);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Sign in failed")).toBeVisible();
  });
});
