// The operator's command line: the actions docs/runbooks/ call for, run
// from a shell on the platform with the platform's environment
// (BUILD-PLAN step 69). There is no admin API, by design — see
// src/services/operator.js.
//
//   npm run ops -- <command> [flags]
//
//   spend-by-account                    this month's spend per account, top 10
//   suspend        --email E --reference R
//   lift-suspension --email E --reference R
//   export         --email E --reference R --out FILE
//   erase          --email E --reference R --confirm E
//   restore-deletions --since ISO --old-database-url-file FILE
//
// Exits 0 on success, 1 when the action was refused (bad flags, no such
// account), 2 on anything unexpected. Prints what it did, never a
// document's text: `export` writes the data to --out, not to the terminal,
// because terminal scrollback is not where a user's contracts should end up.

import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { AppError } from "../src/lib/AppError.js";
import prisma from "../src/lib/prisma.js";
import { flushEmails } from "../src/lib/email.js";
import { closeRedis } from "../src/lib/redis.js";
import {
  liftSuspension,
  operatorErase,
  operatorExport,
  restoredDeletions,
  spendByAccount,
  suspendAccount,
} from "../src/services/operator.js";

const USAGE = `usage: npm run ops -- <command> [flags]

  spend-by-account                      this month's spend per account, most expensive first
  suspend          --email E --reference R
  lift-suspension  --email E --reference R
  export           --email E --reference R --out FILE
  erase            --email E --reference R --confirm E
  restore-deletions --since ISO --old-database-url-file FILE
                                        after a restore: accounts deleted since the backup that came back

--reference is the ticket, thread or incident the action is for. It goes into the audit trail.`;

/**
 * Cents are too coarse for one analysis (a few tenths of a cent), and a
 * report reading $0.00 for an account that has been analysing all month
 * would point the operator away from it.
 *
 * @param {number} value
 */
const usd = (value) => `$${value.toFixed(value !== 0 && Math.abs(value) < 1 ? 4 : 2)}`;

/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, { out = (line) => console.log(line) } = {}) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      reference: { type: "string" },
      confirm: { type: "string" },
      out: { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      "old-database-url-file": { type: "string" },
    },
    strict: true,
  });

  /** @param {string} flag */
  const need = (flag) => {
    const value = /** @type {Record<string, string | undefined>} */ (values)[flag];
    if (!value) throw new AppError("VALIDATION_ERROR", { message: `--${flag} is required for ${command}.` });
    return value;
  };

  switch (command) {
    case "spend-by-account": {
      const report = await spendByAccount({ limit: values.limit ? Number(values.limit) : 10 });
      out(`period ${report.period}: ${report.accounts} account(s), ${usd(report.totalUsd)} recorded on analysis rows`);
      for (const row of report.top) {
        out(
          `  ${usd(row.usd).padStart(9)}  ${(row.shareOfTotal * 100).toFixed(1).padStart(5)}%  ` +
            `${String(row.analyses).padStart(4)} analyses (${row.failed} failed)  ` +
            `${row.email ?? "(deleted account)"}  ${row.state ?? ""}  ${row.userId}`,
        );
      }
      return 0;
    }
    case "suspend": {
      const result = await suspendAccount(need("email"), { reference: need("reference") });
      out(result.changed ? `suspended ${result.id}` : `${result.id} was already suspended; nothing changed`);
      return 0;
    }
    case "lift-suspension": {
      const result = await liftSuspension(need("email"), { reference: need("reference") });
      out(result.changed ? `lifted: ${result.id} is now ${result.state}` : `${result.id} is ${result.state}, not suspended; nothing changed`);
      return 0;
    }
    case "export": {
      const file = need("out");
      const data = await operatorExport(need("email"), { reference: need("reference") });
      // 0600: the file holds every contract the user uploaded.
      await writeFile(file, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      out(`wrote the export to ${file} (mode 600). Deliver it over an encrypted channel, then delete it.`);
      return 0;
    }
    case "erase": {
      const result = await operatorErase(need("email"), { reference: need("reference"), confirm: need("confirm") });
      out(`erased ${result.id}. A confirmation email is queued; backups age out within 30 days.`);
      return 0;
    }
    case "restore-deletions": {
      // The old database's URL is read from a file rather than taken as a
      // flag: a connection string with a password in it does not belong in
      // shell history or the process list.
      const url = (await readFile(need("old-database-url-file"), "utf8")).trim();
      const result = await restoredDeletions({ oldDatabaseUrl: url, since: new Date(need("since")) });
      out(`${result.deletedSince} account(s) deleted in the old database since ${values.since}; ${result.resurrected.length} came back with the restore.`);
      for (const user of result.resurrected) out(`  ${user.email}  ${user.id}`);
      if (result.resurrected.length > 0) {
        out("Erase each with: npm run ops -- erase --email <address> --reference <incident> --confirm <address>");
      }
      return 0;
    }
    default:
      out(USAGE);
      return command ? 1 : 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let code = 2;
  try {
    code = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof AppError) {
      console.error(err.message);
      code = 1;
    } else if (err instanceof TypeError && /** @type {{ code?: string }} */ (err).code?.startsWith("ERR_PARSE_ARGS")) {
      console.error(`${err.message}\n\n${USAGE}`);
      code = 1;
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
  } finally {
    await flushEmails().catch(() => {});
    await Promise.allSettled([prisma.$disconnect(), closeRedis()]);
  }
  process.exitCode = code;
}
