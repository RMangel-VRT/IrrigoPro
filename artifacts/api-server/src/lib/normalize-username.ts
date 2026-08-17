// Usernames must survive a round trip through a phone, a spreadsheet, a
// contact card and a chat message before anyone types them into the login box.
// Several of those sources silently attach invisible Unicode to a string.
//
// The failure this prevents was live in production: a bookkeeper account was
// created with the username "3035480337" followed by U+202D (LEFT-TO-RIGHT
// OVERRIDE) — 10 visible digits stored as 11 characters. Login looks an account
// up by username, so whoever PASTED the number (carrying the hidden character)
// matched the row and signed in, while whoever TYPED the ten digits did not
// match and got "Invalid credentials". Same account, same password, different
// answer depending on how the username reached the form. Resetting the password
// could never fix it: password writes go by user id, and the lookup that was
// failing happens before the password is ever compared.
//
// The characters at fault are Unicode "format" characters (category Cf): bidi
// marks and overrides (U+200E, U+200F, U+202A-U+202E), zero-width space/joiner
// (U+200B-U+200D), word joiner (U+2060), soft hyphen (U+00AD) and the byte
// order mark (U+FEFF). They render as nothing at all, so a corrupted username
// is invisible in the admin UI, in psql, and in a bug report.
//
// None of them are legitimate in a username, so they are removed outright
// rather than escaped or rejected — rejecting would only move the confusion to
// a validation error nobody can act on, because the offending character cannot
// be seen.

/** Unicode format (Cf) and control (Cc) characters. Neither is ever meaningful
 *  in a username, and both are invisible when rendered. */
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Cc}]/gu;

/**
 * Canonicalise a username for storage and for lookup.
 *
 * Applied on BOTH sides of the comparison — every write goes through it so no
 * new corrupted row can be created, and every lookup goes through it so a user
 * pasting a string that still carries hidden characters is matched against the
 * clean stored value.
 *
 * Compatibility-normalises (NFKC, which folds look-alike forms such as
 * full-width digits onto their ASCII equivalents and no-break spaces onto
 * ordinary ones), strips invisible characters, then trims.
 *
 * Case is deliberately preserved: the account lookup compares case-insensitively
 * in SQL, and the stored spelling is what gets shown back to the user.
 *
 * Non-string input yields an empty string, so a malformed request body cannot
 * be coerced into matching some unrelated account.
 */
export function normalizeUsername(username: unknown): string {
  if (typeof username !== "string") return "";
  return username.normalize("NFKC").replace(INVISIBLE_CHARACTERS, "").trim();
}

/**
 * True when normalisation would change the value — i.e. the string carries
 * invisible characters, stray whitespace or non-canonical forms.
 *
 * Used by the repair migration to find affected rows, and available to any
 * admin-side validation that wants to warn before writing.
 */
export function hasInvisibleCharacters(username: unknown): boolean {
  return typeof username === "string" && normalizeUsername(username) !== username;
}

/**
 * Render a string with every invisible character made visible as its codepoint,
 * for logs and admin screens. `describeUsername("303\u202D")` gives
 * `303<U+202D>`. Without this, a corrupted username and a clean one are
 * indistinguishable in any human-readable output.
 */
export function describeUsername(username: unknown): string {
  if (typeof username !== "string") return String(username);
  return username.replace(INVISIBLE_CHARACTERS, (ch) => {
    const hex = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    return `<U+${hex}>`;
  });
}
