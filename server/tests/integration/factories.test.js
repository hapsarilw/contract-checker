import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { createUser, createDocument, createAnalysis } from "./factories.js";
import prisma from "../../src/lib/prisma.js";

describe("integration test factories", () => {
  describe("createUser", () => {
    it("defaults to ACTIVE state with a usable bcrypt hash", async () => {
      const user = await createUser();
      expect(user.state).toBe("ACTIVE");
      expect(await bcrypt.compare("Password123!", user.passwordHash)).toBe(true);
    });

    it("accepts a state override for lifecycle-specific tests", async () => {
      const user = await createUser({ state: "UNVERIFIED" });
      expect(user.state).toBe("UNVERIFIED");
    });

    it("hashes a custom password when given one", async () => {
      const user = await createUser({ password: "different-password" });
      expect(await bcrypt.compare("different-password", user.passwordHash)).toBe(true);
      expect(await bcrypt.compare("Password123!", user.passwordHash)).toBe(false);
    });

    it("generates a unique email per call", async () => {
      const a = await createUser();
      const b = await createUser();
      expect(a.email).not.toBe(b.email);
    });
  });

  describe("createDocument", () => {
    it("auto-creates a user when none is given", async () => {
      const document = await createDocument();
      const owner = await prisma.user.findUnique({ where: { id: document.userId } });
      expect(owner).not.toBeNull();
    });

    it("attaches to a provided userId instead of creating a new user", async () => {
      const user = await createUser();
      const document = await createDocument({ userId: user.id });
      expect(document.userId).toBe(user.id);
    });
  });

  describe("createAnalysis", () => {
    it("defaults to COMPLETED with no findings", async () => {
      const analysis = await createAnalysis();
      expect(analysis.status).toBe("COMPLETED");
      expect(analysis.findings).toEqual([]);
    });

    it("creates nested findings with sensible defaults", async () => {
      const analysis = await createAnalysis({
        findings: [{ severity: "HIGH", clauseExcerpt: "Specific excerpt text." }],
      });
      expect(analysis.findings).toHaveLength(1);
      expect(analysis.findings[0].severity).toBe("HIGH");
      expect(analysis.findings[0].clauseExcerpt).toBe("Specific excerpt text.");
      expect(analysis.findings[0].category).toBe("OTHER");
    });

    it("allows overriding status to PENDING for FR-3.8-adjacent tests", async () => {
      const analysis = await createAnalysis({ status: "PENDING", completedAt: null });
      expect(analysis.status).toBe("PENDING");
    });
  });
});
