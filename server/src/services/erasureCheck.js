import { createHash } from "node:crypto";
import { AppError } from "../lib/AppError.js";
import { subjectHash } from "../lib/audit.js";
import prisma from "../lib/prisma.js";
import { getRedis, keysNamingAccount } from "../lib/redis.js";
import { wholeAddressPattern } from "../lib/wholeAddress.js";
import { findAccountByEmail } from "./operator.js";

/**
 * PRD §9, Phase 1.5 definition of done, item 1 (BUILD-PLAN step 75): "An
 * external tester recovers a forgotten password and deletes their account
 * unaided; verified AFTERWARDS that no rows remain. Check the tables
 * directly, not through the API."
 *
 * Two halves, run by the operator on either side of the tester's deletion
 * (scripts/ops.js erasure-record and erasure-verify):
 *
 *   recordErasureSubject   BEFORE. Who the account is, as identifiers: the
 *                          user id, the id of every row hanging off it, the
 *                          audit subject hash, a digest of the address.
 *                          No content, and not the address itself.
 *   verifyErasure          AFTER. Postgres and Redis, asked directly.
 *
 * "DIRECTLY" MEANS SQL AND SCAN, NEVER A ROUTE. A route reports what its
 * own query finds, so a route that missed a table would miss it in the
 * check as well. Three ways something can survive, each looked for
 * differently:
 *
 *   1. a row recorded beforehand that is still there: looked up by id;
 *   2. a row that refers to the account and was never recorded, such as a
 *      child table added later without ON DELETE CASCADE, which is SRS
 *      §12.4's "forgotten child table": every text-like column of every
 *      table in the schema is searched for the user id and the address;
 *   3. state outside Postgres: every Redis key is searched for both.
 *
 * Audit events stay BY DESIGN (the trail outlives the account; PRD §12.4),
 * keyed by an HMAC of the user id. They are counted and reported, never
 * counted as a failure, and check 2 confirms they hold neither the id nor
 * the address in plain.
 *
 * NOT COVERED, and said so in the output rather than implied: backups,
 * which keep the account until they age out (30 days, PRD §12.4), and
 * copies held by subprocessors (the email provider's delivery logs).
 */

/** @param {string} email */
const normalise = (email) => email.trim().toLowerCase();
/** @param {string} value */
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * @typedef {{
 *   recordedAt: string,
 *   userId: string,
 *   emailSha256: string,
 *   subjectHash: string,
 *   ids: { authTokens: string[], documents: string[], analyses: string[], findings: string[] },
 * }} ErasureRecord
 */

/**
 * @param {string} email
 * @returns {Promise<ErasureRecord>}
 */
export async function recordErasureSubject(email) {
  const user = await findAccountByEmail(email);
  const userId = user.id;
  const pick = (/** @type {{ id: string }[]} */ rows) => rows.map((r) => r.id).sort();
  const [authTokens, documents, analyses, findings] = await Promise.all([
    prisma.authToken.findMany({ where: { userId }, select: { id: true } }),
    prisma.document.findMany({ where: { userId }, select: { id: true } }),
    prisma.analysis.findMany({ where: { document: { userId } }, select: { id: true } }),
    prisma.finding.findMany({
      where: { analysis: { document: { userId } } },
      select: { id: true },
    }),
  ]);
  return {
    recordedAt: new Date().toISOString(),
    userId,
    emailSha256: sha256(normalise(email)),
    subjectHash: subjectHash(userId),
    ids: {
      authTokens: pick(authTokens),
      documents: pick(documents),
      analyses: pick(analyses),
      findings: pick(findings),
    },
  };
}

/** @param {string} name */
const quoteIdent = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * Every table and text-like column in the application's schema, from the
 * catalogue rather than from a list here: a list is the thing that goes
 * stale when a table is added. Text, varchar, json and arrays of them, read
 * as text, which is where an id or an address could be.
 */
async function textColumns() {
  /** @type {{ table_name: string, column_name: string }[]} */
  const rows = await prisma.$queryRaw`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema()
       and t.table_type = 'BASE TABLE'
       and c.table_name <> '_prisma_migrations'
       and (c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
            or (c.data_type = 'ARRAY' and c.udt_name in ('_text', '_varchar')))
     order by 1, 2`;
  return rows;
}

/**
 * @param {ErasureRecord} record
 * @param {{ email: string }} options the address, given again: it is not in
 *   the record, and the sweep needs it in plain to search for it
 */
export async function verifyErasure(record, { email }) {
  const address = normalise(email);
  if (sha256(address) !== record.emailSha256) {
    throw new AppError("VALIDATION_ERROR", {
      message: "That address is not the one this record was taken for.",
    });
  }
  const { userId, ids } = record;

  // 1. The recorded rows, by id, and anything still pointing at the user.
  const tables = {
    User: await prisma.user.count({
      where: { OR: [{ id: userId }, { email: address }, { pendingEmail: address }] },
    }),
    AuthToken: await prisma.authToken.count({
      where: { OR: [{ id: { in: ids.authTokens } }, { userId }] },
    }),
    Document: await prisma.document.count({
      where: { OR: [{ id: { in: ids.documents } }, { userId }] },
    }),
    Analysis: await prisma.analysis.count({
      where: {
        OR: [{ id: { in: ids.analyses } }, { documentId: { in: ids.documents } }],
      },
    }),
    Finding: await prisma.finding.count({
      where: { OR: [{ id: { in: ids.findings } }, { analysisId: { in: ids.analyses } }] },
    }),
  };

  // 2. Every text-like column of every table, for the id and the address.
  /** @type {Record<string, number>} */
  const sweep = {};
  const columns = await textColumns();
  for (const { table_name: table, column_name: column } of columns) {
    /** @type {{ n: number }[]} */
    const [{ n }] = await prisma.$queryRawUnsafe(
      `select count(*)::int as n from ${quoteIdent(table)}
        where lower(${quoteIdent(column)}::text) ~ $1
           or strpos(${quoteIdent(column)}::text, $2) > 0`,
      // The address as a WHOLE address, so another account's
      // "joann@x.co" is not this one's "ann@x.co" (lib/wholeAddress.js).
      wholeAddressPattern(address),
      userId,
    );
    if (n > 0) sweep[`${table}.${column}`] = n;
  }

  // 3. Redis: any key naming the account, with how long it has left.
  /** @type {{ key: string, ttlSeconds: number }[]} */
  const redisKeys = [];
  for (const key of await keysNamingAccount({ id: userId, email: address })) {
    redisKeys.push({ key, ttlSeconds: await getRedis().ttl(key) });
  }

  const auditEventsRetained = await prisma.auditEvent.count({
    where: { subjectHash: record.subjectHash },
  });

  const clean =
    Object.values(tables).every((n) => n === 0) &&
    Object.keys(sweep).length === 0 &&
    redisKeys.length === 0;
  return {
    clean,
    tables,
    sweep,
    columnsSwept: columns.length,
    redisKeys,
    auditEventsRetained,
    notChecked: [
      "backups, which keep the account until they age out (up to 30 days, PRD §12.4)",
      "subprocessors' own copies, such as the email provider's delivery logs",
    ],
  };
}
