/**
 * MFA state: the TOTP secret at rest, and single-use backup codes.
 *
 * utils/totp.js owns the algorithm and knows nothing about storage. This file
 * owns storage and knows nothing about HMAC. Routes talk to this one.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getSupabase } = require('../db/supabase');
const { generateSecret, verifyCode, otpauthUri } = require('./totp');

// ------------------------------------------------------------
// Secret at rest
// ------------------------------------------------------------
/*
 * Encrypted, not hashed.
 *
 * Every other credential in this codebase is one-way: passwords are bcrypt,
 * refresh tokens are SHA-256. A TOTP secret cannot be, because verification
 * needs the original bytes to recompute the HMAC. So the realistic goal is
 * narrower — make a database dump insufficient on its own — and encryption with
 * a key held outside Postgres achieves exactly that. An attacker who has the
 * table still cannot generate codes; they need the environment too.
 *
 * AES-256-GCM rather than CBC because GCM authenticates. Without a tag, a
 * tampered ciphertext decrypts to garbage that is then fed to base32Decode, and
 * the failure surfaces somewhere far away as an unhelpful error.
 */
const KEY_INFO = 'nexora-mfa-secret-encryption-v1';

let warnedAboutKey = false;

function encryptionKey() {
  const explicit = process.env.MFA_SECRET_KEY;
  if (explicit && explicit.length >= 16) {
    return crypto.createHash('sha256').update(explicit).update(KEY_INFO).digest();
  }

  /*
   * Falling back to JWT_SECRET keeps a deployment that forgot MFA_SECRET_KEY
   * working, but it is genuinely worse: rotating JWT_SECRET then makes every
   * stored secret undecryptable, and MFA silently stops accepting codes for
   * everyone at once. The domain separator at least means this is not literally
   * the same key material used for signing.
   */
  const fallback = process.env.JWT_SECRET;
  if (!fallback) throw new Error('MFA requires MFA_SECRET_KEY or JWT_SECRET to be set');

  if (!warnedAboutKey) {
    warnedAboutKey = true;
    console.warn(
      '[mfa] MFA_SECRET_KEY is not set — deriving from JWT_SECRET. Rotating ' +
      'JWT_SECRET will make every stored TOTP secret undecryptable. Set a ' +
      'dedicated MFA_SECRET_KEY before enabling MFA for real users.'
    );
  }
  return crypto.createHash('sha256').update(fallback).update(KEY_INFO).digest();
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12); // 96 bits, the size GCM is defined for
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  // Must come after final() — the tag is not complete until the last block is.
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

/** Returns null rather than throwing — a corrupt or foreign-key secret is a
 *  "this account cannot do MFA right now" problem, not a 500. */
function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string') return null;

  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;

  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    // Wrong key, or the ciphertext was altered. Both mean unusable.
    return null;
  }
}

// ------------------------------------------------------------
// Backup codes
// ------------------------------------------------------------
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

/*
 * Crockford-style alphabet: no 0/O, no 1/I/L. These get read off a screen and
 * typed on a phone, sometimes copied onto paper first, and the pairs above are
 * where that goes wrong.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/*
 * Cost 10, where passwords use 12.
 *
 * Cost is a defence against guessing, and these are not guessable the way a
 * password is: ten characters from a thirty-symbol alphabet is a little over
 * 49 bits of CSPRNG output, which no online attacker traverses at any cost
 * factor. What cost 12 would buy here is a 2.5-second wait to generate ten
 * codes and up to 2.5 seconds to verify one, since bcrypt offers no way to look
 * a hash up by value — every unused code must be compared in turn. Cost 10
 * keeps both under a second for no meaningful loss.
 */
const BACKUP_CODE_COST = 10;

function generateBackupCode() {
  const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    // Modulo bias across 256 % 30 is under 1% and costs nothing here; the
    // alternative is rejection sampling for no measurable entropy gain.
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Uppercase and strip formatting, so "abcde fghij" matches "ABCDE-FGHIJ". */
function normalizeBackupCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Replace every backup code for a user and return the new plaintext set.
 *
 * The caller shows these once. There is deliberately no way to read them back —
 * only the bcrypt hashes are stored, which is the entire point.
 */
async function regenerateBackupCodes(userId) {
  const db = getSupabase();
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);

  const rows = await Promise.all(
    codes.map(async (code) => ({
      user_id: userId,
      code_hash: await bcrypt.hash(normalizeBackupCode(code), BACKUP_CODE_COST)
    }))
  );

  // Old codes stop working the moment new ones are issued. Anything else means
  // a set printed a year ago still opens the account.
  const { error: delErr } = await db.from('mfa_backup_codes').delete().eq('user_id', userId);
  if (delErr) throw delErr;

  const { error: insErr } = await db.from('mfa_backup_codes').insert(rows);
  if (insErr) throw insErr;

  return codes;
}

/**
 * Redeem a backup code. Returns true and burns it, or false.
 *
 * Marking used_at rather than deleting lets the account page report how many
 * remain, and leaves evidence if codes are being spent by someone who should
 * not have them.
 */
