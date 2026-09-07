import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import prisma from "../../src/lib/prisma.js";

/**
 * Fixture builders for integration tests. Building fixtures through these
 * instead of ad-hoc `prisma.user.create({...})` calls in every test file
 * means a schema change (a new required field) is fixed in one place,
 * and a test reads as "a locked user" rather than a wall of field names.
 */

/**
 * @param {{ state?: "UNVERIFIED"|"ACTIVE"|"LOCKED"|"SUSPENDED", email?: string, password?: string, passwordHash?: string, [key: string]: any }} [options]
 */
export async function createUser({ state = "ACTIVE", email, password = "Password123!", passwordHash, ...rest } = {}) {
  return prisma.user.create({
    data: {
      email: email ?? `${randomUUID()}@example.test`,
      // A real bcrypt hash by default, not a placeholder string — a
      // factory-created user should be usable in a login test (step 12)
      // without the test having to know how to hash a password itself.
      // Pass passwordHash directly to bypass hashing (e.g. a
      // deliberately malformed hash for an edge-case test).
      passwordHash: passwordHash ?? (await bcrypt.hash(password, 4)),
      state,
      ...rest,
    },
  });
}

/**
 * @param {{ userId?: string, [key: string]: any }} [options]
 */
export async function createDocument({ userId, ...rest } = {}) {
  const resolvedUserId = userId ?? (await createUser()).id;
  return prisma.document.create({
    data: {
      userId: resolvedUserId,
      sourceType: "PASTE",
      rawText: "This Agreement is made between Client and Contractor for testing purposes.",
      textSha256: randomUUID(),
      wordCount: 12,
      byteSize: 76,
      ...rest,
    },
  });
}

/**
 * @param {{ category?: import("@prisma/client").Category, severity?: import("@prisma/client").Severity, clauseExcerpt?: string, explanation?: string, suggestedChange?: string }} [finding]
 * @returns {{ category: import("@prisma/client").Category, severity: import("@prisma/client").Severity, clauseExcerpt: string, explanation: string, suggestedChange: string }}
 */
function findingDefaults(finding = {}) {
  return {
    category: finding.category ?? "OTHER",
    severity: finding.severity ?? "MEDIUM",
    clauseExcerpt: finding.clauseExcerpt ?? "Sample clause excerpt for testing.",
    explanation: finding.explanation ?? "Sample explanation for testing.",
    suggestedChange: finding.suggestedChange ?? "Sample suggested change for testing.",
  };
}

/**
 * Defaults to a COMPLETED analysis — most tests want a finished report
 * to read back. A test that specifically needs PENDING state (e.g. the
 * FR-3.8 guard) passes `status: "PENDING"` explicitly.
 *
 * @param {{ documentId?: string, findings?: Parameters<typeof findingDefaults>[0][], [key: string]: any }} [options]
 */
export async function createAnalysis({ documentId, findings = [], ...rest } = {}) {
  const resolvedDocumentId = documentId ?? (await createDocument()).id;
  return prisma.analysis.create({
    data: {
      documentId: resolvedDocumentId,
      status: "COMPLETED",
      model: "claude-haiku-4-5",
      completedAt: new Date(),
      ...rest,
      findings:
        findings.length > 0 ? { create: findings.map((finding) => findingDefaults(finding)) } : undefined,
    },
    include: { findings: true },
  });
}
