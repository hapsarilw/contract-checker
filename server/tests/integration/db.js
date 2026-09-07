import prisma from "../../src/lib/prisma.js";

/** Every table §5.1 defines. Keep in sync with schema.prisma's model list. */
const TABLES = ["User", "AuthToken", "Document", "Analysis", "Finding", "AuditEvent"];

/**
 * Truncates every table between tests, so one test's rows never leak
 * into the next. A single statement naming every table lets Postgres
 * order the cascade itself rather than the caller computing a
 * topological delete order by hand.
 */
export async function truncateAll() {
  const quoted = TABLES.map((table) => `"${table}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
}
