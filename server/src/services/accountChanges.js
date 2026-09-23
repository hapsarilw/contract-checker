import bcrypt from "bcrypt";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { sendEmail } from "../lib/email.js";
import { consumeAuthToken, issueAuthToken } from "./authTokens.js";
import { assertPasswordNotBreached } from "./breachedPasswords.js";
import { hashPassword } from "./auth.js";

/**
 * Account self-service (FR-1.11, FR-1.13, FR-1.9): change password, sign
 * out everywhere, change email.
 *
 * ALL THREE TURN ON tokenVersion, which FR-1.9 makes the whole of session
 * revocation, and the difference between them is exactly who gets signed
 * out:
 *
 *   change-password  bump, then MINT A FRESH COOKIE for this session.
 *                    Other sessions die; the one doing the work lives.
 *   logout-all       bump and mint nothing. Everything dies, this session
 *                    included — that is the point of the button.
 *   change-email     no bump at all. See requestEmailChange.
 */

/**
 * Re-authentication for a change that could hand over — or destroy — the
 * account. Exported because FR-4.6's deletion (services/account.js) needs
 * the same check: one place decides what a failed confirmation means, so
 * a second caller cannot quietly answer 401 where this one answers 400.
 *
 * `field` names the body property that was wrong, since the routes do not
 * agree on one name: change-password and change-email carry a NEW value
 * alongside, so theirs is `currentPassword`, while deletion has only one
 * password in the body and calls it `password`.
 *
 * @param {{ passwordHash: string }} user
 * @param {string} password
 * @param {string} [field]
 */
export async function assertCurrentPassword(user, password, field = "currentPassword") {
  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    // Not INVALID_CREDENTIALS: the session is valid and the caller is who
    // they say they are. What failed is the confirmation for this one
    // action, and a 401 would invite a client to log the user out over it.
    throw new AppError("VALIDATION_ERROR", {
      message: "That is not your current password.",
      details: { field },
    });
  }
}

/**
 * FR-1.11. Returns the updated user so the route can mint the fresh
 * cookie — which is the half that is easy to miss, and whose absence is a
 * miserable bug to chase: the user changes their password and is
 * instantly 401 SESSION_REVOKED out of the session that just did it,
 * which looks like the change failed when it succeeded.
 *
 * @param {string} userId
 * @param {{ currentPassword: string, newPassword: string }} input
 */
export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await assertCurrentPassword(user, currentPassword);

  // FR-1.2 applies wherever a password is set, not only at registration —
  // this is precisely where someone under pressure picks something weak.
  assertPasswordNotBreached(newPassword);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(newPassword),
      tokenVersion: { increment: 1 },
      // The account has just been recovered by someone who knew the old
      // password; the lockout counters have nothing left to protect.
      failedLoginCount: 0,
      firstFailedLoginAt: null,
      lockedUntil: null,
    },
  });

  sendEmail("password_changed", updated.email);
  return updated;
}

/**
 * FR-1.9's user-facing answer to a lost laptop. No password required:
 * someone holding a valid session asking to end all sessions is a request
 * that can only reduce access, and demanding a password would leave a
 * person who fears their account is compromised hunting for it.
 *
 * @param {string} userId
 */
export async function logoutEverywhere(userId) {
  await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
  });
}

/**
 * FR-1.13, first half: record the pending address and email a link to it.
 *
 * THE CURRENT ADDRESS IS NOT TOUCHED. `pendingEmail` holds the new one
 * until it is verified, because "the change takes effect only when the new
 * address is verified" — overwriting first would move the account to an
 * address the user has not yet proven they can read, and a typo would
 * strand them there permanently.
 *
 * The state DOES move to UNVERIFIED now, which is what FR-1.13 says
 * ("re-enters the UNVERIFIED state"). The practical effect is that
 * analysis pauses while the address is in flux, and the user can recover
 * by asking again — they are still signed in.
 *
 * tokenVersion is deliberately NOT incremented. The caller proved the
 * current password, so a stolen cookie alone cannot reach here, and
 * signing every session out over a pending change would punish the
 * legitimate user for an action they took on purpose.
 *
 * @param {string} userId
 * @param {{ newEmail: string, currentPassword: string }} input
 */
export async function requestEmailChange(userId, { newEmail, currentPassword }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await assertCurrentPassword(user, currentPassword);

  if (newEmail === user.email) {
    throw new AppError("VALIDATION_ERROR", {
      message: "That is already your email address.",
      details: { field: "email" },
    });
  }

  // Registration already answers EMAIL_TAKEN for an address in use, so
  // saying so here discloses nothing new — and silently accepting a
  // change that can never complete would be worse.
  if (await prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } })) {
    throw new AppError("EMAIL_TAKEN");
  }

  const token = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { pendingEmail: newEmail, state: "UNVERIFIED", emailVerifiedAt: null },
    });
    // Any earlier pending change is now void: two live links would mean
    // two addresses could still claim the account.
    await tx.authToken.updateMany({
      where: { userId, type: "EMAIL_CHANGE", usedAt: null },
      data: { usedAt: new Date() },
    });
    return issueAuthToken(userId, "EMAIL_CHANGE", { db: tx });
  });

  sendEmail("email_change_verification", newEmail, { token });
  // FR-1.13: "the old address is notified". Sent to the OLD address on
  // purpose — the new one may be an attacker's, and the person who holds
  // the old one is the only one who can object.
  sendEmail("email_changed", user.email, { newEmail });
}

/**
 * FR-1.13, second half: the change takes effect here and nowhere else.
 *
 * @param {string} token
 * @param {Date} [now]
 * @returns {Promise<{ userId: string, email: string }>}
 */
export async function confirmEmailChange(token, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const { userId } = await consumeAuthToken(tx, token, "EMAIL_CHANGE", now);

    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.pendingEmail) {
      // The token outlived its own change — a later request replaced it,
      // or the address was already moved. Same answer as any unusable
      // token, so the endpoint stays free of hints.
      throw new AppError("VALIDATION_ERROR", {
        message:
          "This link is invalid, has already been used, or has expired. Request a new one and try again.",
        details: { reason: "token_unusable" },
      });
    }

    try {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          email: user.pendingEmail,
          pendingEmail: null,
          state: "ACTIVE",
          emailVerifiedAt: now,
        },
      });
      return { userId: updated.id, email: updated.email };
    } catch (err) {
      // Someone else claimed the address between the request and the
      // confirmation. The unique index is the authority; a check here
      // would just be a longer race.
      if (/** @type {{ code?: string }} */ (err)?.code === "P2002") throw new AppError("EMAIL_TAKEN");
      throw err;
    }
  });
}
