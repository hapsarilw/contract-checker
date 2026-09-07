import prisma from "./prisma.js";
import { AppError } from "./AppError.js";

/**
 * FR-1.5 — loads a document only if it belongs to this user, and throws
 * 404 NOT_FOUND otherwise.
 *
 * **404, never 403.** This is the whole point of the helper existing
 * rather than each route writing its own check. A 403 says "this exists,
 * but it isn't yours", which hands an attacker a working oracle for
 * enumerating document ids: 404 means no such document, 403 means one
 * they could keep probing. Answering 404 to both makes "someone else's
 * document" and "no such document" the same observable event.
 *
 * That indistinguishability is why the missing-document and
 * wrong-owner cases are one branch here and not two — there is no place
 * for a future edit to accidentally differentiate them.
 *
 * Every document route uses this instead of a bare findUnique. A route
 * that loads a document any other way has skipped the control.
 */
export async function loadOwnedDocument(documentId, userId) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, userId },
  });

  if (!document) {
    throw new AppError("NOT_FOUND");
  }

  return document;
}
