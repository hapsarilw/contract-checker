import { z } from "zod";

/**
 * FR-1.2 — 10 to 200 characters, no composition rules.
 *
 * The upper bound is not arbitrary tidiness: bcrypt silently truncates
 * at 72 bytes, so a 300-character password and its first 72 characters
 * are the same password as far as the hash is concerned. Rejecting
 * anything longer than 200 avoids a user believing in strength that
 * isn't there. (200 rather than 72 because the surprise is what matters,
 * not the exact boundary — and the frontend states the rule before
 * submission, FR-7.x, rather than after rejection.)
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * FR-1.1 — trimmed and lowercased BEFORE the shape check, so a pasted
 * "  User@Example.COM " is accepted and stored as "user@example.com".
 * Validating first would reject it for whitespace the user cannot see.
 */
const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("must be a valid email address"));

export const registerSchema = z
  .object({
    email: emailField,
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
      .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailField,
    /**
     * Deliberately NOT length-validated, unlike registration.
     *
     * A login that returned 400 for a 9-character password and 401 for a
     * 10-character wrong one would be an oracle: it tells an attacker
     * which guesses are even worth making, and it locks out any user
     * whose password predates a rules change. Every credential-shaped
     * input funnels to the same 401 INVALID_CREDENTIALS (FR-1.6);
     * only a structurally malformed body gets a 400.
     */
    password: z.string(),
  })
  .strict();

/**
 * A token from an email link. Bounded, so a hostile body cannot make the
 * server hash a megabyte: a real one is 43 characters (32 bytes,
 * base64url), and the range leaves room without inviting abuse.
 */
export const verifyEmailSchema = z
  .object({
    token: z.string().min(20, "is not a valid token").max(128, "is not a valid token"),
  })
  .strict();

/**
 * FR-1.8. The email is validated and normalised the same way registration
 * does it, so "  Alice@Example.COM " and "alice@example.com" are one
 * account here too — otherwise a user who signed up with stray whitespace
 * could never reset.
 */
export const forgotPasswordSchema = z
  .object({
    email: emailField,
  })
  .strict();

/**
 * The new password is held to registration's rules. Rejecting a weak one
 * at reset is not redundant: reset is exactly where someone under pressure
 * picks something short.
 */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(20, "is not a valid token").max(128, "is not a valid token"),
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
      .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`),
  })
  .strict();
