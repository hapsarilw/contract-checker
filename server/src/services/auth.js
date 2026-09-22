import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import config from "../config.js";
import prisma from "../lib/prisma.js";
import { AppError } from "../lib/AppError.js";
import { assertPasswordNotBreached } from "./breachedPasswords.js";
import { assertNotLockedOut, clearFailedLogins, recordFailedLogin } from "./lockout.js";
import { recordAuditEvent, AUDIT_ACTIONS } from "../lib/audit.js";

/** FR-1.1 — bcrypt cost factor 12. */
const BCRYPT_COST = 12;

/** FR-1.3 — cookie name and 7-day lifetime. */
export const SESSION_COOKIE_NAME = "clausecheck_token";
const SESSION_TTL_DAYS = 7;
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/**
 * A real cost-12 bcrypt hash of 32 random bytes that were never recorded
 * anywhere, so nothing can ever match it.
 *
 * FR-1.6 requires "comparable timing whether the email exists or not".
 * Without this, a login for an unknown email returns in ~1ms (one failed
 * index lookup) while a known email costs ~250ms of bcrypt work — a
 * difference an attacker can measure over the network, turning the login
 * endpoint into an account-existence oracle that no amount of identical
 * response bodies would close. Comparing against this constant makes the
 * unknown-email path do the same work as the wrong-password path.
 *
 * The cost factor must stay in step with BCRYPT_COST: a cost-10 dummy
 * against cost-12 real hashes would reopen the same timing gap, four
 * times narrower and just as real.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$l8KF20JDuICRPPS/khm.6.p93J6XaCAKZXDDP1fcIdsUDX75DrP52";

/** FR-1.1 — plaintext is hashed here and never stored or logged anywhere. */
export function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * FR-1.3 — HS256, `{ sub, tv }`, 7-day expiry.
 *
 * `tv` carries the user's tokenVersion from the very first token issued,
 * even though nothing enforces it until step 13 (FR-1.9). A claim added
 * later would be absent from every token already in a browser, so
 * enforcement would have to either reject all of them at once — logging
 * out every user — or treat a missing claim as valid, which is the same
 * as not having the mechanism.
 */
export function signSessionToken({ userId, tokenVersion }) {
  return jwt.sign({ sub: userId, tv: tokenVersion }, config.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/**
 * Verifies a session token's signature and expiry.
 *
 * `algorithms: ["HS256"]` is not optional. Without it, jsonwebtoken
 * honours whatever `alg` the token's own header claims — including
 * `none`, which makes any unsigned token the attacker writes verify
 * cleanly. Pinning the algorithm is what makes the signature mean
 * anything.
 *
 * Returns the claims. Throws 401 UNAUTHENTICATED for every failure
 * mode — bad signature, expired, malformed, wrong algorithm — because
 * distinguishing them tells an attacker which part of the forgery to fix.
 */
export function verifySessionToken(token) {
  try {
    const claims = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof claims === "string" || typeof claims.sub !== "string" || typeof claims.tv !== "number") {
      throw new AppError("UNAUTHENTICATED");
    }
    return { userId: claims.sub, tokenVersion: claims.tv };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("UNAUTHENTICATED");
  }
}

/**
 * FR-1.3 — httpOnly, Secure in production, SameSite=Lax, 7-day maxAge,
 * path "/".
 *
 * httpOnly keeps the token out of reach of any script, which is what
 * makes an XSS bug fall short of session theft (§6.2). SameSite=Lax is
 * load-bearing for CSRF: FR-1.12 records that the whole CSRF stance
 * rests on it, so a future change to SameSite=None is a security
 * decision, not a configuration tweak.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: /** @type {const} */ ("lax"),
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  };
}

/**
 * Clearing must repeat the same attributes the cookie was set with —
 * a browser matches on name, domain and path, so clearing with a
 * different path silently leaves the original cookie in place and the
 * user stays logged in.
 */
export function clearSessionCookieOptions() {
  // eslint-disable-next-line no-unused-vars -- dropped deliberately: clearCookie sets its own expiry
  const { maxAge, ...rest } = sessionCookieOptions();
  return rest;
}

/** The user shape safe to return over the API: no hash, no tokenVersion. */
export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    state: user.state,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

/**
 * FR-1.1 / PRD §8.1 — a new account starts UNVERIFIED and can sign in.
 * Analysis is what gets blocked until verification (FR-1.7, step 52),
 * deliberately: the friction belongs where the cost is, not at the door.
 */
export async function registerUser({ email, password }) {
  // FR-1.2, before the bcrypt work: a password on the breached list is
  // refused whatever else is true of it.
  assertPasswordNotBreached(password);

  const passwordHash = await hashPassword(password);

  try {
    return await prisma.user.create({
      data: { email, passwordHash, state: "UNVERIFIED" },
    });
  } catch (err) {
    // FR-1.6. The unique index on email is the authority here, not a
    // prior findUnique: between a check and an insert, two concurrent
    // registrations for the same address both see "available".
    if (/** @type {{ code?: string }} */ (err)?.code === "P2002") {
      throw new AppError("EMAIL_TAKEN");
    }
    throw err;
  }
}

/**
 * FR-1.6 — identical message and comparable timing whether the email
 * exists or not. Both failure paths throw the same AppError, and the
 * unknown-email path burns the same bcrypt work as a wrong password
 * (see DUMMY_PASSWORD_HASH).
 */
export async function authenticate({ email, password }, { ip } = /** @type {{ ip?: string }} */ ({})) {
  const user = await prisma.user.findUnique({ where: { email } });

  // FR-1.10, before the bcrypt work — there is nothing to check a password
  // against while the account is locked. The 429 does disclose that the
  // account exists, which FR-1.6 otherwise forbids; that is the spec's own
  // trade and a narrow one, since reaching it costs ten failed attempts
  // against an address the attacker already suspected.
  assertNotLockedOut(user);

  if (!user) {
    // No LOGIN_FAILED here, deliberately. NFR-2.12's audit trail records
    // account history, and recordAuditEvent requires a real userId to
    // hash — there is no account for this event to be about. Auditing an
    // unknown email (even hashed) would also reopen the disclosure FR-1.6
    // closes: a reader who could tell "audited, no account" apart from
    // "audited, real account" would have the oracle the identical 401 is
    // built to deny them.
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    throw new AppError("INVALID_CREDENTIALS");
  }

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) {
    // One UPDATE against a bcrypt comparison that already cost hundreds of
    // milliseconds, so FR-1.6's "comparable timing" survives it. The
    // response is identical to the unknown-email path either way.
    const { locked } = await recordFailedLogin(user.id);
    await recordAuditEvent(AUDIT_ACTIONS.LOGIN_FAILED, { userId: user.id, ip });
    if (locked) await recordAuditEvent(AUDIT_ACTIONS.ACCOUNT_LOCKED, { userId: user.id, ip });
    throw new AppError("INVALID_CREDENTIALS");
  }

  // FR-1.10: "the counter resets on success."
  await clearFailedLogins(user);
  return user;
}
