import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import {
  authLimiter,
  forgotPasswordEmailLimiter,
  forgotPasswordIpLimiter,
  resendVerificationIpLimiter,
  resendVerificationUserLimiter,
} from "../middleware/rateLimits.js";
import {
  changeEmailSchema,
  changePasswordSchema,
  confirmEmailChangeSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from "../schemas/auth.js";
import { recordAuditEvent, AUDIT_ACTIONS } from "../lib/audit.js";
import { resendVerification, sendVerificationEmail, verifyEmail } from "../services/emailVerification.js";
import {
  changePassword,
  confirmEmailChange,
  logoutEverywhere,
  requestEmailChange,
} from "../services/accountChanges.js";
import {
  requestPasswordReset,
  resetPassword,
  sendPasswordChangedNotice,
} from "../services/passwordReset.js";
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
      // Fire-and-forget, like the audit writer itself: NFR-2.12 records
      // that registration happened, and a slow or failed write must not
      // hold up the response any more than a failed email does.
      await recordAuditEvent(AUDIT_ACTIONS.REGISTERED, { userId: user.id, ip: req.ip });
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
    const user = await authenticate(req.body, { ip: req.ip });
    await recordAuditEvent(AUDIT_ACTIONS.LOGIN_SUCCEEDED, { userId: user.id, ip: req.ip });
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

// POST /api/v1/auth/forgot-password — FR-1.8. ALWAYS 202.
//
// The response is the same object with the same status whether or not the
// address belongs to an account, because anything else is an account
// enumeration endpoint. "If that address has an account" is the honest
// phrasing of a deliberate non-answer, and it is what lets the server
// refuse to say more without appearing to malfunction.
//
// The limiters are mounted BEFORE validation on purpose: a malformed body
// should still spend quota, or the limit is bypassed by sending rubbish.
// Keyed on the submitted string, so the counter behaves identically for
// addresses that exist and addresses that do not — a 429 must not become
// the oracle the 202 refuses to be.
router.post(
  "/forgot-password",
  forgotPasswordIpLimiter,
  forgotPasswordEmailLimiter,
  validateBody(forgotPasswordSchema),
  async (req, res, next) => {
    try {
      await requestPasswordReset(req.body.email);
      res.status(202).json({
        message: "If that address has an account, a password reset link is on its way.",
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/auth/reset-password — FR-1.8, FR-1.9.
//
// Unauthenticated: the whole point is that the person cannot sign in. Not
// behind authLimiter either — that bucket is 5 attempts shared with login,
// and someone who has just reset their password and is typing it in would
// collide with it. The token is 256 random bits, so guessing is not the
// threat that limiter exists for, and the general limiter still applies.
//
// Answers 200 without a session cookie. Holding a mailbox link proves the
// mailbox, not that this browser is that person — and issuing a cookie
// here would mean minting one in the same breath as invalidating every
// other one. They sign in with the new password.
router.post("/reset-password", validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    const { userId, email } = await resetPassword(req.body.token, req.body.password);
    // After the transaction committed, never before: a notice or an audit
    // row for a reset that then rolled back would invite the reader to
    // believe a change that never happened.
    await recordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET, { userId, ip: req.ip });
    sendPasswordChangedNotice(email);
    res.status(200).json({ reset: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/change-password — FR-1.11.
//
// Increments tokenVersion AND issues a fresh cookie. The second half is
// the one that is easy to leave out, and its absence is a miserable bug:
// the user changes their password and is instantly 401 SESSION_REVOKED
// out of the very session that did it, which reads as "the change
// failed" when it in fact succeeded.
router.post(
  "/change-password",
  requireAuth,
  validateBody(changePasswordSchema),
  async (req, res, next) => {
    try {
      const user = await changePassword(req.auth.userId, req.body);
      await recordAuditEvent(AUDIT_ACTIONS.PASSWORD_CHANGED, { userId: user.id, ip: req.ip });
      issueSession(res, user);
      res.status(200).json({ changed: true });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/auth/logout-all — FR-1.9's answer to a lost laptop.
//
// Bumps tokenVersion and mints nothing, so every session dies including
// this one. The cookie is cleared as well, so the browser that asked is
// not left holding one that now fails on the next request.
router.post("/logout-all", requireAuth, async (req, res, next) => {
  try {
    await logoutEverywhere(req.auth.userId);
    await recordAuditEvent(AUDIT_ACTIONS.SIGNED_OUT_EVERYWHERE, { userId: req.auth.userId, ip: req.ip });
    res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());
    res.status(200).json({ signedOutEverywhere: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/change-email — FR-1.13, the request half.
//
// Records the address as PENDING and emails it a link; the account keeps
// its current address until that link is opened. The old address is
// notified in the same breath, because the new one may be an attacker's
// and the person holding the old one is the only one who can object.
router.post("/change-email", requireAuth, validateBody(changeEmailSchema), async (req, res, next) => {
  try {
    await requestEmailChange(req.auth.userId, {
      newEmail: req.body.email,
      currentPassword: req.body.currentPassword,
    });
    res.status(202).json({
      pending: true,
      message: "Check the new address for a confirmation link. Until you open it, nothing changes.",
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/confirm-email-change — FR-1.13, where the change
// actually happens. Unauthenticated for the same reason verify-email is:
// the link may well be opened on a different device.
router.post(
  "/confirm-email-change",
  validateBody(confirmEmailChangeSchema),
  async (req, res, next) => {
    try {
      const { userId, email } = await confirmEmailChange(req.body.token);
      // Fired here, not at the /change-email request: the account's email
      // has not actually changed until this succeeds, and an audit row is
      // a record of what happened, not of what was asked for.
      await recordAuditEvent(AUDIT_ACTIONS.EMAIL_CHANGED, { userId, ip: req.ip });
      res.status(200).json({ changed: true, email });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
