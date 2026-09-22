/**
 * Transactional email templates (step 51): verification, password reset,
 * password-changed notice, email-change notice, deletion confirmation.
 *
 * PURE FUNCTIONS. Each takes plain values and returns { subject, text,
 * html }. None reads config, the clock, or the environment — the caller
 * (lib/email.js) builds links from FRONTEND_ORIGIN and passes them in. That
 * keeps every template testable by calling it, and it means a template
 * cannot log itself: it has no logger to log with.
 *
 * WHY A TEMPLATE CAN BE A SECRET. A verification or reset email carries a
 * single-use token in its link, so the BODY of these messages is a
 * credential. That is the reason the never-logged list (SRS §6.5) bars
 * bodies outright rather than only the addresses in them, and the reason
 * nothing here is ever passed to a logger.
 *
 * Plain text is the primary part and is always complete on its own; the
 * HTML part is a light rendering of the same words. Every interpolated
 * value is escaped for HTML, though today the only ones are a link built
 * from a base64url token and a masked address — a template that is only
 * safe while its inputs happen to be tame is a bug waiting for a caller.
 */

const PRODUCT = "ClauseCheck";

/** @param {string} value */
export function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * "alice@example.com" → "a****@example.com". Used where a notice names an
 * address other than the recipient's: enough for the owner to recognise it,
 * not enough for whoever reads a forwarded copy to learn it.
 *
 * @param {string} address
 */
export function maskEmail(address) {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "****";
  return `${address[0]}****${address.slice(at)}`;
}

/**
 * @param {string[]} paragraphs
 * @param {{ label: string, url: string } | null} [action]
 */
function render(paragraphs, action = null) {
  const text = [
    ...paragraphs,
    ...(action ? [`${action.label}:\n${action.url}`] : []),
    `— ${PRODUCT}`,
  ].join("\n\n");

  const html =
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
    (action
      ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` +
        `<p style="color:#666;font-size:12px">If the button does not work, copy this address into your browser:<br>${escapeHtml(action.url)}</p>`
      : "") +
    `<p>— ${escapeHtml(PRODUCT)}</p>`;

  return { text, html };
}

const IGNORE =
  "If you did not expect this message, you can ignore it — nothing changes unless the link is opened.";

/**
 * FR-1.7: the link is valid for 24 hours and works once.
 *
 * @param {{ verifyUrl: string }} params
 */
export function verificationEmail({ verifyUrl }) {
  return {
    subject: `Confirm your email for ${PRODUCT}`,
    ...render(
      [
        `Welcome to ${PRODUCT}. Confirm this address to start analysing contracts.`,
        "The link below works once and expires in 24 hours.",
        IGNORE,
      ],
      { label: "Confirm your email", url: verifyUrl },
    ),
  };
}

/**
 * @param {{ resetUrl: string }} params
 */
export function passwordResetEmail({ resetUrl }) {
  return {
    subject: `Reset your ${PRODUCT} password`,
    ...render(
      [
        "We received a request to reset the password on this account.",
        "The link below works once and expires in 30 minutes. Opening it lets you choose a new password.",
        "If you did not ask for this, leave it alone — your password has not changed, and it is worth signing in and changing it if you think someone else knows it.",
      ],
      { label: "Choose a new password", url: resetUrl },
    ),
  };
}

/**
 * A notice, not a request: it has no link that does anything, because a
 * notice that could be acted on is a phishing template.
 */
export function passwordChangedEmail() {
  return {
    subject: `Your ${PRODUCT} password was changed`,
    ...render([
      "The password on your account was just changed, and you have been signed out on your other devices.",
      "If this was you, there is nothing to do.",
      "If it was not, reset your password straight away from the sign-in page and contact us.",
    ]),
  };
}

/**
 * FR-1.13, sent to the NEW address. Deliberately not the signup
 * verification template: that one welcomes someone to the product, which
 * would read as nonsense to a person who has had an account for months.
 *
 * @param {{ confirmUrl: string }} params
 */
export function emailChangeVerificationEmail({ confirmUrl }) {
  return {
    subject: `Confirm your new ${PRODUCT} email address`,
    ...render(
      [
        "You asked to move your ClauseCheck account to this address.",
        "The link below works once and expires in 24 hours. Until you open it, your account keeps its old address and nothing changes.",
        IGNORE,
      ],
      { label: "Confirm this address", url: confirmUrl },
    ),
  };
}

/**
 * Sent to the OLD address. The new address may be an attacker's, and the
 * person who owns the old one is the only one who can object.
 *
 * @param {{ newEmail: string }} params
 */
export function emailChangedEmail({ newEmail }) {
  return {
    subject: `The email on your ${PRODUCT} account was changed`,
    ...render([
      `The email address on your account was changed to ${maskEmail(newEmail)}.`,
      "If this was you, there is nothing to do.",
      "If it was not, reset your password from the sign-in page and contact us straight away.",
    ]),
  };
}

/**
 * PRD §12.4: deletion is permanent, and backups age out within 30 days —
 * the message says that rather than implying instant global erasure.
 */
export function accountDeletedEmail() {
  return {
    subject: `Your ${PRODUCT} account has been deleted`,
    ...render([
      "Your account, your documents and every report were permanently deleted, as you asked.",
      "Backups age out within 30 days, so remnants can persist there until then; nothing in that window is used for anything.",
      "We are sorry to see you go.",
    ]),
  };
}

/**
 * The message types, and what each needs. `to` is separate because the
 * recipient is not always the account's current address (emailChanged goes
 * to the old one; accountDeleted goes to an address whose account no longer
 * exists).
 */
export const TEMPLATES = Object.freeze({
  verification: verificationEmail,
  email_change_verification: emailChangeVerificationEmail,
  password_reset: passwordResetEmail,
  password_changed: passwordChangedEmail,
  email_changed: emailChangedEmail,
  account_deleted: accountDeletedEmail,
});

/** @typedef {keyof typeof TEMPLATES} EmailType */
