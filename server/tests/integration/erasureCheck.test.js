import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { getRedis } from "../../src/lib/redis.js";
import { AUDIT_ACTIONS, recordAuditEvent } from "../../src/lib/audit.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { issueAuthToken } from "../../src/services/authTokens.js";
import { eraseAccount } from "../../src/services/account.js";
import { recordErasureSubject, verifyErasure } from "../../src/services/erasureCheck.js";
import { wholeAddressPattern } from "../../src/lib/wholeAddress.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";

/**
 * PRD §9, Phase 1.5 DoD item 1 (BUILD-PLAN step 75): after a deletion,
 * "verified AFTERWARDS that no rows remain. Check the tables directly, not
 * through the API." services/erasureCheck.js is that check; these tests
 * are what make it trustworthy: it reports CLEAN after a real deletion
 * through the real route, and it reports what is left when something is.
 *
 * Also the Redis half of erasure (services/account.js forgetAccountKeys):
 * the account's counters went with the row only once the check had looked
 * for them and found a 62-day quota counter and the raw address.
 */

const PASSWORD = "a-perfectly-fine-passphrase";
const PERIOD = "2026-10";

/** An account with a row in every table that hangs off it, and Redis counters naming it. */
async function seed(email) {
  const user = await createUser({ email, password: PASSWORD });
  const document = await createDocument({
    userId: user.id,
    rawText:
      "The Contractor shall deliver the designs within thirty days of the effective date.",
  });
  await createAnalysis({
    documentId: document.id,
    findings: [{ clauseExcerpt: "deliver the designs within thirty days" }],
  });
  await issueAuthToken(user.id, "PASSWORD_RESET");
  await recordAuditEvent(AUDIT_ACTIONS.PASSWORD_RESET, {
    userId: user.id,
    ip: "198.51.100.7",
  });

  const redis = getRedis();
  await redis.set(`quota:month:${user.id}:${PERIOD}`, "3", "EX", 62 * 24 * 3600);
  await redis.set(`quota:hour:${user.id}`, "1", "EX", 7200);
  await redis.set(`rl:analyze:user:${user.id}`, "1", "EX", 3600);
  await redis.set(`rl:forgot-email:email:${email}`, "1", "EX", 3600);
  return user;
}

