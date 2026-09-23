import { z } from "zod";

/**
 * FR-4.6 — "confirmed by re-entering the password". One field, named
 * `password` rather than `currentPassword`: the change-password and
 * change-email bodies carry a NEW value alongside the old one and need
 * the distinction, this one does not, and inventing a distinction that
 * isn't there makes the field harder to get right from the client.
 *
 * Deliberately NOT length-validated, for the same reason loginSchema's
 * password isn't: a 400 for a short password and a 400-with-a-different-
 * field for a wrong one are both 400s here, but a length rule would also
 * lock out any account whose password predates a rules change — and this
 * is the one endpoint where being unable to confirm means being unable to
 * exercise an erasure right.
 */
export const deleteAccountSchema = z
  .object({
    password: z.string(),
  })
  .strict();
