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

module.exports = {
  isValidEmail,
  isStrongPassword,
  sanitizeText,
  sanitizeNamePart,
  isValidUuid
};
