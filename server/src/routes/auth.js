import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  authLimiter,
  resendVerificationIpLimiter,
  resendVerificationUserLimiter,
} from "../middleware/rateLimits.js";
import { loginSchema, registerSchema, verifyEmailSchema } from "../schemas/auth.js";
import { resendVerification, sendVerificationEmail, verifyEmail } from "../services/emailVerification.js";
import {
  SESSION_COOKIE_NAME,
  authenticate,
  clearSessionCookieOptions,
  registerUser,
  sessionCookieOptions,
  signSessionToken,
  toPublicUser,
} from "../services/auth.js";

const router = Router();

/**
 * Every route here is thin on purpose: parse, call the service, shape
 * the response. The security-relevant decisions — cost factor, claim
 * set, cookie attributes, the timing defence — live in services/auth.js
 * where they can be read in one place instead of inferred from four
 * handlers.
 */

function issueSession(res, user) {
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

// POST /api/v1/auth/register — creates the account and signs the user in.
// NFR-2.6: authLimiter first, before the body is even validated — a
// flood of malformed registration attempts shouldn't reach validation
// just to be rejected there instead.
router.post(
  "/register",
  authLimiter,
  validateBody(registerSchema),
  async (req, res, next) => {
    try {
      const user = await registerUser(req.body);
      // FR-1.7. Awaited only for the token insert; the send itself is
      // queued. Never throws — registration has already succeeded, and a
      // mail problem must not be reported as a registration error
      // (NFR-3.8).
      await sendVerificationEmail(user);
      issueSession(res, user);
      res.status(201).json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/auth/login
router.post("/login", authLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const user = await authenticate(req.body);
    issueSession(res, user);
    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout — clears the cookie for this browser only.
// Revoking every session at once is logout-all (FR-1.9), step 55.
router.post("/logout", requireAuth, (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());
  res.status(200).json({ ok: true });
});

// GET /api/v1/auth/me — the current user, including account state, which
// is what lets the client tell an UNVERIFIED account it needs to verify
// before analysing (PRD §8.1).
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth.userId } });

    // The token verified, but its subject is gone — a deleted account
    // whose cookie is still in a browser. Treat it as unauthenticated
    // rather than 404: from the caller's side the session simply is no
    // longer valid.
    if (!user) {
      throw new AppError("UNAUTHENTICATED");
    }

    res.status(200).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/verify-email — consumes the emailed token (FR-1.7).
//
// A POST, not a GET, and that is the design rather than a style choice:
// email security scanners and some mail clients open every link in a
// message to check it, and a GET that consumed the token would be spent by
// the scanner before the person ever saw it. The link in the email points
// at the FRONTEND's /verify-email page (FR-7.1), which POSTs here when a
// human has actually landed on it.
//
// Unauthenticated, because the person clicking may be on a different
// device from the one they registered on. It does NOT sign anyone in:
// holding a mailbox link proves the mailbox, not that this browser is that
// user. Not behind authLimiter, which is 5 attempts and shared with login —
// a user who registers, verifies, and then mistypes a password would hit
// it. The token is 256 random bits, so guessing is not the threat the
// tighter limit exists for; the general limiter still applies.
router.post("/verify-email", validateBody(verifyEmailSchema), async (req, res, next) => {
  try {
    await verifyEmail(req.body.token);
    res.status(200).json({ verified: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/resend-verification — 3/hour/account, 10/hour/IP.
router.post(
  "/resend-verification",
  requireAuth,
  resendVerificationIpLimiter,
  resendVerificationUserLimiter,
  async (req, res, next) => {
    try {
      const { alreadyVerified } = await resendVerification(req.auth.userId);
      res.status(200).json({ sent: !alreadyVerified, alreadyVerified });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
