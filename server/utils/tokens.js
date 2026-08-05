/**
 * Access and refresh tokens.
 *
 * The only place in the server that mints, rotates or revokes a session. Routes
 * call these; nothing else should reach for jwt.sign or the refresh_tokens
 * table directly.
 *
 * Shape of the scheme:
 *   access  — JWT, 15 minutes, sent in the Authorization header, held in memory
 *             by the client. Not revocable; it expires instead.
 *   refresh — 32 random bytes, 30 days, httpOnly cookie. Revocable, rotated on
 *             every use, and stored only as a SHA-256 digest.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30);
const REFRESH_COOKIE = 'nexora_refresh';

/** Access tokens carry a type so a pending-MFA token can never be mistaken for one. */
const TOKEN_TYPE_ACCESS = 'access';

function jwtSecret() {
  return process.env.JWT_SECRET || 'dev_insecure_jwt';
}

function signAccessToken(userId) {
  return jwt.sign({ id: userId, typ: TOKEN_TYPE_ACCESS }, jwtSecret(), { expiresIn: ACCESS_TTL });
}

/**
 * SHA-256, not bcrypt.
 *
 * The input is 32 bytes of CSPRNG output, so there is no low-entropy guess
 * space for a slow KDF to defend. bcrypt would add ~250ms to every refresh and
 * silently truncate anything past 72 bytes.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newRefreshToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function refreshExpiry() {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Cookie attributes.
 *
 * SameSite=Strict is only viable because the API is served same-origin through
 * the rewrites in client/vercel.json. If the client ever calls the API on its
 * own hostname again, this cookie stops being sent and every refresh fails —
 * see the note in client/.env.production.example.
 *
 * Secure is omitted on plain-HTTP localhost, because a Secure cookie is dropped
 * by the browser there and local development would silently never refresh.
 */
function refreshCookieOptions({ secure = process.env.NODE_ENV === 'production' } = {}) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000
  };
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
}

/** Issue a brand-new session. Used by register, login, and MFA verify. */
async function issueSession(userId, { userAgent = '', ip = '' } = {}) {
  const refresh = newRefreshToken();

  const { data, error } = await getSupabase()
    .from('refresh_tokens')
    .insert({
      user_id: userId,
      token_hash: hashToken(refresh),
      expires_at: refreshExpiry().toISOString(),
      user_agent: String(userAgent).slice(0, 300),
      ip: String(ip).slice(0, 60)
    })
    .select('id')
    .single();

  if (error) throw error;

  return { accessToken: signAccessToken(userId), refreshToken: refresh, refreshId: data.id };
}

/** Revoke every outstanding token for a user. */
async function revokeFamily(userId) {
  const { error } = await getSupabase()
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (error) throw error;
}

class RefreshError extends Error {
  constructor(message, { reuse = false } = {}) {
    super(message);
    this.reuse = reuse;
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Reuse detection is the reason this is not a simple lookup. A token that has
 * already been rotated should never appear again: the legitimate client threw
 * it away the moment it received a replacement. If one does, either it was
 * stolen and the thief is using it, or it was stolen and the victim is — and
 * there is no way to tell which from here.
 *
 * So the entire family is revoked. Both parties are logged out, the attacker
 * loses the session, and the user notices something happened. Silently issuing
 * a fresh pair would hand the attacker indefinite access.
 */
async function rotateRefreshToken(presented, { userAgent = '', ip = '' } = {}) {
  const db = getSupabase();
  const hash = hashToken(presented);

  const { data: row } = await db
    .from('refresh_tokens')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();

  if (!row) throw new RefreshError('Invalid refresh token');

  if (row.revoked_at) {
    await revokeFamily(row.user_id);
    throw new RefreshError('Refresh token reuse detected', { reuse: true });
  }

  if (new Date(row.expires_at) <= new Date()) {
    throw new RefreshError('Refresh token expired');
  }

  const next = newRefreshToken();
  const { data: created, error: insertErr } = await db
    .from('refresh_tokens')
    .insert({
      user_id: row.user_id,
      token_hash: hashToken(next),
      expires_at: refreshExpiry().toISOString(),
      user_agent: String(userAgent).slice(0, 300),
      ip: String(ip).slice(0, 60)
    })
    .select('id')
    .single();
  if (insertErr) throw insertErr;

  // Retire the presented token only after its successor exists, so a failure
  // between the two leaves the caller with a token that still works.
  const { error: revokeErr } = await db
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by: created.id })
    .eq('id', row.id);
  if (revokeErr) throw revokeErr;

  return {
    userId: row.user_id,
    accessToken: signAccessToken(row.user_id),
    refreshToken: next
  };
}

/** Revoke a single token, for logout. Silent if it is unknown or already gone. */
async function revokeRefreshToken(presented) {
  if (!presented) return;
  await getSupabase()
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', hashToken(presented))
    .is('revoked_at', null);
}

/** Delete rows that are expired or long revoked. Called by the daily cron. */
async function sweepRefreshTokens() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase()
    .from('refresh_tokens')
    .delete()
    .or(`expires_at.lt.${new Date().toISOString()},revoked_at.lt.${cutoff}`)
    .select('id');
  if (error) throw error;
  return { deleted: (data || []).length };
}

module.exports = {
  ACCESS_TTL,
  REFRESH_TTL_DAYS,
  REFRESH_COOKIE,
  TOKEN_TYPE_ACCESS,
  RefreshError,
  signAccessToken,
  hashToken,
  newRefreshToken,
  refreshCookieOptions,
  setRefreshCookie,
  clearRefreshCookie,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeFamily,
  sweepRefreshTokens
};
