import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import logger from "../../src/observability/logger.js";
import { AUDIT_ACTIONS, recordAuditEvent, subjectHash } from "../../src/lib/audit.js";

/**
 * NFR-2.12 — the audit trail, at the level a real database is not needed
 * for: the hash construction, the never-throws contract, and that all ten
 * action constants exist and are stable strings. The FK/cascade behaviour
 * needs Postgres and lives in tests/integration/audit.test.js.
 */

const HMAC = (value) => createHmac("sha256", config.AUDIT_SALT).update(value, "utf8").digest("hex");

describe("subjectHash", () => {
  it("is hmac(userId, AUDIT_SALT), not a plain hash", () => {
    // A plain SHA-256 of the userId would be reversible by dictionary —
    // ids are not secret, so a keyless hash gives no protection at all.
    expect(subjectHash("user-123")).toBe(HMAC("user-123"));
  });

  it("is deterministic — the same id always hashes the same way, which is what makes rows correlatable", () => {
    expect(subjectHash("user-123")).toBe(subjectHash("user-123"));
  });

  it("gives different ids different hashes", () => {
    expect(subjectHash("user-123")).not.toBe(subjectHash("user-456"));
  });

  it("never contains the raw id as a substring", () => {
    const id = "cuid_abcdef1234567890";
    expect(subjectHash(id)).not.toContain(id);
  });
});

describe("AUDIT_ACTIONS — NFR-2.12's event types", () => {
  // Ten until step 69, which added the two operator actions the runbooks
  // needed (OPERATOR_SUSPENSION_LIFTED, OPERATOR_EXPORTED) and amended
  // NFR-2.12's text to name them. A count, not just a list, so an action
  // cannot be added without this — and the spec — being updated with it.
  it("has exactly twelve actions", () => {
    expect(Object.keys(AUDIT_ACTIONS)).toHaveLength(12);
  });

  it.each([
    "REGISTERED",
    "LOGIN_SUCCEEDED",
    "LOGIN_FAILED",
    "ACCOUNT_LOCKED",
    "PASSWORD_CHANGED",
    "PASSWORD_RESET",
    "EMAIL_CHANGED",
    "SIGNED_OUT_EVERYWHERE",
    "ACCOUNT_DELETED",
    "OPERATOR_SUSPENDED",
    "OPERATOR_SUSPENSION_LIFTED",
    "OPERATOR_EXPORTED",
  ])("defines %s", (action) => {
    expect(AUDIT_ACTIONS[action]).toBe(action);
  });
});

describe("recordAuditEvent NEVER throws (NFR-3.8's rule applied to audit too)", () => {
  it("swallows a database failure and logs it instead", async () => {
    const spy = vi.spyOn(prisma.auditEvent, "create").mockRejectedValueOnce(new Error("connection reset"));
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    // The audit trail observes something that already happened; it must
    // never become a reason that thing fails to complete for the user.
    await expect(recordAuditEvent(AUDIT_ACTIONS.LOGIN_SUCCEEDED, { userId: "u1" })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ alert: "audit_write_failed" }),
      expect.any(String),
    );
    spy.mockRestore();
    errorSpy.mockRestore();
  });
});
