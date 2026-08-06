/**
 * TOTP — RFC 6238, on top of HOTP from RFC 4226.
 *
 * Written against node:crypto rather than pulled from npm. The algorithm is one
 * HMAC and a truncation; the whole thing is shorter than the dependency's
 * README, and an auth primitive is a poor place to inherit a supply chain.
 *
 * The parameters below are not tuning knobs. Google Authenticator, Authy, 1Password
 * and Apple's built-in generator all assume SHA-1, six digits and a thirty-second
 * step, and most ignore the otpauth:// URI when it says otherwise. "SHA-1 is
 * broken" is true of collision resistance and irrelevant to HMAC-SHA-1, which
 * relies on preimage resistance and is unbroken. Changing these to look modern
 * would trade real interoperability for no security.
 */
const crypto = require('crypto');

const DIGITS = 6;
const STEP_SECONDS = 30;
const ALGORITHM = 'sha1';

/**
 * How far either side of now a code is accepted, in steps.
 *
 * 1 means ±30 seconds. Phone clocks drift, and a user who starts typing at
 * second 29 should not be punished for it. Every extra step of slack multiplies
 * the codes valid at any instant, so this stays at the smallest value that
 * doesn't generate support tickets.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, unpadded — the encoding every authenticator app expects. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

function base32Decode(input) {
  // Users retype these by hand off a screen, so accept the shapes they produce:
  // lowercase, the spaces apps insert every four characters, and '=' padding.
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '');

  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * A new secret.
 *
 * 20 bytes because that is HMAC-SHA-1's block-independent natural key length
 * (RFC 4226 §4 requires at least 16 and recommends 20), and it encodes to a
 * clean 32-character base32 string with no padding.
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The time-step a given moment falls in. This is the HOTP counter. */
function currentStep(at = Date.now()) {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

/** HOTP: HMAC the counter, then dynamically truncate to `DIGITS` digits. */
function hotp(secretBuffer, counter) {
  const message = Buffer.alloc(8);
  // Counters exceed 32 bits in the year 6053; write the full 64 anyway rather
  // than leave a landmine that looks fine for four thousand years.
  message.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(ALGORITHM, secretBuffer).update(message).digest();

  // RFC 4226 §5.4 dynamic truncation: the low nibble of the last byte picks
  // where to read from, so the offset itself depends on the MAC.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code for a secret at a moment. Exported mainly so tests can be honest. */
function generateCode(secret, at = Date.now()) {
  return hotp(base32Decode(secret), currentStep(at));
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Check a submitted code.
 *
 * Returns the time-step that matched, or null. The step matters to the caller:
 * a code is valid for its whole 30-second window, so accepting one and moving on
 * would let the same digits be replayed until the window closed. Recording the
 * step and refusing anything at or below it makes each code single-use. Pass the
 * stored value as `afterStep` to enforce that.
 *
 * Every candidate step is tested even after a match, so the time taken does not
 * reveal which one was correct.
 */
function verifyCode(secret, code, { at = Date.now(), window = DEFAULT_WINDOW, afterStep = 0 } = {}) {
  const trimmed = String(code || '').replace(/\s/g, '');
  if (!/^\d+$/.test(trimmed) || trimmed.length !== DIGITS) return null;

  let secretBuffer;
  try {
    secretBuffer = base32Decode(secret);
  } catch {
    return null;
  }
  if (secretBuffer.length === 0) return null;

  const now = currentStep(at);
  let matched = null;

  for (let offset = -window; offset <= window; offset++) {
    const step = now + offset;
    if (step <= afterStep) continue; // already used, or older than one that was
    if (constantTimeEquals(hotp(secretBuffer, step), trimmed) && matched === null) {
      matched = step;
    }
  }

  return matched;
}

/**
 * The otpauth:// URI an authenticator app reads out of a QR code.
 *
 * The issuer appears twice by convention — once as a prefix on the label and
 * once as a parameter. Older apps read only the prefix, newer ones only the
 * parameter, and omitting either makes the entry show up unlabelled on somebody's
 * phone next to five other unlabelled entries.
 */
function otpauthUri(secret, { account, issuer = 'Nexora' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: ALGORITHM.toUpperCase(),
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Grouped into fours because that is how people read a string off a screen. */
function formatSecretForDisplay(secret) {
  return String(secret).replace(/(.{4})/g, '$1 ').trim();
}

module.exports = {
  DIGITS,
  STEP_SECONDS,
  DEFAULT_WINDOW,
  base32Encode,
  base32Decode,
  generateSecret,
  generateCode,
  currentStep,
  verifyCode,
  otpauthUri,
  formatSecretForDisplay
};
