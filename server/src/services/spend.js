import config from "../config.js";
import { AppError } from "../lib/AppError.js";
import prisma from "../lib/prisma.js";
import { getRedis } from "../lib/redis.js";
import logger from "../observability/logger.js";
import { periodOf, periodStartOf } from "./quota.js";

/**
 * Platform LLM spend metering, the ceiling, and the kill switch
 * (FR-5.3, FR-5.4, PRD §10.2, decision D13).
 *
 * WHAT IS STORED IS TOKENS, NOT DOLLARS, and that is the decision this
 * module turns on. A running dollar total would freeze each analysis at
 * the price in force when it ran, so correcting a mis-configured price —
 * exactly the mistake BUILD-PLAN D-F warns about, where ANTHROPIC_MODEL
 * changes and the prices do not — could never be repaired: the month
 * would stay wrong for ever. Tokens are the physical quantity. Price is
 * applied at read time, so fixing the price fixes the whole month.
 *
 * ITS LIMIT, STATED RATHER THAN DISCOVERED LATER: config carries ONE
 * price pair, so a month spanning a model change prices both models at
 * the current one. The Analysis rows carry `model` per row and can be
 * re-priced exactly; this estimate cannot. FR-5.3 asks for an estimate
 * and this is honestly one. A model change mid-month is also gated by the
 * benchmark (FR-3.14), which is the moment to re-set the prices.
 *
 * WHAT HAPPENS AT THE CEILING is PRD D13, and a blanket 503 middleware
 * gets it exactly backwards: existing reports, history, login and
 * deletion must all keep working. This is a bounded degradation of ONE
 * feature, not a maintenance mode — which is why the refusal lives in the
 * analyze path (sequence step 2) rather than in middleware, and why
 * SPEND_LIMIT_REACHED is its own error code rather than a generic 503.
 */

/** FR-5.4: warn at 50% and 80%, refuse at 100%. */
const ALERT_THRESHOLDS = Object.freeze([0.5, 0.8, 1.0]);

const tokensKey = (period) => `spend:tokens:${period}`;
const alertKey = (period, threshold) => `spend:alerted:${period}:${threshold}`;

/** USD for a token count at the configured price. */
function usdFor(inputTokens, outputTokens) {
  return (
    (inputTokens / 1e6) * config.LLM_PRICE_INPUT_PER_MTOK +
    (outputTokens / 1e6) * config.LLM_PRICE_OUTPUT_PER_MTOK
  );
}

/**
 * The platform spend estimate for the current calendar month, and the
 * `llm_spend_usd_month` gauge of §6.6.
 *
 * Redis answers because this sits on the analyze path. The database is
 * the fallback and the truth: Analysis rows record the real token counts
 * per analysis (FR-3.5), so a flushed Redis costs accuracy until the next
 * read, not the month's history.
 *
 * As with quota, an unavailable figure reads as `null`, never as 0. A
 * spend gauge that reported zero during a Redis outage would read as
 * "nothing spent" at exactly the moment an operator is deciding whether
 * to intervene.
 *
 * @param {Date} [now]
 */
export async function getSpendState(now = new Date()) {
  const ceiling = config.MONTHLY_SPEND_CEILING_USD;
  const period = periodOf(now);

  let tokens = await tokensFromRedis(period);
  let source = "redis";
  if (!tokens) {
    tokens = await tokensFromDatabase(now);
    source = tokens ? "database" : "unavailable";
  }

  if (!tokens) {
    return { period, source, inputTokens: null, outputTokens: null, usd: null, ceiling, ratio: null };
  }

  const usd = usdFor(tokens.inputTokens, tokens.outputTokens);
  return {
    period,
    source,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    usd,
    ceiling,
    // A ceiling of 0 means "allow nothing", so the ratio is Infinity
    // rather than NaN — the comparison below must still decide.
    ratio: ceiling === 0 ? Number.POSITIVE_INFINITY : usd / ceiling,
  };
}

/** @param {string} period */
async function tokensFromRedis(period) {
  try {
    const hash = await getRedis().hgetall(tokensKey(period));
    if (!hash || Object.keys(hash).length === 0) return null;
    return { inputTokens: Number(hash.input ?? 0), outputTokens: Number(hash.output ?? 0) };
  } catch (err) {
    logger.warn(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "spend estimate unavailable from redis, falling back to the database",
    );
    return null;
  }
}

