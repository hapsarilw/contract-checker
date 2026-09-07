import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../services/auth.js";

/**
 * FR-1.4 — every document and analysis endpoint requires a valid token.
 *
 * The order of checks is the order of increasing cost and decreasing
 * doubt: signature and expiry first (no I/O), then the user row, then
 * what that row says.
 *
 * FR-1.9 / PRD D5 — the tokenVersion comparison IS the session
 * revocation mechanism, in its entirety: one integer, checked against a
 * row this request loads anyway. Without it a stolen cookie stays valid
 * for its full seven days with nothing anyone can do about it, which is
 * not an acceptable property for a product that holds confidential
 * documents. Password reset, password change, sign-out-everywhere and
 * account deletion all work by incrementing that integer (steps 53–57).
 *
 * What is deliberately NOT checked here:
 *
 *   - Email verification. FR-1.7 gates analysis specifically, not the
 *     door: an UNVERIFIED account may sign in and browse. Putting the
 *     check here would move the friction away from where the cost is.
 *   - LOCKED state. FR-1.10's lockout defends against password guessing
 *     and is enforced at login (step 54). A session that already exists
 *     was not obtained by guessing, and locking it out would log a user
 *     out because someone else attacked their account.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      throw new AppError("UNAUTHENTICATED");
    }

    const claims = verifySessionToken(token);

    // passwordHash is omitted rather than fetched-and-ignored: a hash
    // that never enters the request context cannot leak from it, whatever
    // some future handler or log line does with req.user.
    const user = await prisma.user.findUnique({
      where: { id: claims.userId },
      omit: { passwordHash: true },
    });

    // A validly-signed token whose subject is gone — a deleted account
    // whose cookie is still in a browser. Unauthenticated, not 404: the
    // session is simply no longer a session.
    if (!user) {
      throw new AppError("UNAUTHENTICATED");
    }

    if (claims.tokenVersion !== user.tokenVersion) {
      throw new AppError("SESSION_REVOKED");
    }

    if (user.state === "SUSPENDED") {
      throw new AppError("ACCOUNT_SUSPENDED");
    }

    req.auth = claims;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}
