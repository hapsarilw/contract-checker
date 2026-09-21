import { describe, it, expect } from "vitest";
import request from "supertest";
import { testServer } from "./testServer.js";
import config from "../../src/config.js";
import prisma from "../../src/lib/prisma.js";
import { SESSION_COOKIE_NAME, signSessionToken } from "../../src/services/auth.js";
import { createDocumentWithinQuota } from "../../src/services/storageQuota.js";
import { createDocument, createUser } from "./factories.js";

/**
 * FR-2.13 — 100 documents OR 50 MB of stored text, whichever comes first.
 *
 * Existing usage is seeded straight into the table rather than built by
 * uploading: reaching 49 MB by upload would mean thousands of requests,
 * and the quota reads Document.byteSize, so the column is the honest
 * thing to set.
 */

const MB = 1024 * 1024;
const TEXT = Array.from({ length: 300 }, (_unused, i) => `clause${i}`).join(" ");

async function signedIn() {
  const user = await createUser();
  const token = signSessionToken({ userId: user.id, tokenVersion: user.tokenVersion });
  return { user, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** Seeds `count` documents for a user with the given byte size each. */
async function seed(userId, count, byteSize = 1_000) {
  await prisma.document.createMany({
    data: Array.from({ length: count }, (_unused, i) => ({
      userId,
      sourceType: "PASTE",
      rawText: `seed ${i}`,
      wordCount: 300,
      textSha256: `seed-${userId}-${i}`,
      byteSize,
    })),
  });
}

const paste = (cookie, text = TEXT) =>
  request(testServer())
    .post("/api/v1/documents")
    .set("Cookie", cookie)
    .set("Content-Type", "application/json")
    .send({ text });

describe("FR-2.13 — the document-count limit", () => {
  it("accepts the 100th document", async () => {
    const { user, cookie } = await signedIn();
    await seed(user.id, config.MAX_DOCS_PER_USER - 1);

    expect((await paste(cookie)).status).toBe(201);
  }, 60_000);

  it("rejects the 101st with 422 STORAGE_QUOTA_EXCEEDED", async () => {
    const { user, cookie } = await signedIn();
    await seed(user.id, config.MAX_DOCS_PER_USER);

    const res = await paste(cookie);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(config.MAX_DOCS_PER_USER);
  }, 60_000);
});

describe("FR-2.13 — the byte limit", () => {
  it("rejects when existing bytes plus the incoming document pass the cap", async () => {
    const { user, cookie } = await signedIn();
    // Leaves less room than the pasted document needs, without needing a
    // multi-megabyte request body.
    const incoming = Buffer.byteLength(TEXT, "utf8");
    await seed(user.id, 1, config.MAX_BYTES_PER_USER - incoming + 1);

    const res = await paste(cookie);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("STORAGE_QUOTA_EXCEEDED");
  }, 60_000);

  it("accepts a document that lands exactly on the cap — the limit is inclusive", async () => {
    const { user, cookie } = await signedIn();
    const incoming = Buffer.byteLength(TEXT, "utf8");
    await seed(user.id, 1, config.MAX_BYTES_PER_USER - incoming);

    expect((await paste(cookie)).status).toBe(201);
  }, 60_000);

  it("counts the NORMALISED text's bytes, which is what is stored", async () => {
    // byteSize comes from intake, after normalisation strips characters
    // and collapses whitespace. Padding the request with whitespace must
    // not cost the user quota they did not use. Read back from the row,
    // not from the response, since the row is what the quota sums.
    const { user, cookie } = await signedIn();
    const padded = `${TEXT}${"   \n\n   ".repeat(2_000)}`;

    const res = await paste(cookie, padded);
    expect(res.status).toBe(201);

    const stored = await prisma.document.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored.byteSize).toBe(Buffer.byteLength(stored.rawText, "utf8"));
    expect(stored.byteSize).toBeLessThan(Buffer.byteLength(padded, "utf8") / 2);
  }, 60_000);
});

describe("FR-2.13 — the message and the remedy", () => {
  it("names deletion as the way out", async () => {
    const { user, cookie } = await signedIn();
    await seed(user.id, config.MAX_DOCS_PER_USER);

    const res = await paste(cookie);

    expect(res.body.error.message).toMatch(/delete/i);
  }, 60_000);

  it("states the limits from config, so it cannot go stale when they change", async () => {
    const { user, cookie } = await signedIn();
    await seed(user.id, config.MAX_DOCS_PER_USER);

    const res = await paste(cookie);

    expect(res.body.error.message).toContain(String(config.MAX_DOCS_PER_USER));
    expect(res.body.error.message).toContain(`${Math.round(config.MAX_BYTES_PER_USER / MB)} MB`);
  }, 60_000);

  it("frees the quota when a document is deleted", async () => {
    const { user, cookie } = await signedIn();
    const first = await createDocument({ userId: user.id, rawText: TEXT, wordCount: 300 });
    await seed(user.id, config.MAX_DOCS_PER_USER - 1);
    expect((await paste(cookie)).status).toBe(422);

    const deleted = await request(testServer())
      .delete(`/api/v1/documents/${first.id}`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/json");
    expect(deleted.status).toBe(200);

    expect((await paste(cookie)).status).toBe(201);
  }, 60_000);
});

describe("FR-2.13 — scoping and atomicity", () => {
  it("counts each user separately: one user's usage is not another's", async () => {
    const full = await signedIn();
    const other = await signedIn();
    await seed(full.user.id, config.MAX_DOCS_PER_USER);

    expect((await paste(full.cookie)).status).toBe(422);
    expect((await paste(other.cookie)).status).toBe(201);
  }, 60_000);

  it("takes a per-user advisory lock, so one user's writers queue behind each other", async () => {
    // Deterministic, unlike a race: another transaction holds the very
    // lock the service is meant to take, and the service must WAIT. If
    // the lock is removed the call completes immediately and this fails.
    // It is the only test here that does, which is why it exists — see
    // the note on the concurrency test below.
    const { user } = await signedIn();
    const other = await signedIn();
    const doc = (label) => ({
      sourceType: /** @type {const} */ ("PASTE"),
      rawText: label,
      wordCount: 300,
      textSha256: `${label}-${user.id}`,
      byteSize: 100,
    });

    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    /** @type {() => void} */
    let locked = () => {};
    const isLocked = new Promise((resolve) => (locked = () => resolve(undefined)));

    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${user.id}))`;
      locked();
      await held;
    });
    await isLocked;

    let finished = false;
    const attempt = createDocumentWithinQuota(user.id, doc("queued")).then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(finished).toBe(false);

    // Keyed per user: someone else is not held up by this user's lock.
    await expect(createDocumentWithinQuota(other.user.id, { ...doc("other"), textSha256: `o-${other.user.id}` })).resolves.toBeDefined();

    release();
    await holder;
    await attempt;
    expect(finished).toBe(true);
  }, 30_000);

  it("holds under concurrency: many writers at document 99 leave the user at exactly 100", async () => {
    // What this can and cannot show, stated plainly. The race the lock
    // exists for is real, but its window is a few milliseconds: a single
    // transaction finishes read-then-insert before its neighbours have
    // read, so even with the lock DELETED this test still sees exactly one
    // winner — measured, three runs, `fulfilled=1 total=100` each time. It
    // therefore checks the OUTCOME (never more than the cap), and cannot
    // by itself catch the lock being removed. The mechanism is proven
    // deterministically by the test above, which holds the lock from the
    // outside and asserts the service waits.
    const { user } = await signedIn();
    await seed(user.id, config.MAX_DOCS_PER_USER - 1);

    const attempts = await Promise.allSettled(
      Array.from({ length: 30 }, (_unused, i) =>
        createDocumentWithinQuota(user.id, {
          sourceType: "PASTE",
          rawText: `racer ${i}`,
          wordCount: 300,
          textSha256: `racer-${user.id}-${i}`,
          byteSize: 100,
        }),
      ),
    );

    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const refused = attempts.filter((a) => a.status === "rejected");
    expect(refused).toHaveLength(29);
    expect(refused.every((a) => /** @type {any} */ (a).reason?.code === "STORAGE_QUOTA_EXCEEDED")).toBe(true);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(config.MAX_DOCS_PER_USER);
  }, 90_000);
});
