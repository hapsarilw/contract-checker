import prisma from "../lib/prisma.js";
import { sendEmail } from "../lib/email.js";
import logger from "../observability/logger.js";
import { consumeAuthToken, issueAuthToken } from "./authTokens.js";

/**
 * Email verification (FR-1.7, PRD §8.1, decision D4).
 *
 * WHERE THE GATE SITS is the decision D4 records: an UNVERIFIED account may
 * sign in and browse, and only analysis is refused (services/analysis.js).
 * Friction goes where the cost is — an LLM call and a stored confidential
 * document — and a mistyped address is caught while the user is still in
 * the flow. Nothing in this file, and nothing in auth middleware, blocks
 * signing in.
 */

/**
 * Issues a token and queues the verification email.
 *
 * NEVER THROWS. Registration has already succeeded by the time this runs,
 * and NFR-3.8 says a mail problem must not be reported as a registration
 * error. That covers the token insert as well as the send: if the database
 * hiccups here the user has a working account and a "resend verification"
 * button, which is a far better outcome than telling them registration
 * failed when it did not.
 *
 * @param {{ id: string, email: string }} user
 * @returns {Promise<{ queued: boolean }>}
 */
export async function sendVerificationEmail(user) {
  try {
    const token = await issueAuthToken(user.id, "EMAIL_VERIFICATION");
    return sendEmail("verification", user.email, { token });
  } catch (err) {
    logger.error(
      { alert: "email_send_failed", email: { type: "verification" }, err: { name: /** @type {Error} */ (err)?.name } },
      "could not issue a verification token",
    );
    return { queued: false };
  }
}

/**
 * Consumes a verification token and activates the account, atomically.
 *
 * ONE TRANSACTION, so a failure after the token is consumed leaves the
 * token unspent rather than burned with nothing to show for it.
 *
 * ONLY `UNVERIFIED` BECOMES `ACTIVE`. Proving control of a mailbox is not
 * a reason to lift a suspension: a SUSPENDED or LOCKED account that holds
 * an old verification link must not be able to un-suspend itself by
 * opening it. emailVerifiedAt is still recorded, because the address
 * genuinely was verified.
 *
 * @param {string} token
 * @param {Date} [now]
 */
export async function verifyEmail(token, now = new Date()) {
  await prisma.$transaction(async (tx) => {
    const { userId } = await consumeAuthToken(tx, token, "EMAIL_VERIFICATION", now);

    await tx.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: now },
    });
    await tx.user.updateMany({
      where: { id: userId, state: "UNVERIFIED" },
      data: { state: "ACTIVE" },
    });

    // Any other outstanding verification links are now pointless. Spending
    // them keeps a stale email from lingering as a live credential.
    await tx.authToken.updateMany({
      where: { userId, type: "EMAIL_VERIFICATION", usedAt: null },
      data: { usedAt: now },
    });
  });
}

/**
 * Resend, for an authenticated user (FR-1.7, rate limited at the route).
 *
 * An already-verified account is told so and sent nothing: a verification
 * email to someone who is verified is noise, and the endpoint is
 * authenticated, so saying so reveals nothing about anyone else.
 *
 * Earlier links are NOT revoked when a new one is issued, deliberately. A
 * user who asks again because the first email is slow would otherwise find
 * the arriving first email dead. The rate limit (3 an hour) is what bounds
 * how many live links can exist.
 *
 * @param {string} userId
 * @returns {Promise<{ alreadyVerified: boolean }>}
 */
export async function resendVerification(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, state: true, emailVerifiedAt: true },
  });
  if (!user) return { alreadyVerified: false };

  if (user.emailVerifiedAt || user.state === "ACTIVE") return { alreadyVerified: true };

  await sendVerificationEmail(user);
  return { alreadyVerified: false };
}
