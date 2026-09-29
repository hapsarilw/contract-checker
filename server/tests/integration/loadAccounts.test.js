import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import prisma from "../../src/lib/prisma.js";
import { createDocument, createUser } from "./factories.js";
import {
  createLoadAccounts,
  deleteLoadAccounts,
} from "../../src/services/loadAccounts.js";

/**
 * Step 73's load accounts (src/services/loadAccounts.js): the sessions they
 * come with work exactly like signed-in ones, nothing about them leaks past
 * their run, and none of it can happen in production.
 */

/** @param {string} cookie */
const listDocuments = (cookie) =>
  request(testServer()).get("/api/v1/documents").set("Cookie", cookie);

describe("load accounts", () => {
  it("creates verified accounts whose minted sessions are real sessions", async () => {
    const { accounts } = await createLoadAccounts({ run: "t1", count: 3 });
    expect(accounts).toHaveLength(3);
    for (const account of accounts) {
      expect(account.email).toMatch(/^load-t1-\d{4}@load\.invalid$/);
      expect((await listDocuments(account.cookie)).status).toBe(200);
    }
    const users = await prisma.user.findMany({
      where: { email: { startsWith: "load-t1-" } },
    });
    expect(users.every((u) => u.state === "ACTIVE" && u.emailVerifiedAt !== null)).toBe(
      true,
    );
  });

  it("cannot be signed into: the password was never kept", async () => {
    const { accounts } = await createLoadAccounts({ run: "t2", count: 1 });
    const res = await request(testServer())
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send({ email: accounts[0].email, password: "Password123!" });
    expect(res.status).toBe(401);
  });

  it("refuses a second batch for the same run", async () => {
    await createLoadAccounts({ run: "t3", count: 1 });
    await expect(createLoadAccounts({ run: "t3", count: 1 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("removes a run's accounts and everything they made, and nothing else", async () => {
    const { accounts } = await createLoadAccounts({ run: "t4", count: 2 });
    await createDocument({ userId: accounts[0].userId });
    // A neighbour whose address merely looks similar, and another run.
    const bystander = await createUser({ email: "load-t4-0001@example.test" });
    await createLoadAccounts({ run: "t40", count: 1 });

    expect(await deleteLoadAccounts({ run: "t4" })).toEqual({ removed: 2 });
    expect(
      await prisma.user.count({ where: { email: { startsWith: "load-t4-" } } }),
    ).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: bystander.id } })).not.toBeNull();
    expect(
      await prisma.user.count({ where: { email: { startsWith: "load-t40-" } } }),
    ).toBe(1);
    expect(await prisma.document.count({ where: { userId: accounts[0].userId } })).toBe(
      0,
    );
    // And the minted session died with its account.
    expect((await listDocuments(accounts[0].cookie)).status).toBe(401);
  });

  it("refuses a run id that could widen the prefix, and an unbounded count", async () => {
    for (const run of ["", "T1", "a%", "x".repeat(33)]) {
      await expect(createLoadAccounts({ run, count: 1 })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      await expect(deleteLoadAccounts({ run })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    for (const count of [0, 1001, 1.5]) {
      await expect(createLoadAccounts({ run: "t5", count })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
  });

  it("is refused in production, in both directions", async () => {
    await expect(
      createLoadAccounts({ run: "t6", count: 1, deployEnv: "production" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      deleteLoadAccounts({ run: "t6", deployEnv: "production" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(
      await prisma.user.count({ where: { email: { startsWith: "load-t6-" } } }),
    ).toBe(0);
  });
});
