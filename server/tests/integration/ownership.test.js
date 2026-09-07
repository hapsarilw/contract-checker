import { describe, it, expect } from "vitest";
import { loadOwnedDocument } from "../../src/lib/ownership.js";
import { AppError } from "../../src/lib/AppError.js";
import { createUser, createDocument } from "./factories.js";
import { randomUUID } from "node:crypto";

/**
 * TR-4 (SRS §10.1) at the level of the control itself.
 *
 * The route-level half of TR-4 — that GET, analyze and DELETE each
 * return 404 for another user's document — attaches when those routes
 * exist: GET and DELETE at step 18, analyze at step 25. This file proves
 * the mechanism every one of them will use; those steps must assert it
 * through their own routes rather than assuming this covers them, since
 * a route that forgets to CALL this helper is exactly the failure it
 * cannot catch.
 */
describe("loadOwnedDocument (FR-1.5, TR-4)", () => {
  it("returns the document to its owner", async () => {
    const owner = await createUser();
    const document = await createDocument({ userId: owner.id });

    const loaded = await loadOwnedDocument(document.id, owner.id);
    expect(loaded.id).toBe(document.id);
  });

  it("throws 404 NOT_FOUND when the document belongs to someone else", async () => {
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const documentOfB = await createDocument({ userId: userB.id });

    const err = await loadOwnedDocument(documentOfB.id, userA.id).catch((e) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.status).toBe(404);
  });

  it("never returns 403 for a cross-user access — a 403 would confirm the document exists", async () => {
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const documentOfB = await createDocument({ userId: userB.id });

    const err = await loadOwnedDocument(documentOfB.id, userA.id).catch((e) => e);

    expect(err.status).not.toBe(403);
    expect(err.code).not.toBe("ACCOUNT_SUSPENDED");
  });

  it("answers a wrong-owner request and a nonexistent-id request identically", async () => {
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const documentOfB = await createDocument({ userId: userB.id });

    const wrongOwner = await loadOwnedDocument(documentOfB.id, userA.id).catch((e) => e);
    const noSuchDocument = await loadOwnedDocument(randomUUID(), userA.id).catch((e) => e);

    // Indistinguishable on purpose: telling the two apart turns document
    // ids into an enumerable namespace.
    expect(wrongOwner.code).toBe(noSuchDocument.code);
    expect(wrongOwner.status).toBe(noSuchDocument.status);
    expect(wrongOwner.message).toBe(noSuchDocument.message);
  });

  it("scopes the query itself, rather than loading then comparing", async () => {
    // A findUnique-then-compare implementation has a window where the
    // wrong document is in a local variable; a scoped query never holds
    // it at all. Asserting the observable half: the owner of a DIFFERENT
    // document cannot reach this one even by id.
    const [userA, userB] = await Promise.all([createUser(), createUser()]);
    const [docA, docB] = await Promise.all([
      createDocument({ userId: userA.id }),
      createDocument({ userId: userB.id }),
    ]);

    await expect(loadOwnedDocument(docB.id, userA.id)).rejects.toThrow();
    await expect(loadOwnedDocument(docA.id, userB.id)).rejects.toThrow();
    expect((await loadOwnedDocument(docA.id, userA.id)).id).toBe(docA.id);
    expect((await loadOwnedDocument(docB.id, userB.id)).id).toBe(docB.id);
  });
});
