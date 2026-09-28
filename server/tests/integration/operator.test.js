import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import prisma from "../../src/lib/prisma.js";
import { getEmailService, resetEmailForTests } from "../../src/lib/email.js";
import { subjectHash } from "../../src/lib/audit.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import {
  liftSuspension,
  operatorErase,
  operatorExport,
  restoredDeletions,
  spendByAccount,
  suspendAccount,
} from "../../src/services/operator.js";
import config from "../../src/config.js";
import { run } from "../../scripts/ops.js";
import { createAnalysis, createDocument, createUser } from "./factories.js";
import { testServer } from "./testServer.js";

/**
 * BUILD-PLAN step 69: the operator actions the runbooks call for, against a
 * real database. Each is checked for what it does, for the audit row it
 * leaves (NFR-2.12), and for what it refuses to do without a reason.
 */

const cookieFor = (user) =>
  `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;

const auditFor = (userId) =>
  prisma.auditEvent.findMany({ where: { subjectHash: subjectHash(userId) }, orderBy: { createdAt: "asc" } });

const sink = () =>
  /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
    /** @type {any} */ (getEmailService().provider)
  );

beforeEach(() => resetEmailForTests());
afterEach(() => resetEmailForTests());

describe("suspend and lift (spend-ceiling-approaching)", () => {
  it("a suspended account is refused on its next request, and the suspension is audited with its reference", async () => {
    const user = await createUser({ email: "heavy-user@example.test", emailVerifiedAt: new Date() });
    expect((await request(testServer()).get("/api/v1/auth/me").set("Cookie", cookieFor(user))).status).toBe(200);

    const result = await suspendAccount("  Heavy-User@Example.test ", { reference: "INC-42" });

    expect(result).toMatchObject({ state: "SUSPENDED", changed: true });
    // The SAME cookie, unrevoked: requireAuth reads the state on every request.
    const res = await request(testServer()).get("/api/v1/auth/me").set("Cookie", cookieFor(user));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    const audit = await auditFor(user.id);
    expect(audit.map((e) => e.action)).toContain("OPERATOR_SUSPENDED");
    expect(audit.find((e) => e.action === "OPERATOR_SUSPENDED")?.requestId).toBe("operator:INC-42");
  });

  it("refuses to act without a reference", async () => {
    await createUser({ email: "no-ref@example.test" });
    await expect(suspendAccount("no-ref@example.test", { reference: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { email: "no-ref@example.test" } })).state).toBe("ACTIVE");
  });

  it("lifting restores ACTIVE only to an account that had verified its address", async () => {
    const verified = await createUser({ email: "was-verified@example.test", emailVerifiedAt: new Date() });
    const never = await createUser({ email: "never-verified@example.test", state: "UNVERIFIED" });
    for (const email of [verified.email, never.email]) await suspendAccount(email, { reference: "INC-43" });

    expect(await liftSuspension(verified.email, { reference: "INC-43" })).toMatchObject({ state: "ACTIVE" });
    // Restoring ACTIVE here would let a suspend-and-lift skip FR-1.7's gate.
    expect(await liftSuspension(never.email, { reference: "INC-43" })).toMatchObject({ state: "UNVERIFIED" });
    expect((await auditFor(never.id)).map((e) => e.action)).toContain("OPERATOR_SUSPENSION_LIFTED");
  });

  it("lifting an account that is not suspended changes nothing", async () => {
    const user = await createUser({ email: "not-suspended@example.test" });
    expect(await liftSuspension(user.email, { reference: "INC-44" })).toMatchObject({ changed: false, state: "ACTIVE" });
    expect(await auditFor(user.id)).toEqual([]);
  });
});

describe("spend by account (spend-ceiling-approaching)", () => {
  it("ranks this month's accounts by estimated cost, failed analyses included", async () => {
    const now = new Date();
    const heavy = await createUser({ email: "spender@example.test" });
    const light = await createUser({ email: "light@example.test" });
    const heavyDoc = await createDocument({ userId: heavy.id });
    const lightDoc = await createDocument({ userId: light.id });
    for (let i = 0; i < 3; i += 1) {
      await createAnalysis({ documentId: heavyDoc.id, inputTokens: 100_000, outputTokens: 10_000 });
    }
    // A failure spent tokens too (FR-5.2).
    await createAnalysis({ documentId: heavyDoc.id, status: "FAILED", errorCode: "LLM_TIMEOUT", inputTokens: 100_000, outputTokens: 0 });
    await createAnalysis({ documentId: lightDoc.id, inputTokens: 1_000, outputTokens: 100 });

    const report = await spendByAccount({ now });

    expect(report.top[0]).toMatchObject({ email: "spender@example.test", analyses: 4, failed: 1 });
    expect(report.top[0].inputTokens).toBe(400_000);
    expect(report.top[0].shareOfTotal).toBeGreaterThan(0.9);
    expect(report.top.map((r) => r.email)).toContain("light@example.test");
  });
});

describe("DSAR export and erasure (dsar-request)", () => {
  /** @type {string} */
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clausecheck-ops-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("export returns the same document the self-serve export does, and is audited", async () => {
    const user = await createUser({ email: "dsar-export@example.test" });
    await createDocument({ userId: user.id });

    // Self-serve first: it writes nothing, while the operator export writes
    // an OPERATOR_EXPORTED audit row after reading — so in the other order
    // the self-serve export would legitimately include one more audit event.
    const selfServe = await request(testServer()).get("/api/v1/account/export").set("Cookie", cookieFor(user));
    const data = await operatorExport(user.email, { reference: "DSAR-7" });

    expect(selfServe.status).toBe(200);
    // Same function underneath. exportedAt differs by the milliseconds
    // between the two calls, so it is the one field set aside.
    const strip = (/** @type {any} */ body) => ({ ...body, exportedAt: undefined });
    expect(strip(JSON.parse(JSON.stringify(data)))).toEqual(strip(selfServe.body));
    const audit = await auditFor(user.id);
    expect(audit.find((e) => e.action === "OPERATOR_EXPORTED")?.requestId).toBe("dsar:DSAR-7");
  });

  it("erasure goes through the same code path as self-serve deletion: every row gone, audited, confirmed", async () => {
    const user = await createUser({ email: "dsar-erase@example.test" });
    const document = await createDocument({ userId: user.id });
    await createAnalysis({ documentId: document.id, findings: [{ severity: "HIGH" }] });

    await operatorErase(user.email, { reference: "DSAR-8", confirm: "dsar-erase@example.test" });

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.analysis.count({ where: { documentId: document.id } })).toBe(0);
    const audit = await auditFor(user.id);
    expect(audit.find((e) => e.action === "ACCOUNT_DELETED")?.requestId).toBe("dsar:DSAR-8");
    await getEmailService().flush();
    expect(sink().latestTo("dsar-erase@example.test")?.text).toContain("30 days");
  });

  it("erasure refuses unless --confirm repeats the address, and deletes nothing", async () => {
    const user = await createUser({ email: "dsar-keep@example.test" });
    await expect(
      operatorErase(user.email, { reference: "DSAR-9", confirm: "someone-else@example.test" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});

describe("restore-deletions (database-restore)", () => {
  // The OLD and the RESTORED database are the same test database here: what
  // is under test is the matching (deletion events after a time, against
  // the accounts present), not the second connection.
  it("lists the accounts deleted after the backup that the restore brought back, and nothing else", async () => {
    const since = new Date(Date.now() - 60_000);
    const leaver = await createUser({ email: "came-back@example.test" });
    const stayer = await createUser({ email: "never-left@example.test" });
    const earlier = await createUser({ email: "deleted-before-backup@example.test" });
    await prisma.auditEvent.create({ data: { subjectHash: subjectHash(leaver.id), action: "ACCOUNT_DELETED" } });
    // A deletion from BEFORE the backup: the restore does not bring it back,
    // so it must not be listed.
    await prisma.auditEvent.create({
      data: {
        subjectHash: subjectHash(earlier.id),
        action: "ACCOUNT_DELETED",
        createdAt: new Date(since.getTime() - 60 * 60 * 1000),
      },
    });

    const result = await restoredDeletions({ oldDatabaseUrl: config.DATABASE_URL, since });

    expect(result.resurrected.map((u) => u.email)).toContain("came-back@example.test");
    expect(result.resurrected.map((u) => u.email)).not.toContain("never-left@example.test");
    expect(result.resurrected.map((u) => u.email)).not.toContain("deleted-before-backup@example.test");
    void stayer;
  });

  it("compares instants in UTC whatever the process's own zone is", () => {
    // The first version of this tool handed node-pg a Date, which it sends in
    // the process's local zone; against a zoneless UTC column that moved
    // "since" by the zone offset and found nothing. This suite runs in a zone
    // ahead of UTC (vitest.config.js) precisely so that test above would
    // catch it; this line makes sure it still does.
    expect(new Date().getTimezoneOffset()).not.toBe(0);
  });

  it("refuses a --since that is not a date", async () => {
    await expect(
      restoredDeletions({ oldDatabaseUrl: config.DATABASE_URL, since: new Date("not a date") }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("scripts/ops.js, the command line the runbooks use", () => {
  /** @param {string[]} argv */
  async function cli(argv) {
    const lines = [];
    const code = await run(argv, { out: (line) => lines.push(line) });
    return { code, output: lines.join("\n") };
  }

  it("prints usage for no command, and refuses an unknown one", async () => {
    expect((await cli([])).code).toBe(0);
    const unknown = await cli(["drop-everything"]);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain("usage:");
  });

  it("suspend requires --reference", async () => {
    await createUser({ email: "cli-suspend@example.test" });
    await expect(cli(["suspend", "--email", "cli-suspend@example.test"])).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("export writes the data to a file readable only by its owner, and not to the terminal", async () => {
    const user = await createUser({ email: "cli-export@example.test" });
    await createDocument({ userId: user.id });
    const dir = await mkdtemp(join(tmpdir(), "clausecheck-ops-"));
    const out = join(dir, "export.json");
    try {
      const result = await cli(["export", "--email", user.email, "--reference", "DSAR-10", "--out", out]);

      expect(result.code).toBe(0);
      // The document text went to the file, never to the terminal.
      expect(result.output).not.toContain("This Agreement is made");
      const written = JSON.parse(await readFile(out, "utf8"));
      expect(written.documents[0].rawText).toContain("This Agreement is made");
      expect((await stat(out)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("spend-by-account prints a line per account", async () => {
    const user = await createUser({ email: "cli-spend@example.test" });
    const doc = await createDocument({ userId: user.id });
    await createAnalysis({ documentId: doc.id, inputTokens: 5_000, outputTokens: 500 });

    const result = await cli(["spend-by-account"]);

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/^period \d{4}-\d{2}:/);
    expect(result.output).toContain("cli-spend@example.test");
  });
});
