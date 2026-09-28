import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { accountExportLimiter } from "../middleware/rateLimits.js";
import { deleteAccountSchema } from "../schemas/account.js";
import { recordAuditEvent, AUDIT_ACTIONS } from "../lib/audit.js";
import {
  deleteAccount,
  exportAccount,
  sendAccountDeletedNotice,
} from "../services/account.js";
import { SESSION_COOKIE_NAME, clearSessionCookieOptions } from "../services/auth.js";

const router = Router();

/**
 * PRD §12.5's two self-serve rights: access (FR-4.5) and erasure
 * (FR-4.6). Thin, like every other route file here — the decisions that
 * matter (what the export may contain, what a deletion destroys) live in
 * services/account.js and lib/serializers.js.
 */

// GET /api/v1/account/export — FR-4.5.
//
// A GET, and side-effect free, which is what puts it on the audited list
// in tests/integration/csrf.test.js: it reads the caller's own rows and
// writes nothing, not even an audit event. That last part is a judgement
// rather than an oversight — NFR-2.12 enumerates the events this system
// records, and an export is not among them. Adding one would also mean a
// GET that writes, which is exactly what FR-1.12(d) forbids.
//
// The limiter is mounted AFTER requireAuth, necessarily: it keys on
// req.auth.userId, which does not exist until requireAuth has run.
router.get("/export", requireAuth, accountExportLimiter, async (req, res, next) => {
  try {
    const data = await exportAccount(req.auth.userId);

    // Content-Disposition, so a browser hitting this URL saves a file
    // rather than rendering 50 MB of contract text into a tab. The name
    // carries the date because a user who exports twice should not have
    // to guess which file is which.
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="clausecheck-export-${stamp}.json"`,
    );
    res.status(200).json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/account — FR-4.6. Hard, cascading, irreversible.
//
// The password is re-entered in the request BODY, and a DELETE with a
// body is unusual enough to be worth defending: it is what keeps the
// password out of the URL, where it would land in access logs, browser
// history and any proxy in between. FR-1.12(c) already requires
// Content-Type: application/json on every state-changing request, so a
// client is sending a body regardless.
//
// No dedicated brute-force limiter, matching change-password and
// change-email, which take the same confirmation: reaching this endpoint
// at all requires a valid session cookie, so guessing here means already
// holding the account, and the general 100-per-15-minutes bucket bounds
// the attempt. FR-1.10's lockout deliberately counts LOGINS, not
// confirmations — making a confirmation failure lock the account would
// hand anyone with a stolen cookie a way to lock the real owner out.
router.delete(
  "/",
  requireAuth,
  validateBody(deleteAccountSchema),
  async (req, res, next) => {
    try {
      const userId = req.auth.userId;
      const { email } = await deleteAccount(userId, req.body.password);

      // AFTER the transaction commits, and deliberately OUTSIDE it.
      //
      // Inside would look stronger — the deletion and its evidence
      // committing together — but it inverts the failure. recordAuditEvent
      // swallows its errors by design (lib/audit.js), and Postgres aborts a
      // whole transaction on any failed statement, so an audit insert that
      // failed inside this transaction would either refuse a deletion the
      // user asked for, or roll it back silently while this handler
      // answered 200. Both are worse than the risk of writing it here:
      // losing one row if the process dies in the milliseconds between the
      // commit and this line.
      //
      // The row survives the user it is about because AuditEvent has no
      // foreign key to User — see lib/audit.js, and the test that proves it
      // with a real DELETE rather than by reading the schema.
      await recordAuditEvent(AUDIT_ACTIONS.ACCOUNT_DELETED, { userId, ip: req.ip });

      // Every outstanding cookie for this account already fails FR-1.9's
      // check by absence of the user row. Clearing this one is still worth
      // doing: it stops the browser that asked from holding a credential
      // that now produces a 401 on every request.
      res.clearCookie(SESSION_COOKIE_NAME, clearSessionCookieOptions());

      sendAccountDeletedNotice(email);

      res.status(200).json({
        deleted: true,
        message:
          "Your account, your documents and every report have been permanently deleted. " +
          "There is no undo. Backups are retained for up to 30 days before they age out.",
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
