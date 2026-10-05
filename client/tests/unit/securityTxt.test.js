import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NFR-2.13 / PRD §12.7: public/.well-known/security.txt (RFC 9116), which
 * the static host serves from the site root. This fails once it has
 * expired, on purpose: an expired security.txt tells a researcher the
 * contact may be dead, and the fix is a one-line renewal.
 */

const FILE = join(process.cwd(), "public", ".well-known", "security.txt");
const fields = () => {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const m = /^([A-Za-z-]+):\s*(.+)$/.exec(line.trim());
    if (m && !line.startsWith("#")) (out[m[1]] ??= []).push(m[2]);
  }
  return out;
};

describe("security.txt", () => {
  it("is where the static build will serve it", () => {
    expect(existsSync(FILE)).toBe(true);
  });

  it("has the two fields RFC 9116 requires, each once as the RFC says", () => {
    const f = fields();
    expect(f.Contact?.length).toBeGreaterThan(0);
    expect(f.Expires).toHaveLength(1);
  });

  it("names a contact that is an https URL or a mailto", () => {
    for (const contact of fields().Contact)
      expect(contact).toMatch(/^(https:\/\/|mailto:)/);
  });

  it("has not expired, and expires within about a year (RFC 9116 recommends under one)", () => {
    const expires = Date.parse(fields().Expires[0]);
    expect(Number.isNaN(expires)).toBe(false);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires - Date.now()).toBeLessThan(400 * 24 * 3600 * 1000);
  });

  it("points at a policy that exists in this repository and states the 72-hour target", () => {
    const policy = fields().Policy?.[0] ?? "";
    expect(policy).toMatch(/\/blob\/main\/SECURITY\.md$/);
    const text = readFileSync(join(process.cwd(), "..", "SECURITY.md"), "utf8");
    expect(text).toMatch(/within 72 hours/);
    expect(text).toMatch(/Safe harbour/);
  });
});