const cookieFor = (user) =>
  `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;

describe("the erasure check (PRD §9 DoD item 1)", () => {
  it("reports CLEAN after a deletion through the real route: tables, every text column, Redis", async () => {
    const email = "erasure-clean@example.test";
    const user = await seed(email);
    // Someone else's counters, one with an address that ENDS in this one's.
    const other = await createUser({ email: `x${email}` });
    await getRedis().set(`rl:forgot-email:email:x${email}`, "2", "EX", 3600);
    await getRedis().set(`quota:hour:${other.id}`, "4", "EX", 7200);

    const record = await recordErasureSubject(email);
    expect(record.ids.documents).toHaveLength(1);
    expect(record.ids.analyses).toHaveLength(1);
    expect(record.ids.findings).toHaveLength(1);
    expect(record.ids.authTokens).toHaveLength(1);
    // The record holds a digest of the address, never the address.
    expect(JSON.stringify(record)).not.toContain(email);

    // Not vacuous: before the deletion, the check finds the account.
    const before = await verifyErasure(record, { email });
    expect(before.clean).toBe(false);
    expect(before.tables).toMatchObject({
      User: 1,
      Document: 1,
      Analysis: 1,
      Finding: 1,
      AuthToken: 1,
    });
    expect(before.redisKeys.map((k) => k.key).sort()).toEqual(
      [
        `quota:hour:${user.id}`,
        `quota:month:${user.id}:${PERIOD}`,
        `rl:analyze:user:${user.id}`,
        `rl:forgot-email:email:${email}`,
      ].sort(),
    );

    const res = await request(testServer())
      .delete("/api/v1/account")
      .set("Cookie", cookieFor(user))
      .set("Content-Type", "application/json")
      .send({ password: PASSWORD });
    expect(res.status).toBe(200);

    const after = await verifyErasure(record, { email: `  ${email.toUpperCase()} ` });
    expect(after.tables).toEqual({
      User: 0,
      AuthToken: 0,
      Document: 0,
      Analysis: 0,
      Finding: 0,
    });
    // The other account's row and key contain this address only as the
    // tail of a different one: neither is this account's residue.
    expect(after.sweep).toEqual({});
    expect(after.columnsSwept).toBeGreaterThan(10);
    expect(after.redisKeys).toEqual([]);
    expect(after.clean).toBe(true);
    // Two audit events stay, by design, under the HMAC subject.
    expect(after.auditEventsRetained).toBe(2);

    // The other account's counters survived the erasure.
    await expect(getRedis().get(`quota:hour:${other.id}`)).resolves.toBe("4");
    await expect(getRedis().get(`rl:forgot-email:email:x${email}`)).resolves.toBe("2");
  }, 30_000);

  it("says what it cannot check", async () => {
    const email = "erasure-alone@example.test";
    const user = await seed(email);
    const record = await recordErasureSubject(email);
    await eraseAccount(user);
    const result = await verifyErasure(record, { email });
    expect(result.clean).toBe(true);
    expect(result.notChecked.join(" ")).toMatch(/backups/);
  }, 30_000);

  it("finds a row left in a table it was never told about", async () => {
    const email = "erasure-leftover-row@example.test";
    const user = await seed(email);
    const record = await recordErasureSubject(email);
    await eraseAccount(user);

    // A table with the id in a text column and no foreign key: the
    // "forgotten child table" of SRS §12.4. JobRun stands in for it.
    await prisma.jobRun.create({ data: { job: `export-for-${user.id}` } });

    const result = await verifyErasure(record, { email });
    expect(result.clean).toBe(false);
    expect(result.sweep).toEqual({ "JobRun.job": 1 });
    expect(result.redisKeys).toEqual([]);
  }, 30_000);

  it("finds a Redis key nobody removed, and that alone makes it NOT clean", async () => {
    const email = "erasure-leftover-key@example.test";
    const user = await seed(email);
    const record = await recordErasureSubject(email);
    await eraseAccount(user);
    await getRedis().set(`cache:report:${user.id}`, "x", "EX", 600);

    const result = await verifyErasure(record, { email });
    expect(result.tables).toEqual({
      User: 0,
      AuthToken: 0,
      Document: 0,
      Analysis: 0,
      Finding: 0,
    });
    expect(result.sweep).toEqual({});
    expect(result.redisKeys.map((k) => k.key)).toEqual([`cache:report:${user.id}`]);
    expect(result.redisKeys[0].ttlSeconds).toBeGreaterThan(0);
    expect(result.clean).toBe(false);
  }, 30_000);

  it("JavaScript and Postgres agree on what a WHOLE address is (lib/wholeAddress.js)", async () => {
    // The Redis filter runs the pattern in JavaScript and the column sweep
    // runs it in Postgres. If the two dialects read it differently, erasure
    // and its check would disagree about what counts.
    const pattern = wholeAddressPattern("ann+test@x.co");
    const cases = {
      "rl:forgot-email:email:ann+test@x.co": true,
      "Write to ann+test@x.co.": true,
      "<ANN+TEST@X.CO>": true,
      "joann+test@x.co": false,
      "ann+test@x.com": false,
      "ann+test@x.co.uk": false,
      "ann+test@x.co-op.org": false,
      "annntest@x.co": false,
    };
    for (const [text, expected] of Object.entries(cases)) {
      const js = new RegExp(pattern).test(text.toLowerCase());
      /** @type {{ m: boolean }[]} */
      const [{ m }] = await prisma.$queryRawUnsafe(
        "select lower($1) ~ $2 as m",
        text,
        pattern,
      );
      expect([text, js, m]).toEqual([text, expected, expected]);
    }
  });

  it("refuses to verify a record against a different address", async () => {
    const email = "erasure-mismatch@example.test";
    await seed(email);
    const record = await recordErasureSubject(email);
    await expect(
      verifyErasure(record, { email: "someone-else@example.test" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  }, 30_000);
});
