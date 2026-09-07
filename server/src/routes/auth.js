import { Router } from "express";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { loginSchema, registerSchema } from "../schemas/auth.js";
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
router.post("/register", validateBody(registerSchema), async (req, res, next) => {
  try {
    const user = await registerUser(req.body);
    issueSession(res, user);
    res.status(201).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login
router.post("/login", validateBody(loginSchema), async (req, res, next) => {
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

export default router;
