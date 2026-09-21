import { createInflateRaw } from "node:zlib";
import { AppError } from "../lib/AppError.js";

/**
 * FR-2.9 — archive-bomb limits for DOCX, which is a ZIP archive.
 *
 * "Before extraction the system shall reject an archive whose declared
 *  uncompressed size exceeds 50 MB, whose expansion ratio exceeds 100:1,
 *  or which contains more than 500 entries... Extraction shall
 *  additionally abort if the accumulated output exceeds 50 MB, so a lying
 *  header does not defeat the check."
 *
 * TWO CHECKS, AND THE SECOND IS THE REAL ONE. The declared sizes live in
 * the archive's own directory, written by whoever built the file — a
 * hostile one simply lies. So the header check is a cheap first pass that
 * rejects the lazy bomb without decompressing a byte, and the actual
 * expansion is then MEASURED by inflating every entry against a byte
 * budget and discarding the output. Only the second check is load-bearing
 * against an attacker; the first exists so the common case costs nothing.
 *
 * WHY THE DIRECTORY IS PARSED BY HAND rather than with a ZIP library: the
 * whole point is to avoid handing hostile input to a parser. Reading
 * fixed-offset integers out of the central directory decompresses nothing
 * and allocates nothing beyond the numbers themselves, which is a
 * materially smaller attack surface than "load it into a ZIP reader and
 * ask how big it is".
 */

/** FR-2.9's three limits. */
export const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const MAX_EXPANSION_RATIO = 100;
export const MAX_ENTRIES = 500;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The largest an EOCD record can be: 22 fixed bytes plus a 64 KB comment. */
const MAX_EOCD_SEARCH = 22 + 0xffff;
/** ZIP64 sentinel values; see the note in readCentralDirectory. */
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const malformed = () => new AppError("MALFORMED_DOCUMENT");

/**
 * @typedef {{ compressedSize: number, uncompressedSize: number, method: number, localHeaderOffset: number }} ZipEntry
 */

/**
 * Locates the End of Central Directory record, which is at the end of the
 * file but at no fixed offset, because it carries a variable-length
 * comment. Scanned backwards for the signature.
 *
 * @param {Buffer} buffer
 */
function findEocd(buffer) {
  const from = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw malformed();
}

/**
 * Reads the central directory: one record per entry, each carrying the
 * sizes the archive CLAIMS.
 *
 * @param {Buffer} buffer
 * @returns {ZipEntry[]}
 */
export function readCentralDirectory(buffer) {
  if (buffer.length < 22) throw malformed();
  const eocd = findEocd(buffer);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);

  /**
   * ZIP64 uses sentinel values in these fields and puts the real numbers
   * in a separate record. A DOCX of a contract has no business being
   * ZIP64 — it means either 65,535+ entries or a 4 GB member, both of
   * which FR-2.9 rejects anyway — so rather than parse a second format
   * whose only appearance here would be an evasion attempt, this is a
   * refusal. The limit it enforces is the one that was going to be
   * enforced regardless.
   */
  if (entryCount === U16_MAX || directoryOffset === U32_MAX) throw malformed();
  if (entryCount > MAX_ENTRIES) {
    throw new AppError("MALFORMED_DOCUMENT", {
      details: { limit: "entries", entries: entryCount, max: MAX_ENTRIES },
    });
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let at = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    // +46 is the fixed part of a central directory record; anything that
    // reads past the buffer is a malformed archive, not a parse to retry.
    if (at + 46 > buffer.length) throw malformed();
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw malformed();

    const compressedSize = buffer.readUInt32LE(at + 20);
    const uncompressedSize = buffer.readUInt32LE(at + 24);
    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX) throw malformed();

    entries.push({
      method: buffer.readUInt16LE(at + 10),
      compressedSize,
      uncompressedSize,
      localHeaderOffset: buffer.readUInt32LE(at + 42),
    });

    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

/**
 * The cheap pass: FR-2.9's three limits against what the archive declares.
 *
 * @param {Buffer} buffer
 * @param {ZipEntry[]} entries
 */