/** @param {Date} now */
async function tokensFromDatabase(now) {
  try {
    const sums = await prisma.analysis.aggregate({
      _sum: { inputTokens: true, outputTokens: true },
      where: { createdAt: { gte: periodStartOf(now) } },
    });
    return {
      inputTokens: sums._sum.inputTokens ?? 0,
      outputTokens: sums._sum.outputTokens ?? 0,
    };
  } catch (err) {
    logger.error(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "spend estimate unavailable from the database as well",
    );
    return null;
  }
}

/**
 * SEQUENCE STEP 2 (§2.2), ahead of the per-user quota check.
 *
 * Order matters for honesty, not just cost: a user who is over their own
 * quota while the PLATFORM is also capped must not be told they used
 * their fifty analyses. The broader condition answers first.
 *
 * @param {Date} [now]
 */
export async function assertAnalysisAllowed(now = new Date()) {
  // FR-5.4 and PRD §15: the manual lever, checked first and independently
  // of spend. Building the cutoff only as an automatic cost trigger would
  // miss the point — disabling analysis is also the correct response to a
  // discovered prompt regression or a provider incident, and PRD §15 names
  // this flag as the rollback lever for exactly that.
  if (!config.ANALYSIS_ENABLED) {
    throw new AppError("SPEND_LIMIT_REACHED", {
      // Same error code, because clients must degrade identically (D13);
      // different words, because claiming a spend limit when an operator
      // pulled the lever for a prompt regression would be a lie, and
      // FR-5.4 asks for an honest message.
      message:
        "Contract analysis is paused while we look into something. " +
        "Your existing reports are unaffected and still readable.",
      details: { reason: "analysis_disabled" },
    });
  }

  const state = await getSpendState(now);

  // An unknown figure does not refuse. Both stores would have to be
  // unreachable to get here, and in that state the database is down too,
  // so an analysis is not going to be written anyway — failing closed on
  // a number we do not have would turn an outage into a wrong message.
  if (state.ratio === null) return;

  if (state.ratio >= 1) {
    throw new AppError("SPEND_LIMIT_REACHED", { details: { reason: "monthly_ceiling" } });
  }
}

/**
 * SEQUENCE STEP 11 (§2.2) — recorded for every terminal outcome, failures
 * included, for the same reason quota is (FR-5.2): a failed call still
 * spent the tokens it spent.
 *
 * Never throws, like consumeQuota: metering must not be able to fail an
 * analysis that already happened.
 *
 * @param {{ inputTokens: number | null, outputTokens: number | null }} usage
 * @param {Date} [now]
 */
export async function recordSpend(usage, now = new Date()) {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  if (inputTokens === 0 && outputTokens === 0) return;

  const period = periodOf(now);
  try {
    const redis = getRedis();
    await redis
      .multi()
      .hincrby(tokensKey(period), "input", inputTokens)
      .hincrby(tokensKey(period), "output", outputTokens)
      // Outlives its own month, so a late read cannot resurrect a period
      // that should have rolled over.
      .expire(tokensKey(period), 62 * 24 * 60 * 60)
      .exec();

    await raiseThresholdAlerts(period, now);
  } catch (err) {
    logger.error(
      { err: { message: err instanceof Error ? err.message : String(err) } },
      "spend counter increment failed — the monthly estimate is undercounted for this analysis",
    );
  }
}

/**
 * FR-5.4's 50% and 80% warnings, and the 100% crossing.
 *
 * Alerted ONCE per threshold per month, not once per request: a ceiling
 * is crossed by a request and then stays crossed, so a per-request alert
 * would bury the incident it is reporting under its own noise. The marker
 * is a Redis SET NX, which is also what makes "once" mean once across the
 * fleet rather than once per instance (§2's second critical constraint).
 *
 * @param {string} period @param {Date} now
 */
async function raiseThresholdAlerts(period, now) {
  const state = await getSpendState(now);
  if (state.ratio === null) return;

  for (const threshold of ALERT_THRESHOLDS) {
    if (state.ratio < threshold) continue;
    const first = await getRedis().set(alertKey(period, threshold), "1", "EX", 62 * 24 * 60 * 60, "NX");
    if (first !== "OK") continue;

    const detail = {
      period,
      threshold,
      usd: Number(state.usd?.toFixed(4)),
      ceiling: state.ceiling,
      model: config.ANTHROPIC_MODEL,
    };
    if (threshold >= 1) {
      logger.error(detail, "FR-5.4: monthly LLM spend ceiling reached — new analyses now refused");
    } else {
      logger.warn(detail, `FR-5.4: monthly LLM spend passed ${threshold * 100}% of the ceiling`);
    }
  }
}
