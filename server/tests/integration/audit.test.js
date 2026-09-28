import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { AUDIT_ACTIONS, recordAuditEvent, subjectHash } from "../../src/lib/audit.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createUser } from "./factories.js";
import { resetEmailForTests } from "../../src/lib/email.js";
import { extractFirstLink } from "../../src/lib/email/sinkProvider.js";
import { getEmailService } from "../../src/lib/email.js";

/**
 * NFR-2.12 — the audit trail through the real routes and the real
 * database. The three properties that make this table useful: every real
 * event type writes exactly one row, no raw identifier ever appears in
 * it, and a deleted user's rows survive — proven with an actual DELETE,
 * not inferred from the schema.
 */

const PASSWORD = "a-perfectly-fine-passphrase";
const json = (req) => req.set("Content-Type", "application/json");
const cookieFor = (user) =>
  `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;

const sink = () =>
  /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
    /** @type {any} */ (getEmailService().provider)
  );

/** The most recent audit row for an action, for ANY subject. */
const latest = (action) =>
  prisma.auditEvent.findFirst({ where: { action }, orderBy: { createdAt: "desc" } });

/** Every column of every AuditEvent row, concatenated, to search for a leak. */
async function everyRowAsText() {
  const rows = await prisma.auditEvent.findMany();
  return JSON.stringify(rows);
}

describe("NFR-2.12 — every real event type writes a row with a hashed subject", () => {
  it("REGISTERED, on account creation", async () => {
    const email = "audit-register@example.test";
    const res = await json(request(testServer()).post("/api/v1/auth/register")).send({
      email,
      password: PASSWORD,
    });
    expect(res.status).toBe(201);

    const row = await latest(AUDIT_ACTIONS.REGISTERED);
    expect(row?.subjectHash).toBe(subjectHash(res.body.user.id));
  }, 30_000);

  it("LOGIN_SUCCEEDED", async () => {
    const user = await createUser({ password: PASSWORD });
    const res = await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);

    const row = await latest(AUDIT_ACTIONS.LOGIN_SUCCEEDED);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);

  it("LOGIN_FAILED, for a real account's wrong password", async () => {
    const user = await createUser({ password: PASSWORD });
    await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: "wrong",
    });

    const row = await latest(AUDIT_ACTIONS.LOGIN_FAILED);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);

  it("writes NO LOGIN_FAILED row for an unknown email — there is no account for it to be about", async () => {
    // recordAuditEvent requires a userId to hash; hashing an email instead
    // would also reopen the account-enumeration question FR-1.6 closes.
    await prisma.auditEvent.deleteMany({ where: { action: AUDIT_ACTIONS.LOGIN_FAILED } });
    await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: "no-such-account@example.test",
      password: "whatever",
    });
    expect(
      await prisma.auditEvent.count({ where: { action: AUDIT_ACTIONS.LOGIN_FAILED } }),
    ).toBe(0);
  }, 30_000);

  it("ACCOUNT_LOCKED, on the transition into lockout, not on every attempt after", async () => {
    const user = await createUser({ password: PASSWORD });
    for (let i = 0; i < 10; i++) {
      await json(request(testServer()).post("/api/v1/auth/login"))
        .set("X-Forwarded-For", `203.0.113.${i + 1}`)
        .send({ email: user.email, password: "wrong" });
    }
    expect(
      await prisma.auditEvent.count({ where: { action: AUDIT_ACTIONS.ACCOUNT_LOCKED } }),
    ).toBe(1);

    // One more attempt against the now-locked account must not write a
    // second ACCOUNT_LOCKED row — lockout is one event, not a repeat.
    await json(request(testServer()).post("/api/v1/auth/login"))
      .set("X-Forwarded-For", "203.0.113.99")
      .send({ email: user.email, password: "wrong" });
    expect(
      await prisma.auditEvent.count({ where: { action: AUDIT_ACTIONS.ACCOUNT_LOCKED } }),
    ).toBe(1);
  }, 30_000);

  it("PASSWORD_CHANGED", async () => {
    const user = await createUser({ password: PASSWORD });
    await json(request(testServer()).post("/api/v1/auth/change-password"))
      .set("Cookie", cookieFor(user))
      .send({ currentPassword: PASSWORD, newPassword: "a-different-one-now" });

    const row = await latest(AUDIT_ACTIONS.PASSWORD_CHANGED);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);

  it("PASSWORD_RESET", async () => {
    const { issueAuthToken } = await import("../../src/services/authTokens.js");
    const user = await createUser({ password: PASSWORD });
    const token = await issueAuthToken(user.id, "PASSWORD_RESET");

    await json(request(testServer()).post("/api/v1/auth/reset-password")).send({
      token,
      password: "brand-new-one-here",
    });

    const row = await latest(AUDIT_ACTIONS.PASSWORD_RESET);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);

  it("SIGNED_OUT_EVERYWHERE", async () => {
    const user = await createUser({ password: PASSWORD });
    await json(request(testServer()).post("/api/v1/auth/logout-all"))
      .set("Cookie", cookieFor(user))
      .send({});

    const row = await latest(AUDIT_ACTIONS.SIGNED_OUT_EVERYWHERE);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);

  it("EMAIL_CHANGED, at CONFIRMATION — not at the request that only sends a link", async () => {
    resetEmailForTests();
    sink().clear();
    const user = await createUser({ password: PASSWORD });
    const newEmail = "audit-new-address@example.test";

    await json(request(testServer()).post("/api/v1/auth/change-email"))
      .set("Cookie", cookieFor(user))
      .send({ email: newEmail, currentPassword: PASSWORD });
    // The request alone must not write the event: nothing has changed yet.
    expect(
      await prisma.auditEvent.count({ where: { action: AUDIT_ACTIONS.EMAIL_CHANGED } }),
    ).toBe(0);

    await getEmailService().flush();
    const link = extractFirstLink(sink().latestTo(newEmail)?.text ?? "");
    const token = link ? new URL(link).searchParams.get("token") : null;
    await json(request(testServer()).post("/api/v1/auth/confirm-email-change")).send({
      token,
    });

    const row = await latest(AUDIT_ACTIONS.EMAIL_CHANGED);
    expect(row?.subjectHash).toBe(subjectHash(user.id));
  }, 30_000);
});

describe("NFR-2.12 — no personal data anywhere in the table", () => {
  it("no row's subjectHash equals the raw userId", async () => {
    const user = await createUser({ password: PASSWORD });
    await json(request(testServer()).post("/api/v1/auth/login"))
      .set("X-Forwarded-For", "198.51.100.9")
      .send({
        email: user.email,
        password: PASSWORD,
      });

    const rows = await prisma.auditEvent.findMany();
    for (const row of rows) expect(row.subjectHash).not.toBe(user.id);
  }, 30_000);

  it("the user's email never appears in the table, in any column, for any row", async () => {
    const user = await createUser({
      password: PASSWORD,
      email: "very-distinctive-address@example.test",
    });
    await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: PASSWORD,
    });
    await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: "wrong",
    });

    expect(await everyRowAsText()).not.toContain(user.email);
  }, 30_000);

  it("no row's ipHash equals the raw client IP", async () => {
    const user = await createUser({ password: PASSWORD });
    const ip = "203.0.113.200";
    await json(request(testServer()).post("/api/v1/auth/login"))
      .set("X-Forwarded-For", ip)
      .send({
        email: user.email,
        password: PASSWORD,
      });

    const row = await latest(AUDIT_ACTIONS.LOGIN_SUCCEEDED);
    expect(row?.ipHash).not.toBe(ip);
    expect(await everyRowAsText()).not.toContain(ip);
  }, 30_000);

  it("the same subject hashes identically across two different events — rows correlate without an id", async () => {
    const user = await createUser({ password: PASSWORD });
    await json(request(testServer()).post("/api/v1/auth/login")).send({
      email: user.email,
      password: PASSWORD,
    });
    await json(request(testServer()).post("/api/v1/auth/logout-all"))
      .set("Cookie", cookieFor(user))
      .send({});

    const login = await prisma.auditEvent.findFirst({
      where: { action: AUDIT_ACTIONS.LOGIN_SUCCEEDED, subjectHash: subjectHash(user.id) },
    });
    const logout = await prisma.auditEvent.findFirst({
      where: {
        action: AUDIT_ACTIONS.SIGNED_OUT_EVERYWHERE,
        subjectHash: subjectHash(user.id),
      },
    });
    expect(login?.subjectHash).toBe(logout?.subjectHash);
  }, 30_000);
});

describe("NFR-2.12 / FR-4.6 — audit rows survive the user they are about being deleted", () => {
  it("a hard DELETE of the User row leaves that user's audit events intact", async () => {
    // This is what "no foreign key, no relation to User" is FOR: FR-4.6
    // needs the fact and timestamp of a deletion to survive the deletion
    // itself. A model with onDelete: Cascade — the pattern every other
    // model in this schema uses — would erase the evidence in the same
    // statement that creates it.
    const user = await createUser({ password: PASSWORD });
    await recordAuditEvent(AUDIT_ACTIONS.LOGIN_SUCCEEDED, {
      userId: user.id,
      ip: "198.51.100.1",
    });
    await recordAuditEvent(AUDIT_ACTIONS.PASSWORD_CHANGED, { userId: user.id });
    const hash = subjectHash(user.id);
    expect(await prisma.auditEvent.count({ where: { subjectHash: hash } })).toBe(2);

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();

    const survivors = await prisma.auditEvent.count({ where: { subjectHash: hash } });
    expect(survivors).toBe(2);
  }, 30_000);

  it("records the deletion itself as evidence it happened, correlatable to the rows that came before", async () => {
    // Step 57 wires ACCOUNT_DELETED into the real deletion route; this
    // proves the mechanism it will rely on: the same subjectHash keeps
    // working after the row it was computed from is gone, because the
    // hash never depended on the row existing.
    const user = await createUser({ password: PASSWORD });
    const hash = subjectHash(user.id);
    await recordAuditEvent(AUDIT_ACTIONS.LOGIN_SUCCEEDED, { userId: user.id });

    await prisma.user.delete({ where: { id: user.id } });
    await recordAuditEvent(AUDIT_ACTIONS.ACCOUNT_DELETED, { userId: user.id });

    const rows = await prisma.auditEvent.findMany({
      where: { subjectHash: hash },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual([
      AUDIT_ACTIONS.LOGIN_SUCCEEDED,
      AUDIT_ACTIONS.ACCOUNT_DELETED,
    ]);
  }, 30_000);
});
