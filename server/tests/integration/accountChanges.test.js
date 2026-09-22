import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { getEmailService, resetEmailForTests } from "../../src/lib/email.js";
import { extractFirstLink } from "../../src/lib/email/sinkProvider.js";
import { issueAuthToken } from "../../src/services/authTokens.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createUser } from "./factories.js";

/**
 * FR-1.11, FR-1.13 and FR-1.9 — password change, sign out everywhere,
 * email change.
 *
 * All three turn on tokenVersion, and what separates them is exactly WHO
 * gets signed out. So every test here holds TWO sessions — the one doing
 * the work and one from another device — and asserts what happened to
 * each. Checking only the acting session would pass for all three
 * behaviours and distinguish none of them.
 */

const PASSWORD = "a-perfectly-fine-passphrase";
const NEW_PASSWORD = "an-entirely-different-one";

const sink = () =>
  /** @type {ReturnType<typeof import("../../src/lib/email/sinkProvider.js").createSinkProvider>} */ (
    /** @type {any} */ (getEmailService().provider)
  );

const json = (req) => req.set("Content-Type", "application/json");
const cookieFor = (user) =>
  `${SESSION_COOKIE_NAME}=${signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion })}`;
const me = (cookie) => request(testServer()).get("/api/v1/auth/me").set("Cookie", cookie);
const post = (path, cookie) => {
  const req = json(request(testServer()).post(`/api/v1/auth/${path}`));
  return cookie ? req.set("Cookie", cookie) : req;
};

/** A signed-in user plus a second session from "another device". */
async function userWithTwoSessions() {
  const user = await createUser({ password: PASSWORD });
  const here = cookieFor(user);
  const elsewhere = cookieFor(user);
  expect((await me(here)).status).toBe(200);
  expect((await me(elsewhere)).status).toBe(200);
  return { user, here, elsewhere };
}

/** The confirmation token from the message sent to an address. */
function tokenSentTo(address) {
  const link = extractFirstLink(sink().latestTo(address)?.text ?? "");
  return link ? new URL(link).searchParams.get("token") : null;
}

beforeEach(() => {
  resetEmailForTests();
  sink().clear();
});

