# dsar-request

**Not an alert.** Reached when someone asks to see, take away, or erase the data ClauseCheck holds about them (a data subject request, SRS §12.4).

## What you are seeing

An email, a support message, or a letter, saying something like "send me all the data you hold on me", "delete my account and everything in it", or "I can't log in to delete my account". It may cite a law (GDPR Articles 15, 17 or 20; CCPA). It may come from the person, or from someone claiming to act for them.

**The clock starts when it arrives.** Write down the received date now. The statutory window depends on the jurisdiction PRD §12.1 declares (one month under GDPR, extendable once; 45 days under CCPA).

## Step 1: verify identity — never skip this

An attacker asking you to export or delete someone else's account is the obvious abuse of this process, and the one that does the most damage.

1. The request must come **from the account's registered address**. A request from any other address gets a reply asking them to write from it.
2. Send a **challenge to the registered address** — a one-off phrase they must send back — and wait for it. A request that arrives from the right address can still be a spoofed sender.
3. Record both in the ticket. If identity cannot be verified, do nothing and say why.

## Step 2: access and portability

**Point them at the self-serve export first.** Settings → "Download my data" gives them every document with its full text, every report and finding, their account details and their security history, as one JSON file (FR-4.5, three times a day).

**Only if they cannot use it** — locked out, no device, an assisted request — run the same export yourself:

```bash
cd server && npm run ops -- export --email <address> --reference <ticket id> --out /tmp/<ticket>.json
```

It writes the same export the self-serve route produces, as a file only you can read (mode 600). It prints nothing of the document text. It records `OPERATOR_EXPORTED` in the audit trail with your reference.

Deliver it **over an encrypted channel** — an encrypted archive with the password sent separately, or the email provider's confidential mode — never as a plain attachment. Then **delete the file** from wherever you ran it.

## Step 3: erasure

**Point them at the self-serve deletion first.** Settings → "Delete my account" asks for their password and deletes everything in one transaction (FR-4.6).

**Only if they cannot use it**, erase it yourself through **the same code path** — never with SQL written by hand, which is where a forgotten child table becomes an incomplete deletion:

```bash
cd server && npm run ops -- erase --email <address> --reference <ticket id> --confirm <address>
```

`--confirm` must repeat the address exactly, or nothing is deleted. The erasure removes the account and, by cascade, every document, analysis, finding and outstanding token. It records `ACCOUNT_DELETED` in the audit trail with `dsar:<reference>`, and queues the same confirmation email self-serve deletion sends.

## Step 4: reply and record

Reply to the registered address, stating:

- what was **provided** (for access) or **deleted** (for erasure), specifically;
- that **backups age out within 30 days** — the one place deleted data persists, and the privacy policy says so rather than claiming instant erasure everywhere (PRD §12.4);
- that a record that the request was fulfilled is kept, with nothing in it that identifies them.

Record the received date, the verification, the action, the completion date, and your reference, in the ticket.

**If a database restore happens within 30 days of an erasure**, that account comes back with the restore. [database-restore](database-restore.md) covers re-running those erasures.

---

## Walkthrough log

| Date | Where | What was exercised | Result |
|---|---|---|---|
| 2026-09-28 | isolated local rehearsal stack (not staging) | A signed-up, verified account with a checked document; `ops -- export` to a file; `ops -- erase` with a mistyped `--confirm`, then the correct one; the database, the audit trail and the mail sink afterwards. | The export file was mode 600 and carried the account, the document and its security events; nothing of the document reached the terminal. The mistyped confirmation exited 1 and deleted nothing. The erasure left no user row; the audit trail held `OPERATOR_EXPORTED` and `ACCOUNT_DELETED`, both with `dsar:<reference>`; the "Your ClauseCheck account has been deleted" email went to the address and mentioned the 30-day backup window. **Found before the walkthrough:** there was no operator path for erasure at all — account deletion required the user's password — so §12.4's "use the same code path" could not be followed. The erasure was extracted into one function both paths now share. |

**Staging walkthrough: not yet done** — there is no staging environment (BUILD-PLAN step 71). Steps 1 and 4 need a real mailbox and a jurisdiction (PRD §12.1, an owner decision still open).