export function assertDeclaredSizesWithinLimits(buffer, entries) {
  const declared = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);

  if (declared > MAX_UNCOMPRESSED_BYTES) {
    throw new AppError("MALFORMED_DOCUMENT", {
      details: { limit: "uncompressed", declared, max: MAX_UNCOMPRESSED_BYTES },
    });
  }

  // Ratio against the whole file, not the summed compressed sizes: the
  // file is what was actually uploaded, and it is the number the 100:1
  // limit is meaningful against.
  const ratio = declared / Math.max(buffer.length, 1);
  if (ratio > MAX_EXPANSION_RATIO) {
    throw new AppError("MALFORMED_DOCUMENT", {
      details: { limit: "ratio", ratio: Number(ratio.toFixed(1)), max: MAX_EXPANSION_RATIO },
    });
  }
}

/**
 * The real pass: inflate every entry and count the bytes that actually
 * come out, against a 50 MB budget, discarding the output as it goes.
 *
 * Streamed rather than inflated into a buffer, so a bomb is stopped at
 * the budget instead of after allocating what it asked for. zlib's own
 * `maxOutputLength` would also throw at a cap, but it allocates the
 * output it is building; counting chunks and destroying the stream holds
 * nothing.
 *
 * @param {Buffer} buffer
 * @param {ZipEntry[]} entries
 */
export async function assertActualExpansionWithinLimit(buffer, entries) {
  let budget = MAX_UNCOMPRESSED_BYTES;

  for (const entry of entries) {
    const data = localEntryData(buffer, entry);

    // Method 0 is stored, not deflated: the bytes are their own output,
    // so there is nothing to inflate and nothing that can expand.
    if (entry.method === 0) {
      budget -= data.length;
      if (budget < 0) throw expansionExceeded();
      continue;
    }

    budget -= await inflatedSize(data, budget);
    if (budget < 0) throw expansionExceeded();
  }
}

function expansionExceeded() {
  return new AppError("MALFORMED_DOCUMENT", {
    details: { limit: "actual-uncompressed", max: MAX_UNCOMPRESSED_BYTES },
  });
}

/**
 * The compressed bytes of one entry, found through its LOCAL header —
 * whose name and extra-field lengths can differ from the central
 * directory's, which is why the offset cannot be computed from the
 * directory record alone.
 *
 * @param {Buffer} buffer
 * @param {ZipEntry} entry
 */
function localEntryData(buffer, entry) {
  const at = entry.localHeaderOffset;
  if (at + 30 > buffer.length) throw malformed();
  if (buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw malformed();

  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > buffer.length) throw malformed();
  return buffer.subarray(start, end);
}

/**
 * Inflates `data`, counting output and stopping as soon as it passes
 * `budget`. Resolves with the byte count; rejects with MALFORMED_DOCUMENT
 * if the data is not valid deflate, which is itself a broken archive.
 *
 * @param {Buffer} data
 * @param {number} budget
 * @returns {Promise<number>}
 */
function inflatedSize(data, budget) {
  return new Promise((resolve, reject) => {
    const inflate = createInflateRaw();
    let produced = 0;

    inflate.on("data", (chunk) => {
      produced += chunk.length;
      if (produced > budget) {
        // Destroying mid-stream is the point: the remaining gigabytes of
        // a bomb are never produced, let alone held.
        inflate.destroy();
        reject(expansionExceeded());
      }
    });
    inflate.on("end", () => resolve(produced));
    inflate.on("error", () => reject(malformed()));

    inflate.end(data);
  });
}

/**
 * FR-2.9 end to end, to be called BEFORE any DOCX parser sees the buffer.
 *
 * @param {Buffer} buffer
 */
export async function assertArchiveWithinLimits(buffer) {
  const entries = readCentralDirectory(buffer);
  assertDeclaredSizesWithinLimits(buffer, entries);
  await assertActualExpansionWithinLimit(buffer, entries);
}
