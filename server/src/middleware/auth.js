import { AppError } from "../lib/AppError.js";
import { SESSION_COOKIE_NAME, verifySessionToken } from "../services/auth.js";

/**
 * FR-1.4 — endpoints that require a session reject requests without a
 * valid token with 401 UNAUTHENTICATED.
 *
 * INCOMPLETE BY DESIGN, until step 13 (AUTH-2). Right now this verifies
 * the token's signature and expiry and nothing else. Step 13 adds, to
 * this same file:
 *
 *   - loading the user row and comparing `tv` against user.tokenVersion,
 *     rejecting a mismatch with 401 SESSION_REVOKED (FR-1.9, PRD D5) —
 *     without which a stolen cookie is valid for its full seven days
 *     with no kill switch;
 *   - rejecting a SUSPENDED account with 403 ACCOUNT_SUSPENDED;
 *   - attaching the loaded user, not just the claims, to the request.
 *
 * What step 13 must NOT add here is an email-verification check: FR-1.7
 * gates that on the analyze path specifically, not on every
 * authenticated request.
 */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token) {
    next(new AppError("UNAUTHENTICATED"));
    return;
  }

  try {
    req.auth = verifySessionToken(token);
    next();
  } catch (err) {
    next(err);
  }
}
