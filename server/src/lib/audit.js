import { createHmac } from "node:crypto";
import config from "../config.js";
import prisma from "./prisma.js";
import logger from "../observability/logger.js";
import { getRequestId } from "../middleware/requestId.js";

/**
 * The security audit trail (NFR-2.12, AuditEvent in SRS §5.1).
 *
 * "Registration, login success and failure, lockout, password change and
 *  reset, email change, sign-out-everywhere, account deletion, and
 *  operator suspension. No document content, no plaintext identifiers."
 *
 * NO FOREIGN KEY TO User, AND THAT IS THE POINT. AuditEvent has no
 * relation to User and must never gain one — every other model in this
 * schema cascades on delete, which is correct for THEM, and would be
 * exactly wrong here: FR-4.6 needs the fact and timestamp of a deletion
 * to survive the deletion itself, and a cascading foreign key would erase
 * the evidence in the same transaction that creates it. `subjectHash` is
 * an HMAC, not an id, precisely so the row can outlive the row it is
 * about.
 *
 * HASHED, NEVER RAW. `subjectHash = hmac(userId, AUDIT_SALT)` and
 * `ipHash = hmac(ip, AUDIT_SALT)`. A plaintext userId or IP in this table
 * would be the personal data NFR-2.12 explicitly rules out, and would
 * also turn "delete the user" into a lie: the account is gone from User,
 * but its history sits unredacted in AuditEvent. HMAC lets rows for the
 * same subject be correlated (same input, same salt, same output)
 * without the table ever holding an identifier a reader could act on
 * directly.
 *
 * AUDIT_SALT MUST NEVER BE ROTATED CASUALLY. It is the one secret in this
 * system where rotation is not a routine hygiene operation — every
 * historical subjectHash and ipHash was computed with the salt in force
 * at the time, so rotating it makes every existing row permanently
 * uncorrelatable with rows written afterward, silently, with no error and
 * no way to reconstruct the mapping. This is unlike JWT_SECRET, where
 * rotation is the INTENDED response to a suspected leak (it signs
 * everyone out and nothing is lost). Step 74's rotation runbook must
 * treat AUDIT_SALT as a different class of secret: never rotate it
 * without a documented reason and an accepted, explicit loss of
 * historical correlation.
 */

/**
 * NFR-2.12's event types. All have a caller: OPERATOR_SUSPENDED waited
 * until step 69, when the spend runbook needed a way to suspend an account
 * and services/operator.js became it.
 *
 * Two were added at step 69, for the operator actions the runbooks call
 * for, because an operator acting on a user's data is exactly the kind of
 * event NFR-2.12 exists to record:
 *   OPERATOR_EXPORTED           SRS §12.4 step 4: "Record completion in
 *                               AuditEvent" — a DSAR export run for a user
 *                               who could not use the self-serve one.
 *   OPERATOR_SUSPENSION_LIFTED  the other half of OPERATOR_SUSPENDED, so a
 *                               suspension that was lifted is not
 *                               indistinguishable from one still in force.
 * An operator ERASURE records ACCOUNT_DELETED, the same event self-serve
 * deletion records, because it is the same deletion (services/account.js's
 * eraseAccount); its requestId carries the DSAR reference.
 */
export const AUDIT_ACTIONS = Object.freeze({
  REGISTERED: "REGISTERED",
  LOGIN_SUCCEEDED: "LOGIN_SUCCEEDED",
  LOGIN_FAILED: "LOGIN_FAILED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  PASSWORD_RESET: "PASSWORD_RESET",
  EMAIL_CHANGED: "EMAIL_CHANGED",
  SIGNED_OUT_EVERYWHERE: "SIGNED_OUT_EVERYWHERE",
  ACCOUNT_DELETED: "ACCOUNT_DELETED",
  OPERATOR_SUSPENDED: "OPERATOR_SUSPENDED",
  OPERATOR_SUSPENSION_LIFTED: "OPERATOR_SUSPENSION_LIFTED",
  OPERATOR_EXPORTED: "OPERATOR_EXPORTED",
});

/** @typedef {typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS]} AuditAction */

/** @param {string} value */
function hmac(value) {
  return createHmac("sha256", config.AUDIT_SALT).update(value, "utf8").digest("hex");
}

/**
 * hmac(userId, AUDIT_SALT) — the correlatable, non-reversible stand-in for
 * a user id that this table is allowed to hold. Exported so FR-4.5's data
 * export (step 57) can show a user their own rows without this module
 * growing a second, looser code path for the same hash.
 *
 * @param {string} userId
 */
export const subjectHash = (userId) => hmac(userId);

/**
 * Records one audit event. NEVER THROWS: the audit trail is an observer
 * of the security-relevant thing that already happened, not a gate on it.
 * If writing the row failed the same way registration or login just
 * succeeded, the right response is to log the failure loudly and let the
 * user's request complete regardless — an outage in the audit table must
 * not become an outage in authentication.
 *
 * CALLERS SHOULD `await` THIS, unlike the email queue it otherwise
 * resembles. Email is deliberately fire-and-forget because a provider
 * call is third-party network I/O that can take seconds and genuinely
 * must not delay the response. This is one row on the SAME local
 * database the request already used — negligible latency — and because
 * it never throws, awaiting it costs nothing in error safety. Not
 * awaiting it means a 200 can reach the client before the row exists,
 * which surfaced as exactly that: a test reading the table immediately
 * after its request completed found nothing there yet, intermittently,
 * because the write was still in flight.
 *
 * @param {AuditAction} action
 * @param {{ userId: string, ip?: string | null, requestId?: string }} details
 *   `userId` is always required, even for LOGIN_FAILED against an unknown
 *   email — callers that only have an email must not pass it here; hash
 *   the userId once one is resolved, or omit the call. Hashing an email
 *   would defeat FR-1.6's refusal to let a login failure disclose account
 *   existence, since the same email always hashes to the same value.
 */
export async function recordAuditEvent(action, { userId, ip, requestId }) {
  try {
    await prisma.auditEvent.create({
      data: {
        subjectHash: subjectHash(userId),
        action,
        ipHash: ip ? hmac(ip) : null,
        requestId: requestId ?? getRequestId() ?? null,
      },
    });
  } catch (err) {
    logger.error(
      {
        alert: "audit_write_failed",
        audit: { action },
        err: { message: err instanceof Error ? err.message : String(err) },
      },
      "could not write an audit event",
    );
  }
}
