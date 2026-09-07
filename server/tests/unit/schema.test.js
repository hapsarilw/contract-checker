import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Prisma, UserState, AuthTokenType, SourceType, Status, Risk, Severity, Category } from "@prisma/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, "..", "..");
const migrationsDir = join(serverRoot, "prisma", "migrations");

/** The applied SQL is what the database actually gets — assert against it, not the schema DSL. */
const migrationSql = readdirSync(migrationsDir)
  .filter((entry) => entry.endsWith("_init"))
  .map((entry) => readFileSync(join(migrationsDir, entry, "migration.sql"), "utf8"))
  .join("\n");

/**
 * Returns just the column list inside one CREATE TABLE statement.
 *
 * Necessary because an unbounded `CREATE TABLE "X"[\s\S]*?"col"` regex
 * silently matches across table boundaries — the AuditEvent assertion
 * below "passed" against a `"userId"` that actually belonged to a
 * FOREIGN KEY statement several tables later.
 */
function tableBody(table) {
  const match = migrationSql.match(new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`no CREATE TABLE statement found for ${table}`);
  return match[1];
}

describe("Prisma schema conformance with SRS §5.1", () => {
  it("exposes exactly the six specified models", () => {
    expect(Object.values(Prisma.ModelName).sort()).toEqual([
      "Analysis",
      "AuditEvent",
      "AuthToken",
      "Document",
      "Finding",
      "User",
    ]);
  });

  describe("enums", () => {
    // PRD §8.1's table also lists DELETED, but says "Not a flag — the row
    // is gone." Adding it here would convert a hard delete into a soft one
    // and break FR-4.6.
    it("UserState has four states, without DELETED", () => {
      expect(Object.values(UserState)).toEqual(["UNVERIFIED", "ACTIVE", "LOCKED", "SUSPENDED"]);
    });

    it("AuthTokenType", () => {
      expect(Object.values(AuthTokenType)).toEqual(["EMAIL_VERIFICATION", "PASSWORD_RESET"]);
    });

    it("SourceType", () => {
      expect(Object.values(SourceType)).toEqual(["UPLOAD_PDF", "UPLOAD_DOCX", "PASTE"]);
    });

    it("Status", () => {
      expect(Object.values(Status)).toEqual(["PENDING", "COMPLETED", "FAILED"]);
    });

    it("Risk and Severity", () => {
      expect(Object.values(Risk)).toEqual(["LOW", "MEDIUM", "HIGH"]);
      expect(Object.values(Severity)).toEqual(["LOW", "MEDIUM", "HIGH"]);
    });

    it("Category", () => {
      expect(Object.values(Category)).toEqual([
        "PAYMENT",
        "IP",
        "SCOPE",
        "TERMINATION",
        "LIABILITY",
        "CONFIDENTIALITY",
        "DISPUTE",
        "OTHER",
      ]);
    });
  });

  describe("the initial migration", () => {
    it("creates every table", () => {
      for (const table of ["User", "AuthToken", "Document", "Analysis", "Finding", "AuditEvent"]) {
        expect(migrationSql, `missing table ${table}`).toContain(`CREATE TABLE "${table}"`);
      }
    });

    it("creates every @@index the spec lists", () => {
      const indexes = [
        'CREATE INDEX "AuthToken_userId_type_idx"',
        'CREATE INDEX "AuthToken_expiresAt_idx"',
        'CREATE INDEX "Document_userId_createdAt_idx"',
        'CREATE INDEX "Document_createdAt_idx"',
        'CREATE INDEX "Analysis_documentId_createdAt_idx"',
        'CREATE INDEX "Analysis_status_createdAt_idx"',
        'CREATE INDEX "Finding_analysisId_idx"',
        'CREATE INDEX "AuditEvent_subjectHash_createdAt_idx"',
        'CREATE INDEX "AuditEvent_createdAt_idx"',
      ];
      for (const index of indexes) {
        expect(migrationSql, `missing index: ${index}`).toContain(index);
      }
    });

    it("creates the unique constraints on User.email and AuthToken.tokenHash", () => {
      expect(migrationSql).toContain('CREATE UNIQUE INDEX "User_email_key"');
      expect(migrationSql).toContain('CREATE UNIQUE INDEX "AuthToken_tokenHash_key"');
    });

    // The single most important assertion in this file. Every other model
    // cascades from User; adding that same pattern to AuditEvent would
    // destroy the audit trail at exactly the moment it matters — the
    // record that an account was deleted, deleted by the deletion it
    // records (FR-4.6).
    it("gives AuditEvent NO foreign key and NO relation to User", () => {
      expect(migrationSql).not.toContain('"AuditEvent" ADD CONSTRAINT');
      expect(tableBody("AuditEvent")).not.toContain("userId");
      expect(tableBody("AuditEvent")).toContain("subjectHash");
    });

    it("has exactly four foreign keys, all of them cascading from their parent", () => {
      const foreignKeys = migrationSql.match(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY/g) ?? [];
      expect(foreignKeys).toHaveLength(4);
      expect(migrationSql).toContain('ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey"');
      expect(migrationSql).toContain('ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey"');
      expect(migrationSql).toContain('ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_documentId_fkey"');
      expect(migrationSql).toContain('ALTER TABLE "Finding" ADD CONSTRAINT "Finding_analysisId_fkey"');
      expect(migrationSql.match(/ON DELETE CASCADE/g) ?? []).toHaveLength(4);
    });

    it("makes Analysis.model non-nullable — an analysis always records which model was asked", () => {
      expect(tableBody("Analysis")).toContain('"model" TEXT NOT NULL');
    });

    it("stores Analysis.missingClauses as a native Postgres array", () => {
      expect(tableBody("Analysis")).toContain('"missingClauses" TEXT[]');
    });

    it("ships Document.textSha256 now, though its cache is Phase 2", () => {
      expect(tableBody("Document")).toContain('"textSha256" TEXT NOT NULL');
    });

    it("does NOT contain the FR-3.8 partial unique index — that is step 10's raw SQL migration", () => {
      expect(migrationSql).not.toContain("analysis_one_pending_per_document");
    });
  });
});
