import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import app from "../../src/app.js";
import prisma from "../../src/lib/prisma.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionFixture = join(__dirname, "fixtures", "version-server.js");

/** Boots the version-server fixture with the given extra env and returns its port. */
function startVersionServer(extraEnv) {
  const child = spawn(process.execPath, [versionFixture], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture never listened")), 10_000);
    const check = setInterval(() => {
      const match = stdout.match(/LISTENING:(\d+)/);
      if (match) {
        clearInterval(check);
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    }, 10);
  });

  return { child, listening };
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      })
      .on("error", reject);
  });
}

describe("ops routes — liveness, readiness, version (FR-4.7, FR-4.8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("GET /api/health", () => {
    it("returns 200 without touching the database", async () => {
      const querySpy = vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);

      const res = await request(app).get("/api/health");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
      // FR-4.7: a health probe that touches the database restarts every
      // healthy instance during a database blip — this is the assertion
      // that makes that a tested invariant, not just a comment.
      expect(querySpy).not.toHaveBeenCalled();
    });

    it("returns 200 even when the database is completely unreachable", async () => {
      vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));

      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
    });

    it("lives outside /api/v1", async () => {
      const res = await request(app).get("/api/v1/health");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/ready", () => {
    it("returns 200 with a per-dependency breakdown when Postgres is reachable", async () => {
      vi.spyOn(prisma, "$queryRaw").mockResolvedValue([{ "?column?": 1 }]);

      const res = await request(app).get("/api/ready");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: "ready",
        checks: {
          postgres: { ok: true },
          redis: { ok: true },
        },
      });
    });

    it("returns 503 with a per-dependency breakdown when Postgres is unreachable", async () => {
      vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connection refused"));

      const res = await request(app).get("/api/ready");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("not_ready");
      expect(res.body.checks.postgres.ok).toBe(false);
      expect(res.body.checks.postgres.error).toContain("connection refused");
      // Redis is stubbed until step 44 — it must not drag readiness down
      // for a dependency that isn't in the request path yet.
      expect(res.body.checks.redis).toEqual({ ok: true });
    });

    it("lives outside /api/v1", async () => {
      const res = await request(app).get("/api/v1/ready");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/version", () => {
    it("returns null for gitSha and buildTimestamp when unset (Phase 1)", async () => {
      const res = await request(app).get("/api/version");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ gitSha: null, buildTimestamp: null });
    });

    it("lives outside /api/v1", async () => {
      const res = await request(app).get("/api/v1/version");
      expect(res.status).toBe(404);
    });

    it("returns the actually configured GIT_SHA and BUILD_TIMESTAMP", async () => {
      const { child, listening } = startVersionServer({
        GIT_SHA: "abc1234",
        BUILD_TIMESTAMP: "2026-09-07T00:00:00Z",
      });

      try {
        const port = await listening;
        const res = await getJson(port, "/api/version");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
          gitSha: "abc1234",
          buildTimestamp: "2026-09-07T00:00:00Z",
        });
      } finally {
        child.kill();
      }
    }, 15_000);
  });
});
