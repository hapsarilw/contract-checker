/**
 * An email address as a WHOLE address inside a longer string: a Redis key
 * name, a column's text. For erasure (services/account.js) and the erasure
 * check (services/erasureCheck.js).
 *
 * A plain substring search is wrong both ways. "ann@x.co" is a substring
 * of "joann@x.co", a different person: erasure must not reset that
 * person's rate-limit counter, and the check must not report their row as
 * the deleted account's residue. Found by step 75's erasure test, whose
 * decoy account was exactly that.
 *
 * So the address may not be preceded by a character that could continue
 * its local part, nor followed by one that could continue its domain. A
 * full stop after it counts only when another label follows, so "write to
 * ann@x.co." in a document still matches.
 *
 * One pattern, in the dialect JavaScript's RegExp and PostgreSQL's
 * advanced regular expressions both read the same way (lookbehind,
 * lookahead, bracket expressions, backslash escapes), so the Redis filter
 * and the SQL sweep cannot disagree about what a match is. Lower-case
 * only: callers compare against lower-cased text.
 *
 * @param {string} address normalised: trimmed and lower-cased
 * @returns {string} a regular expression's source
 */
export function wholeAddressPattern(address) {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return "(?<![a-z0-9!#$%&'*+/=?^_`{|}~.-])" + escaped + "(?![a-z0-9-])(?!\\.[a-z0-9])";
}