async function consumeBackupCode(userId, submitted) {
  const normalized = normalizeBackupCode(submitted);
  if (normalized.length !== BACKUP_CODE_LENGTH) return false;

  const db = getSupabase();
  const { data: rows, error } = await db
    .from('mfa_backup_codes')
    .select('id, code_hash')
    .eq('user_id', userId)
    .is('used_at', null);

  if (error) throw error;

  for (const row of rows || []) {
    if (await bcrypt.compare(normalized, row.code_hash)) {
      // Conditional on used_at still being null, so two requests racing the same
      // code cannot both win.
      const { data: claimed, error: claimErr } = await db
        .from('mfa_backup_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('used_at', null)
        .select('id');

      if (claimErr) throw claimErr;
      return (claimed || []).length > 0;
    }
  }

  return false;
}

async function countUnusedBackupCodes(userId) {
  const { data, error } = await getSupabase()
    .from('mfa_backup_codes')
    .select('id')
    .eq('user_id', userId)
    .is('used_at', null);
  if (error) throw error;
  return (data || []).length;
}

// ------------------------------------------------------------
// Lockout
// ------------------------------------------------------------
/*
 * Per-account failure counting, deliberately not delegated to the rate limiter.
 *
 * middleware/rateLimit.js keys on IP and fails open when its Postgres store is
 * unreachable. Both properties are right for general traffic and wrong for the
 * last factor guarding an account: an attacker who already has the password
 * needs one lucky guess in a million, can spread attempts across addresses, and
 * benefits directly whenever the limiter degrades.
 *
 * Five attempts then fifteen minutes caps a determined attacker at roughly 480
 * guesses a day — about 2,000 years of expected effort against one account —
 * while a genuine user who fat-fingers a code twice never notices the limit.
 */
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCKOUT_MINUTES = 15;

/** Milliseconds remaining on a lockout, or 0. */
function lockoutRemainingMs(userRow, now = Date.now()) {
  const until = userRow?.mfa_locked_until ? new Date(userRow.mfa_locked_until).getTime() : 0;
  return until > now ? until - now : 0;
}

/** Count a wrong code. Locks the account once the run of failures hits the cap. */
async function recordFailedAttempt(userRow) {
  const attempts = Number(userRow?.mfa_failed_attempts || 0) + 1;
  const locked = attempts >= MFA_MAX_ATTEMPTS;

  const patch = { mfa_failed_attempts: locked ? 0 : attempts };
  if (locked) {
    // Counter resets alongside the lock, so the next window starts clean rather
    // than locking again on the first mistake after it expires.
    patch.mfa_locked_until = new Date(Date.now() + MFA_LOCKOUT_MINUTES * 60_000).toISOString();
  }

  const { error } = await getSupabase().from('users').update(patch).eq('id', userRow.id);
  if (error) throw error;

  return { locked, attemptsRemaining: locked ? 0 : MFA_MAX_ATTEMPTS - attempts };
}

/** Any success wipes the run — the counter measures consecutive failures. */
async function clearFailedAttempts(userId) {
  const { error } = await getSupabase()
    .from('users')
    .update({ mfa_failed_attempts: 0, mfa_locked_until: null })
    .eq('id', userId);
  if (error) throw error;
}

// ------------------------------------------------------------
// Enrolment
// ------------------------------------------------------------
/**
 * Begin enrolment: mint a secret, store it encrypted, leave MFA off.
 *
 * The flag stays false until a code proves the app actually holds the secret.
 * Enabling first would let a user who mis-scanned the QR lock themselves out of
 * their own account with no way back in.
 */
async function beginEnrolment(userId, accountLabel) {
  const secret = generateSecret();

  const { error } = await getSupabase()
    .from('users')
    .update({ mfa_secret: encryptSecret(secret), mfa_enabled: false })
    .eq('id', userId);
  if (error) throw error;

  return { secret, uri: otpauthUri(secret, { account: accountLabel }) };
}

/**
 * Check a TOTP code against a user row and, on success, record the step used.
 *
 * The recorded step is what makes a code single-use: verifyCode refuses any step
 * at or below `mfa_last_step`, so the same digits replayed inside their
 * thirty-second window are rejected the second time.
 */
async function verifyTotpForUser(userRow, code) {
  const secret = decryptSecret(userRow.mfa_secret);
  if (!secret) return false;

  const step = verifyCode(secret, code, { afterStep: Number(userRow.mfa_last_step || 0) });
  if (step === null) return false;

  const { error } = await getSupabase()
    .from('users')
    .update({ mfa_last_step: step })
    .eq('id', userRow.id)
    // Guards the same replay window against two concurrent requests: whichever
    // writes second finds the step already advanced and matches no rows.
    .lt('mfa_last_step', step)
    .select('id');

  if (error) throw error;
  return true;
}

/** Turn MFA off and destroy the material behind it. */
async function disableMfa(userId) {
  const db = getSupabase();

  const { error } = await db
    .from('users')
    .update({ mfa_enabled: false, mfa_secret: '', mfa_enabled_at: null, mfa_last_step: 0 })
    .eq('id', userId);
  if (error) throw error;

  const { error: codesErr } = await db.from('mfa_backup_codes').delete().eq('user_id', userId);
  if (codesErr) throw codesErr;
}

module.exports = {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  BACKUP_CODE_COST,
  MFA_MAX_ATTEMPTS,
  MFA_LOCKOUT_MINUTES,
  lockoutRemainingMs,
  recordFailedAttempt,
  clearFailedAttempts,
  encryptSecret,
  decryptSecret,
  generateBackupCode,
  normalizeBackupCode,
  regenerateBackupCodes,
  consumeBackupCode,
  countUnusedBackupCodes,
  beginEnrolment,
  verifyTotpForUser,
  disableMfa
};
