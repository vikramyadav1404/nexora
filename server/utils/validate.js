const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim()) && email.length <= 254;
}

// not "bank level" — just keep obvious junk out
function isStrongPassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

function sanitizeText(value, max = 2000) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function sanitizeNamePart(value, max = 60) {
  return sanitizeText(value, max).replace(/[<>]/g, '');
}

function isValidUuid(id) {
  return (
    typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  );
}

/**
 * Makes a user-supplied value safe to interpolate into a PostgREST filter string.
 *
 * PostgREST parses `.or("name.ilike.%q%,email.ilike.%q%")` as structured syntax,
 * so a `q` containing a comma, dot, or parenthesis can inject extra filter terms
 * and change which rows come back. We were interpolating raw input in
 * routes/users.js and routes/search.js.
 *
 * Anything with meaning to the filter grammar is dropped rather than escaped —
 * PostgREST's quoting rules differ per operator, and for a search box losing a
 * punctuation character costs nothing.
 */
function escapePostgrestValue(value, max = 80) {
  if (value == null) return '';
  return String(value)
    .trim()
    .slice(0, max)
    // filter-grammar metacharacters
    .replace(/[,().*\\"']/g, ' ')
    // LIKE wildcards — a user typing % should not match everything
    .replace(/[%_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  isValidEmail,
  isStrongPassword,
  sanitizeText,
  sanitizeNamePart,
  isValidUuid,
  escapePostgrestValue
};
