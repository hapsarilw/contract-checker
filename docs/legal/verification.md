# Verification record: provider terms and statutory clocks

BUILD-PLAN step 74 / PRD §12.3: the published privacy commitments are statements about other parties' terms and about the law, so each is **verified against the source and recorded here**, with the date, the exact wording, and a SHA-256 of what was read, so a later reader can tell whether the source has since changed. **Re-verify at each annual review and whenever a provider's terms change** (PRD §12.3), and add a row; do not edit an old one.

This is an engineering record of what the sources say. It is not legal advice, and none of it replaces review by counsel before launch.

## Anthropic (the LLM provider)

| Verified | Source | Version read | What it says, verbatim | SHA-256 of the page read |
|---|---|---|---|---|
| 2026-10-05 | [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms), §B "Customer Content" | "Effective June 17, 2025" | **"Anthropic may not train models on Customer Content from Services."** "Customer Content" is defined in the same section as Inputs and Outputs together. | `107171b31e75e61a5ba54c72ceebfd621b11fae37686ddb0f13ef4e3131501fa` |
| 2026-10-05 | same, §C "Data Privacy" | same | "Data submitted through the Services will be processed in accordance with the Anthropic Data Processing Addendum ("DPA"), which is incorporated into these Terms by reference." | same |
| 2026-10-05 | same, preamble | same | "Anthropic" means **Anthropic Ireland, Limited** if Customer resides in the EEA, Switzerland or UK, and **Anthropic, PBC** if Customer resides anywhere else. The operator's own residence (still `[OPERATOR]`) decides which. | same |
| 2026-10-05 | [How long do you store my organization's data?](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-personal-data) | as served on the date | "For Anthropic API users, we automatically delete inputs and outputs on our backend within **30 days** of receipt or generation, except: When you use a service with longer retention under your control (e.g. Files API); When you and we have agreed otherwise (e.g. zero data retention agreement); If we need to retain them for longer to enforce our Usage Policy (UP); In compliance with the law". Flagged usage-policy violations: inputs and outputs "for up to 2 years". | `47ffc6087efea0c339634a6a1658651cb960fd5e9f0ccbb523c1301545791f5a` |
| 2026-10-05 | [Data residency](https://platform.claude.com/docs/en/docs/build-with-claude/data-residency) | as served on the date | `inference_geo` `"global"`: **"Default. Inference may run in any available geography for optimal performance and availability."** `"us"`: "Inference runs only in US-based infrastructure" (priced at 1.1x). Data at rest is governed separately, by the workspace geography set in the Console. ClauseCheck sends no `inference_geo`, so it runs on `global`. | `b36a15979bdbea9a9c787fcb59c48d91e38923528aa92123bb01f83c0c373940` |

**What follows for ClauseCheck:**
- The no-training commitment is **verified**, and the privacy policy states it, citing this record.
- The DPA needs no separate signature: it is part of the Commercial Terms. Whoever holds the API account accepts it with them.
- **Provider-side retention is 30 days**, with the exceptions quoted above, and the privacy policy says so.
- PRD §12.3 asks for that window to be reduced "if it can be ... contractually ... before launch". The mechanism exists (a zero data retention agreement), but **it is an agreement with Anthropic that the owner has to request**. It is not a setting. **Owed by the owner.**
- Processing location: "any available geography" today. US-only inference is available at 1.1x price. **Which to use is the owner's decision**; the subprocessor list states the current one.

## Statutory clocks (declared jurisdictions: Indonesia's UU PDP, the EU GDPR, the UK GDPR)

Declared by the owner on 2026-10-05: all three apply. Where they differ, **the strictest clock is the one ClauseCheck commits to.**

| Obligation | UU PDP (Law No. 27 of 2022) | GDPR / UK GDPR | ClauseCheck commits to |
|---|---|---|---|
| Access to personal data | **Art. 32(2): "paling lambat 3 x 24 (tiga kali dua puluh empat) jam"** from receipt of the request | Art. 12(3): without undue delay, at most one month (extendable by two) | **72 hours** |
| Correction / update | Art. 30(1): 3 x 24 hours | Art. 12(3): one month | **72 hours** |
| Stop processing on withdrawal of consent | Art. 40(2): 3 x 24 hours | Art. 12(3): one month | **72 hours** |
| Restrict / suspend processing | Art. 41(1): 3 x 24 hours | Art. 12(3): one month | **72 hours** |
| Erasure / destruction | Art. 43(2), 44(2): "sesuai dengan ketentuan peraturan perundang-undangan" (no clock in the Law itself); Art. 45: the subject must be told | Art. 12(3): one month | **immediate** self-serve; **72 hours** by email, with the subject told (Art. 45) |
| **Personal-data breach notification** | **Art. 46(1): written notice "paling lambat 3 x 24 ... jam" to the data subject AND to the authority ("lembaga")** | Art. 33: the supervisory authority within 72 hours; Art. 34: the subjects without undue delay where the risk is high | **72 hours, to users and to the authority** |
| Lawful bases relied on | Art. 20(2)(b) performance of a contract; (c) legal obligation; (f) legitimate interest | Art. 6(1)(b), (c), (f) | as stated in the privacy policy |

The UU PDP wording was read from the Law's text as published by Hukumonline ([PDF](https://learning.hukumonline.com/wp-content/uploads/2023/07/Undang-Undang-No.27-Tahun-2022-Hukumonline.pdf), 38 pages, SHA-256 `43daa7fd56e3c1de09bd9cdb9b44749539c11de062cc0938df2970f7087e38e4`), not from a summary. The GDPR articles are cited from the Regulation's well-known text and were not re-fetched in this pass. **Counsel should confirm all of this**, and two further questions:

- **Cross-border transfer** (UU PDP Art. 56; GDPR Chapter V). Documents go to Anthropic, and inference may run in any geography. What safeguards the DPA provides, and whether they satisfy both regimes, is a legal question this record does not answer.
- **The language of the terms.** Indonesian Law No. 24 of 2009 requires Bahasa Indonesia in agreements involving Indonesian parties. Whether the terms of service need an Indonesian version is for counsel. Only English exists today.

## Log

| Date | By | What |
|---|---|---|
| 2026-10-05 | step 74 | First verification: all rows above |
