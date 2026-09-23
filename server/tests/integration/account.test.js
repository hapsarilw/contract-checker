import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { AUDIT_ACTIONS, recordAuditEvent, subjectHash } from "../../src/lib/audit.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { issueAuthToken } from "../../src/services/authTokens.js";
import { createUser, createDocument, createAnalysis } from "./factories.js";
import { getEmailService, resetEmailForTests } from "../../src/lib/email.js";

/**
 * TR-12 (SRS §10.2) and FR-4.5 — PRD §12.5's two user rights, access and
 * erasure, through the real routes and the real database.
 *
 * THE DELETION TESTS COUNT ROWS IN EACH TABLE DIRECTLY. That is TR-12's
 * own instruction and it is not a stylistic preference: an assertion made
 * by calling the API passes happily while a child table quietly retains
 * rows, because every read path filters by owner and an orphaned row has
 * no owner to be found by. The only way to catch an incomplete erasure is
 * to look at the tables.
 */

const PASSWORD = "a-perfectly-fine-passphrase";
const json = (req) => req.set("Content-Type", "application/json");

const cookieFor = (user) =>
  `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;

const sink = () =>
  /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
    /** @type {any} */ (getEmailService().provider)
  );

/**
 * Every table that cascades from one user, counted from the database.
 * Analysis and Finding are reached through their parents because neither
 * carries a userId of its own — which is exactly the shape of table that
 * an incomplete deletion strands.
 *
 * @param {string} userId
 */
async function countRowsFor(userId) {
  const [users, documents, analyses, findings, authTokens] = await Promise.all([
    prisma.user.count({ where: { id: userId } }),
    prisma.document.count({ where: { userId } }),
    prisma.analysis.count({ where: { document: { userId } } }),
    prisma.finding.count({ where: { analysis: { document: { userId } } } }),
    prisma.authToken.count({ where: { userId } }),
  ]);
  return { users, documents, analyses, findings, authTokens };
}

/** The same five tables with no owner filter at all — nothing may be left anywhere. */
async function countAllRows() {
  const [users, documents, analyses, findings, authTokens] = await Promise.all([
    prisma.user.count(),
    prisma.document.count(),
    prisma.analysis.count(),
    prisma.finding.count(),
    prisma.authToken.count(),
  ]);
  return { users, documents, analyses, findings, authTokens };
}

const EMPTY = { users: 0, documents: 0, analyses: 0, findings: 0, authTokens: 0 };

/**
 * A user with at least one row in every table that hangs off them, plus
 * an audit row that must OUTLIVE them. Two documents, two analyses, three
 * findings and two tokens, so a count of zero afterwards is a real result
 * rather than a table that was empty to begin with.
 *
 * @param {string} email
 */
async function seedAccount(email) {
  const user = await createUser({ email, password: PASSWORD });

  const contract = await createDocument({
    userId: user.id,
    filename: "design-retainer.pdf",
    rawText: "The Contractor shall deliver the designs within thirty days of the effective date.",
  });
  const pasted = await createDocument({
    userId: user.id,
    filename: null,
    rawText: "Payment is due on receipt of invoice.",
  });

  await createAnalysis({
    documentId: contract.id,
    overallRisk: "LOW",
    // The one field PRD D7 forbids in any response, set to a DIFFERENT
    // value from overallRisk so a serializer that leaked it could not
    // pass by coincidence.
    modelRisk: "HIGH",
    summary: "A short retainer with one payment concern.",
    missingClauses: ["Late payment interest", "Kill fee"],
    findings: [
      { severity: "LOW", category: "SCOPE" },
      { severity: "HIGH", category: "PAYMENT" },
    ],
  });
  await createAnalysis({
    documentId: pasted.id,
    overallRisk: "MEDIUM",
    findings: [{ severity: "MEDIUM", category: "TERMINATION" }],
  });

  await issueAuthToken(user.id, "EMAIL_VERIFICATION");
  await issueAuthToken(user.id, "PASSWORD_RESET");
  await recordAuditEvent(AUDIT_ACTIONS.LOGIN_SUCCEEDED, { userId: user.id, ip: "198.51.100.4" });

  return { user, contract, pasted };
}

const POPULATED = { users: 1, documents: 2, analyses: 2, findings: 3, authTokens: 2 };

/** Every key that appears anywhere in a nested response, at any depth. */
function everyKey(node, keys = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) everyKey(item, keys);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      keys.add(key);
      everyKey(value, keys);
    }
  }
  return keys;
}

describe("FR-4.5 — the data export", () => {
  it("returns account metadata, documents with their raw text, analyses and findings", async () => {
    const { user, contract } = await seedAccount("export-shape@example.test");

    const res = await request(testServer())
      .get("/api/v1/account/export")
      .set("Cookie", cookieFor(user));

    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: user.id, email: user.email, state: "ACTIVE" });
    expect(res.body.documents).toHaveLength(2);

    const exported = res.body.documents.find((doc) => doc.id === contract.id);
    // FR-4.5 says "including raw text", and this is the only serializer in
    // the system that returns it — FR-2.7 keeps it off every other route.
    expect(exported.rawText).toBe(
      "The Contractor shall deliver the designs within thirty days of the effective date.",
    );
    expect(exported.analyses).toHaveLength(1);
    expect(exported.analyses[0].findings).toHaveLength(2);
    // FR-4.2's ordering, kept by the same comparator the report uses.
    expect(exported.analyses[0].findings.map((f) => f.severity)).toEqual(["HIGH", "LOW"]);
    expect(exported.analyses[0].missingClauses).toEqual(["Late payment interest", "Kill fee"]);
  }, 30_000);

  it("excludes modelRisk at every depth, while the row it came from still has it", async () => {
    const { user, contract } = await seedAccount("export-drift@example.test");

    const res = await request(testServer())
      .get("/api/v1/account/export")
      .set("Cookie", cookieFor(user));

    const keys = everyKey(res.body);
    // Anti-vacuity: prove the walk actually reached the nested analyses,
    // or "modelRisk is absent" would pass over an empty export.
    expect(keys.has("rawText")).toBe(true);
    expect(keys.has("overallRisk")).toBe(true);
    expect(keys.has("modelRisk")).toBe(false);

    // And the field was DROPPED, not merely never written: the stored row
    // carries a modelRisk that disagrees with the risk the export shows.
    const stored = await prisma.analysis.findFirstOrThrow({ where: { documentId: contract.id } });
    expect(stored.modelRisk).toBe("HIGH");
    expect(stored.overallRisk).toBe("LOW");
    const exported = res.body.documents.find((doc) => doc.id === contract.id);
    expect(exported.analyses[0].overallRisk).toBe("LOW");
  }, 30_000);

  it("never contains the password hash", async () => {
    const { user } = await seedAccount("export-hash@example.test");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const res = await request(testServer())
      .get("/api/v1/account/export")
      .set("Cookie", cookieFor(user));

    expect(everyKey(res.body).has("passwordHash")).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(stored.passwordHash);
  }, 30_000);

  it("includes the caller's own audit rows, reduced to what they mean", async () => {
    const { user } = await seedAccount("export-audit@example.test");

    const res = await request(testServer())
      .get("/api/v1/account/export")
      .set("Cookie", cookieFor(user));

    expect(res.body.securityEvents).toEqual([
      { action: AUDIT_ACTIONS.LOGIN_SUCCEEDED, at: expect.any(String) },
    ]);
    // The HMACs are internal correlation keys, of no use to their subject.
    expect(everyKey(res.body).has("subjectHash")).toBe(false);
    expect(everyKey(res.body).has("ipHash")).toBe(false);
  }, 30_000);

  it("returns only the caller's data, never another account's", async () => {
    const { user } = await seedAccount("export-mine@example.test");
    const { contract: theirs } = await seedAccount("export-theirs@example.test");

    const res = await request(testServer())
      .get("/api/v1/account/export")
      .set("Cookie", cookieFor(user));

    const ids = res.body.documents.map((doc) => doc.id);
    expect(ids).not.toContain(theirs.id);
    expect(res.body.documents).toHaveLength(2);
    expect(res.body.securityEvents).toHaveLength(1);
  }, 30_000);

  it("requires authentication", async () => {
    const res = await request(testServer()).get("/api/v1/account/export");
    expect(res.status).toBe(401);
  }, 30_000);

  it("is limited to 3 per day per user, and the limit is per user not per IP", async () => {
    const { user } = await seedAccount("export-limit@example.test");
    const { user: other } = await seedAccount("export-limit-other@example.test");
    const get = (as) =>
      request(testServer()).get("/api/v1/account/export").set("Cookie", cookieFor(as));

    for (let i = 0; i < 3; i++) {
      expect((await get(user)).status, `export ${i + 1} of 3`).toBe(200);
    }

    const refused = await get(user);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("RATE_LIMITED");

    // Same address, different account: the fourth request above spent
    // that user's quota, not the address's.
    expect((await get(other)).status).toBe(200);
  }, 30_000);
});

describe("TR-12 / FR-4.6 — account deletion is hard, cascading and complete", () => {
  it("leaves no row in any table, counted directly rather than through the API", async () => {
    const { user } = await seedAccount("delete-complete@example.test");

    // Without this the assertion below is vacuous: zero rows after a
    // deletion proves nothing if there were zero rows before it.
    expect(await countRowsFor(user.id)).toEqual(POPULATED);
    expect(await countAllRows()).toEqual(POPULATED);

    const res = await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    expect(await countRowsFor(user.id)).toEqual(EMPTY);
    // And nothing was orphaned into a row no owner filter would find.
    expect(await countAllRows()).toEqual(EMPTY);
  }, 30_000);

  it("clears the session cookie", async () => {
    const { user } = await seedAccount("delete-cookie@example.test");

    const res = await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    const cleared = res.headers["set-cookie"]?.[0] ?? "";
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  }, 30_000);

  it("kills every outstanding session by absence of the row, with nothing incremented", async () => {
    const { user } = await seedAccount("delete-sessions@example.test");
    // A second browser, holding a cookie minted before the deletion.
    const elsewhere = cookieFor(user);

    await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    // FR-1.9's check reads the user row; there is no row, so the answer is
    // UNAUTHENTICATED rather than SESSION_REVOKED — which is the whole
    // reason FR-4.6 increments nothing.
    const me = await request(testServer()).get("/api/v1/auth/me").set("Cookie", elsewhere);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("UNAUTHENTICATED");
  }, 30_000);

  it("makes login fail afterwards", async () => {
    const { user } = await seedAccount("delete-login@example.test");

    await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    const login = await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: PASSWORD,
    });
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe("INVALID_CREDENTIALS");
  }, 30_000);

  it("records the deletion, and the record survives the account it is about", async () => {
    const { user } = await seedAccount("delete-audit@example.test");
    const hash = subjectHash(user.id);

    await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    const rows = await prisma.auditEvent.findMany({
      where: { subjectHash: hash },
      orderBy: { createdAt: "asc" },
    });
    // Both the row written before the deletion and the deletion's own row.
    expect(rows.map((row) => row.action)).toEqual([
      AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      AUDIT_ACTIONS.ACCOUNT_DELETED,
    ]);
    // Evidence that a deletion happened, holding nothing about who it was.
    expect(JSON.stringify(rows)).not.toContain(user.id);
    expect(JSON.stringify(rows)).not.toContain(user.email);
  }, 30_000);

  it("sends the confirmation email to an address whose account no longer exists", async () => {
    resetEmailForTests();
    sink().clear();
    const { user } = await seedAccount("delete-notice@example.test");

    await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: PASSWORD });

    await getEmailService().flush();
    const message = sink().latestTo(user.email);
    expect(message?.subject).toContain("deleted");
    // PRD §12.4's honesty requirement: backups age out, they are not
    // erased in the same instant.
    expect(message?.text).toContain("30 days");
  }, 30_000);

  it("deletes nothing when the password is wrong", async () => {
    const { user } = await seedAccount("delete-wrong-password@example.test");

    const res = await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({ password: "not-the-right-one" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await countRowsFor(user.id)).toEqual(POPULATED);
    expect(
      await prisma.auditEvent.count({ where: { action: AUDIT_ACTIONS.ACCOUNT_DELETED } }),
    ).toBe(0);
  }, 30_000);

  it("requires a password at all — an empty body is not a confirmation", async () => {
    const { user } = await seedAccount("delete-no-password@example.test");

    const res = await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(user))
      .send({});

    expect(res.status).toBe(400);
    expect(await countRowsFor(user.id)).toEqual(POPULATED);
  }, 30_000);

  it("requires authentication", async () => {
    const { user } = await seedAccount("delete-anon@example.test");

    const res = await json(request(testServer()).delete("/api/v1/account")).send({
      password: PASSWORD,
    });

    expect(res.status).toBe(401);
    expect(await countRowsFor(user.id)).toEqual(POPULATED);
  }, 30_000);

  it("destroys one account without touching another's rows", async () => {
    const { user: leaving } = await seedAccount("delete-leaving@example.test");
    const { user: staying } = await seedAccount("delete-staying@example.test");

    await json(request(testServer()).delete("/api/v1/account"))
      .set("Cookie", cookieFor(leaving))
      .send({ password: PASSWORD });

    expect(await countRowsFor(leaving.id)).toEqual(EMPTY);
    // The cascade follows foreign keys, not table names — a deletion that
    // reached for "every Finding" would take these with it.
    expect(await countRowsFor(staying.id)).toEqual(POPULATED);
    expect(await countAllRows()).toEqual(POPULATED);
  }, 30_000);
});

describe("D2 / PRD §8.1 — deleted means deleted, not flagged", () => {
  it("has no soft-delete column on User: the row is gone, not marked", async () => {
    // PRD §8.1: "Not a flag — the row is gone." A deletedAt column, or a
    // DELETED value in UserState, would satisfy every behavioural test
    // above while quietly converting a hard delete into a soft one — so
    // this reads the live database's own catalogue rather than the schema
    // file, which is the thing the application actually runs against.
    const columns = /** @type {{ column_name: string }[]} */ (
      await prisma.$queryRaw`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'User'
      `
    );
    const names = columns.map((row) => row.column_name.toLowerCase());
    for (const forbidden of ["deletedat", "deleted", "isdeleted", "archivedat", "softdeleted"]) {
      expect(names, `User has a soft-delete column: ${forbidden}`).not.toContain(forbidden);
    }

    const states = /** @type {{ value: string }[]} */ (
      await prisma.$queryRaw`
        SELECT unnest(enum_range(NULL::"UserState"))::text AS value
      `
    );
    expect(states.map((row) => row.value).sort()).toEqual([
      "ACTIVE",
      "LOCKED",
      "SUSPENDED",
      "UNVERIFIED",
    ]);
  }, 30_000);
});
