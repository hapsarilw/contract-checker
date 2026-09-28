import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BUILD-PLAN step 69: the runbooks in docs/runbooks/, checked for the things
 * that make a runbook usable at 3am and that rot silently when the code
 * moves under them. What a runbook SAYS is checked by the walkthroughs
 * recorded in each file; this checks that it can still be followed:
 *
 *   - every runbook SRS §12.3 names exists;
 *   - each opens with the symptom, not the cause (§12.3: "each opening
 *     with the symptom as an operator would see it");
 *   - each records a dated walkthrough, and says plainly whether it has been
 *     walked through in staging (§12.3: "a runbook that has never been
 *     followed is a draft");
 *   - every link between runbooks resolves;
 *   - every `npm run ops -- <command>` a runbook tells an operator to run is
 *     a command scripts/ops.js actually has. A renamed command would
 *     otherwise leave a runbook instructing someone, mid-incident, to run
 *     something that prints a usage message.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIR = join(ROOT, "docs", "runbooks");
const RUNBOOKS = readdirSync(DIR).filter(
  (name) => name.endsWith(".md") && name !== "README.md",
);
const read = (name) => readFileSync(join(DIR, name), "utf8");

/** SRS §12.3's numbered list: 1. `analysis-failure-rate-high` — … */
function specifiedRunbooks() {
  const srs = readFileSync(join(ROOT, "docs", "SRS.md"), "utf8");
  const section = srs.slice(
    srs.indexOf("### 12.3 Scheduled jobs and runbooks"),
    srs.indexOf("### 12.4"),
  );
  return [...section.matchAll(/^\d+\. `([a-z0-9-]+)`/gm)].map((m) => m[1]);
}

/** The commands scripts/ops.js's switch handles. */
function opsCommands() {
  const source = readFileSync(join(ROOT, "server", "scripts", "ops.js"), "utf8");
  return new Set([...source.matchAll(/^\s+case "([a-z-]+)":/gm)].map((m) => m[1]));
}

describe("SRS §12.3's runbooks all exist", () => {
  const specified = specifiedRunbooks();

  it("the specification names eight", () => {
    expect(specified).toHaveLength(8);
  });

  it.each(specified)("%s", (name) => {
    expect(existsSync(join(DIR, `${name}.md`))).toBe(true);
  });
});

describe.each(RUNBOOKS)("%s", (file) => {
  const text = read(file);
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

  it("is titled with its own name", () => {
    expect(text.split("\n")[0]).toBe(`# ${file.replace(/\.md$/, "")}`);
  });

  it("opens with the symptom as an operator would see it", () => {
    expect(headings[0]).toBe("What you are seeing");
  });

  it("records at least one dated walkthrough", () => {
    expect(headings).toContain("Walkthrough log");
    const log = text.slice(text.indexOf("## Walkthrough log"));
    expect(log).toMatch(/^\| \d{4}-\d{2}-\d{2} \|/m);
  });

  it("says plainly whether it has been walked through in staging", () => {
    // Not "has been" — that is not yet true of any of them — but that the
    // file does not let a reader assume it.
    expect(text).toMatch(/^\*\*Staging walkthrough: /m);
  });

  it("links only to runbooks that exist", () => {
    for (const [, target] of text.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)) {
      expect(existsSync(join(DIR, target)), `${file} links to ${target}`).toBe(true);
    }
  });

  it("tells the operator to run only operator commands that exist", () => {
    const commands = opsCommands();
    for (const [, command] of text.matchAll(/npm run ops -- ([a-z-]+)/g)) {
      expect(commands.has(command), `${file} names "npm run ops -- ${command}"`).toBe(
        true,
      );
    }
  });
});

describe("the index", () => {
  const index = read("README.md");

  it("lists every runbook, and every runbook it lists exists", () => {
    // Unique: the index links some runbooks twice (the table, and the list of
    // defects the walkthroughs found).
    const linked = [
      ...new Set([...index.matchAll(/\]\(([a-z0-9-]+\.md)\)/g)].map((m) => m[1])),
    ].sort();
    expect(linked).toEqual([...RUNBOOKS].sort());
  });
});

describe("secret-rotation keeps AUDIT_SALT apart from JWT_SECRET", () => {
  // The step's own requirement, checked on the text: rotating JWT_SECRET
  // signs everyone out and is acceptable; rotating AUDIT_SALT silently breaks
  // correlation across every historical audit row and must not be part of
  // any "rotate everything" response.
  const text = read("secret-rotation.md");
  const section = (heading) => {
    const start = text.indexOf(`### \`${heading}\``);
    expect(start, `no section for ${heading}`).toBeGreaterThan(-1);
    const next = text.indexOf("\n### ", start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it("JWT_SECRET: rotate freely, and it signs everyone out", () => {
    const jwt = section("JWT_SECRET");
    expect(jwt).toMatch(/rotate freely/i);
    expect(jwt).toMatch(/signs everyone out/i);
  });

  it("AUDIT_SALT: never part of an incident's rotation, and says what it would break", () => {
    const salt = section("AUDIT_SALT");
    expect(salt).toMatch(/do NOT rotate as part of an incident/);
    expect(salt).toMatch(/"rotate everything"/);
    expect(salt).toMatch(/can no longer be linked to anyone/);
  });

  it("AUDIT_SALT comes after JWT_SECRET, as the exception to it, not the rule", () => {
    expect(text.indexOf("### `AUDIT_SALT`")).toBeGreaterThan(
      text.indexOf("### `JWT_SECRET`"),
    );
  });
});