describe("FR-1.11 — change password keeps THIS session and kills the others", () => {
  it("returns a fresh cookie, so the session that did the work survives", async () => {
    // The half that is easy to leave out. Without the new cookie the user
    // changes their password and is instantly 401 SESSION_REVOKED out of
    // the session that just succeeded, which reads as a failure.
    const { here, elsewhere } = await userWithTwoSessions();

    const res = await post("change-password", here).send({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);

    const refreshed = res.headers["set-cookie"]?.[0];
    expect(refreshed).toBeDefined();
    expect((await me(refreshed)).status).toBe(200);

    // The other device is signed out, which is the point of the bump.
    const other = await me(elsewhere);
    expect(other.status).toBe(401);
    expect(other.body.error.code).toBe("SESSION_REVOKED");
  }, 60_000);

  it("the OLD cookie stops working even though the request carried it", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-password", here).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect((await me(here)).status).toBe(401);
  }, 60_000);

  it("actually changes the password", async () => {
    const { user, here } = await userWithTwoSessions();
    await post("change-password", here).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect((await post("login").send({ email: user.email, password: NEW_PASSWORD })).status).toBe(200);
    expect((await post("login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
  }, 60_000);

  it("refuses a wrong current password, and changes nothing", async () => {
    const { user, here, elsewhere } = await userWithTwoSessions();

    const res = await post("change-password", here).send({
      currentPassword: "not-the-current-one",
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(400);
    // Not a 401: the session is valid and the caller is who they claim.
    // A 401 would invite a client to sign the user out over a typo.
    expect(res.status).not.toBe(401);
    expect((await me(elsewhere)).status).toBe(200);
    expect((await post("login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
  }, 60_000);

  it("refuses a breached new password — FR-1.2 applies wherever a password is set", async () => {
    const { here } = await userWithTwoSessions();

    const res = await post("change-password", here).send({
      currentPassword: PASSWORD,
      newPassword: "password123",
    });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/data breaches/i);
  }, 60_000);

  it("notifies the account by email, with no link to act on", async () => {
    const { user, here } = await userWithTwoSessions();
    await post("change-password", here).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    await getEmailService().flush();

    const notice = sink().latestTo(user.email);
    expect(notice?.subject).toMatch(/password was changed/i);
    expect(extractFirstLink(notice?.text ?? "")).toBeUndefined();
  }, 60_000);

  it("clears the lockout counters", async () => {
    const { user, here } = await userWithTwoSessions();
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 7, firstFailedLoginAt: new Date(), lockedUntil: new Date(Date.now() + 60_000) },
    });

    await post("change-password", here).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).toBe(0);
    expect(after.lockedUntil).toBeNull();
  }, 60_000);
});

describe("FR-1.9 — logout-all kills EVERY session, this one included", () => {
  it("signs out the other device and the one that pressed the button", async () => {
    const { here, elsewhere } = await userWithTwoSessions();

    const res = await post("logout-all", here).send({});
    expect(res.status).toBe(200);

    // Both, which is what separates this from change-password.
    expect((await me(here)).status).toBe(401);
    expect((await me(elsewhere)).status).toBe(401);
  }, 60_000);

  it("clears the cookie, so the browser is not left holding a dead one", async () => {
    const { here } = await userWithTwoSessions();
    const res = await post("logout-all", here).send({});

    const cleared = res.headers["set-cookie"]?.[0] ?? "";
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
  }, 60_000);

  it("asks for no password — someone who fears a compromise should not hunt for one", async () => {
    const { here } = await userWithTwoSessions();
    expect((await post("logout-all", here).send({})).status).toBe(200);
  }, 60_000);

  it("leaves the password working, so the user can sign back in", async () => {
    const { user, here } = await userWithTwoSessions();
    await post("logout-all", here).send({});

    expect((await post("login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
  }, 60_000);

  it("requires a session of its own", async () => {
    expect((await post("logout-all").send({})).status).toBe(401);
  }, 60_000);
});

describe("FR-1.13 — an email change takes effect only when the new address is verified", () => {
  const NEW_EMAIL = "moved-to@example.test";

  it("does NOT change the address on request — it is held as pending", async () => {
    const { user, here } = await userWithTwoSessions();

    const res = await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    expect(res.status).toBe(202);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    // Overwriting `email` here would move the account to an address the
    // user has not proven they can read — a typo would strand them.
    expect(after.email).toBe(user.email);
    expect(after.pendingEmail).toBe(NEW_EMAIL);
    expect(after.state).toBe("UNVERIFIED");
  }, 60_000);

  it("still signs in with the OLD address while the change is pending", async () => {
    const { user, here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });

    expect((await post("login").send({ email: user.email, password: PASSWORD })).status).toBe(200);
    expect((await post("login").send({ email: NEW_EMAIL, password: PASSWORD })).status).toBe(401);
  }, 60_000);

  it("notifies the OLD address, masking the new one", async () => {
    // Sent to the old address on purpose: the new one may be an
    // attacker's, and the person holding the old one is the only one who
    // can object.
    const { user, here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();

    const notice = sink().latestTo(user.email);
    expect(notice?.subject).toMatch(/email .* was changed/i);
    expect(notice?.text).toContain("m****@example.test");
    expect(notice?.text).not.toContain(NEW_EMAIL);
  }, 60_000);

  it("emails the NEW address a confirmation link that is not the signup welcome", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();

    const message = sink().latestTo(NEW_EMAIL);
    expect(message?.subject).toMatch(/confirm your new/i);
    // "Welcome to ClauseCheck" would read as nonsense to someone who has
    // had an account for months.
    expect(message?.text).not.toMatch(/welcome to/i);
    expect(tokenSentTo(NEW_EMAIL)).toEqual(expect.any(String));
  }, 60_000);

  it("completes the change only when the link is opened", async () => {
    const { user, here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();

    const res = await post("confirm-email-change").send({ token: tokenSentTo(NEW_EMAIL) });
    expect(res.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(NEW_EMAIL);
    expect(after.pendingEmail).toBeNull();
    expect(after.state).toBe("ACTIVE");
    expect(after.emailVerifiedAt).not.toBeNull();

    expect((await post("login").send({ email: NEW_EMAIL, password: PASSWORD })).status).toBe(200);
    expect((await post("login").send({ email: user.email, password: PASSWORD })).status).toBe(401);
  }, 60_000);

  it("the confirmation token is single-use", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();
    const token = tokenSentTo(NEW_EMAIL);

    expect((await post("confirm-email-change").send({ token })).status).toBe(200);
    expect((await post("confirm-email-change").send({ token })).status).toBe(400);
  }, 60_000);

  it("a signup verification token cannot confirm an address change", async () => {
    // The reason EMAIL_CHANGE is its own token type: one shared type
    // would let a link issued for one purpose finish the other.
    const { user, here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    const wrongType = await issueAuthToken(user.id, "EMAIL_VERIFICATION");

    expect((await post("confirm-email-change").send({ token: wrongType })).status).toBe(400);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe(user.email);
  }, 60_000);

  it("a change-email token cannot verify a signup", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();

    expect((await post("verify-email").send({ token: tokenSentTo(NEW_EMAIL) })).status).toBe(400);
  }, 60_000);

  it("asking again voids the first link, so two addresses cannot both claim the account", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();
    const firstToken = tokenSentTo(NEW_EMAIL);

    const second = "elsewhere@example.test";
    await post("change-email", here).send({ email: second, currentPassword: PASSWORD });
    await getEmailService().flush();

    expect((await post("confirm-email-change").send({ token: firstToken })).status).toBe(400);
    expect((await post("confirm-email-change").send({ token: tokenSentTo(second) })).status).toBe(200);
  }, 60_000);

  it("refuses a wrong current password, and records no pending address", async () => {
    const { user, here } = await userWithTwoSessions();

    const res = await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: "wrong" });

    expect(res.status).toBe(400);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).pendingEmail).toBeNull();
  }, 60_000);

  it("refuses an address that already belongs to someone", async () => {
    const { here } = await userWithTwoSessions();
    const other = await createUser({ password: PASSWORD });

    const res = await post("change-email", here).send({ email: other.email, currentPassword: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  }, 60_000);

  it("refuses a change to the address already in use by this account", async () => {
    const { user, here } = await userWithTwoSessions();
    const res = await post("change-email", here).send({ email: user.email, currentPassword: PASSWORD });
    expect(res.status).toBe(400);
  }, 60_000);

  it("loses the race gracefully when the address is claimed before confirmation", async () => {
    const { here } = await userWithTwoSessions();
    await post("change-email", here).send({ email: NEW_EMAIL, currentPassword: PASSWORD });
    await getEmailService().flush();
    const token = tokenSentTo(NEW_EMAIL);

    // Someone else registers it in the meantime. The unique index is the
    // authority; a pre-check here would only be a longer race.
    await createUser({ email: NEW_EMAIL, password: PASSWORD });

    const res = await post("confirm-email-change").send({ token });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  }, 60_000);
});
