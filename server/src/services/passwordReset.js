import prisma from "../lib/prisma.js";
import { sendEmail } from "../lib/email.js";
import logger from "../observability/logger.js";
import { consumeAuthToken, issueAuthToken } from "./authTokens.js";
import { hashPassword } from "./auth.js";

/**
 * Password reset (FR-1.8, FR-1.9).
 *
 * TWO PROPERTIES CARRY THIS FILE, and both are easy to lose.
 *
 * 1. FORGOT-PASSWORD MUST NOT DISCLOSE WHETHER AN ACCOUNT EXISTS. The
 *    route always answers 202 with the same body, which is the visible
 *    half. The invisible half is timing: issuing a token and queueing an
 *    email is measurable work that only happens for a real account, so
 *    awaiting it would turn a 202 into an oracle you can read with a
 *    stopwatch. `requestPasswordReset` therefore awaits the LOOKUP, which
 *    both paths do, and nothing else — the issue-and-send runs detached.
 *
 * 2. RESET DOES FOUR THINGS, AND THE FOURTH IS THE ONE PEOPLE FORGET.
 *    Consume the token, set the password, increment tokenVersion, and
 *    invalidate every OTHER outstanding reset token. Skipping the last one
 *    undoes the whole exercise: an attacker who triggered a reset earlier
 *    still holds a live token, so the victim resetting their password
 *    hands the attacker a fresh 30-minute window rather than closing one.
 *    All four are one transaction, so a partial reset cannot exist — a
 *    password changed without tokenVersion moving would leave every stolen
 *    session alive.
 */

/**
 * Always resolves, and resolves in the same time whether or not the
 * account exists. Never signals which happened.
 *
 * @param {string} email
 * @param {{ detach?: (work: Promise<unknown>) => void }} [options]
 *   `detach` exists so a test can await the background work instead of
 *   racing it. Production drops it on the floor, deliberately.
 */
export async function requestPasswordReset(email, { detach } = {}) {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  // No account: return exactly as the other path does, having done exactly
  // the same awaited work. Not logged at info with the address either —
  // §6.5 bars addresses, and a log that recorded misses would rebuild the
  // oracle the response refuses to be.
  if (!user) return;

  const work = (async () => {
    try {
      const token = await issueAuthToken(user.id, "PASSWORD_RESET");
      sendEmail("password_reset", user.email, { token });
    } catch (err) {
      // NFR-3.8's rule applies to the caller too: the request already
      // answered 202, and nothing about this failure may reach it.
      logger.error(
        { alert: "email_send_failed", email: { type: "password_reset" }, err: { name: /** @type {Error} */ (err)?.name } },
        "could not issue a password reset token",
      );
    }
  })();

  if (detach) detach(work);
  else void work;
}

/**
 * Consumes a reset token and applies the new password.
 *
 * Returns the user's id and email so the caller can send the notice and
 * write the audit event, which are both sent AFTER the transaction
 * commits: a notice or audit row for a reset that then rolled back would
 * be worse than none, since it invites the reader to believe a change
 * that never happened.
 *
 * Deliberately does NOT sign the user in. Holding a mailbox link proves
 * the mailbox, not that this browser belongs to that person, and issuing
 * a session here would also mean minting a cookie in the same breath as
 * invalidating every other one. They sign in with the new password.
 *
 * Also deliberately does not touch `state` or `emailVerifiedAt`. Resetting
 * a password does prove mailbox control, so activating an UNVERIFIED
 * account here would be defensible — but FR-1.7 makes verification its own
 * flow with its own token type, and quietly giving a second path to ACTIVE
 * would put a security state change somewhere no one reviewing
 * verification would look.
 *
 * @param {string} token
 * @param {string} newPassword
 * @param {Date} [now]
 * @returns {Promise<{ userId: string, email: string }>}
 */
export async function resetPassword(token, newPassword, now = new Date()) {
  // Hashed BEFORE the transaction opens: bcrypt at cost 12 takes hundreds
  // of milliseconds, and holding a database transaction open across it
  // would pin a connection from a small pool for the duration.
  const passwordHash = await hashPassword(newPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const { userId } = await consumeAuthToken(tx, token, "PASSWORD_RESET", now);

    const user = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        // FR-1.9: the entire session-revocation mechanism. Every cookie
        // issued before this moment now fails requireAuth's comparison
        // with 401 SESSION_REVOKED.
        tokenVersion: { increment: 1 },
        // A password reset is also a successful recovery, so the FR-1.10
        // lockout counters have nothing left to protect. Leaving them set
        // would lock the user out of the account they just recovered.
        failedLoginCount: 0,
        lockedUntil: null,
      },
      select: { id: true, email: true },
    });

    // The fourth thing. Every other unused reset token for this user is
    // spent now, including any an attacker requested earlier.
    await tx.authToken.updateMany({
      where: { userId, type: "PASSWORD_RESET", usedAt: null },
      data: { usedAt: now },
    });

    return user;
  });

  return { userId: updated.id, email: updated.email };
}

/**
 * FR-1.8's notification. Separate from resetPassword so the transaction
 * does not depend on it and so a caller cannot accidentally send it for a
 * reset that failed.
 *
 * @param {string} email
 */
export function sendPasswordChangedNotice(email) {
  return sendEmail("password_changed", email);
}
