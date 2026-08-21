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
const TOKEN_TYPE_MFA_PENDING = 'mfa_pending';

/**
 * How long the gap between password and second factor may stay open.
 *
 * Long enough to unlock a phone and find the app, short enough that a pending
 * token copied off a screen is worthless by the time anyone acts on it.
 */
const MFA_PENDING_TTL = '5m';

/**
 * The signing secret. No fallback, deliberately.
 *
 * This returned 'dev_insecure_jwt' when JWT_SECRET was unset -- a string
 * published in this repository -- and it is the function that SIGNS access
 * tokens. middleware/auth.js fails closed on a missing secret, so a deployment
 * without the variable would 500 on protected routes; but /login would still
 * have issued tokens anyone could forge, for any user id. The failure was
 * silent where it mattered and loud only where it did not.
 *
 * Throwing means a misconfigured deploy fails at the first token operation
 * instead of quietly minting forgeable sessions. assertJwtSecret() below moves
 * that failure earlier still, to boot.
 */
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set — refusing to sign or verify tokens');
  }
  return secret;
}

/**
 * Minimum length for the signing secret.
 *
 * HS256 keys shorter than the 256-bit hash offer no more security than their
 * own length, and a short one is nearly always a placeholder someone meant to
 * replace. 32 characters is the floor, not a target.
 */
const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Called at boot. Fails the deploy rather than the first login.
 *
 * Same reasoning as refusing the silent demo-mode fallback: a deployment that
 * cannot authenticate should not start and look healthy. A crash is visible; a
 * server issuing forgeable tokens is not.
 */
function assertJwtSecret(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start: without it the server would ' +
      'either issue forgeable sessions or fail every authenticated request.'
    );
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is ${secret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required. ` +
      'A short secret is almost always a placeholder.'
    );
  }
}

function signAccessToken(userId) {
  return jwt.sign({ id: userId, typ: TOKEN_TYPE_ACCESS }, jwtSecret(), { expiresIn: ACCESS_TTL });
}

/**
 * The half-authenticated token issued between a correct password and a correct
 * code. It carries no session — middleware/auth.js rejects any typ that is not
 * 'access', so the only route that will look at this is /api/auth/mfa/verify.
 */
function signMfaPendingToken(userId) {
  return jwt.sign({ id: userId, typ: TOKEN_TYPE_MFA_PENDING }, jwtSecret(), {
    expiresIn: MFA_PENDING_TTL
  });
}

/**
 * Returns the user id, or null.
 *
 * The typ check is the point: an access token presented here must not work.
 * Without it, anyone already holding a valid session could walk another
 * account's second factor, and a 15-minute access token would become a way to
 * satisfy the very step it is meant to depend on.
 */
function verifyMfaPendingToken(token) {
  try {
    const decoded = jwt.verify(token, jwtSecret());
    if (decoded?.typ !== TOKEN_TYPE_MFA_PENDING || !decoded?.id) return null;
    return decoded.id;
  } catch {
    return null;
  }
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

/**
 * Record a refresh token and return its row id.
 *
 * Issuing a session and rotating one both write this row, and both must write
 * it the same way -- the hash rather than the token, the same expiry window,
 * the same truncation on the two attacker-controlled strings. Two copies meant
 * a change to any of those had to be made twice, and the rotation copy is the
 * one that matters most.
 */
async function insertRefreshRow(db, { userId, token, userAgent, ip }) {
  const { data, error } = await db
    .from('refresh_tokens')
    .insert({
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: refreshExpiry().toISOString(),
      user_agent: String(userAgent).slice(0, 300),
      ip: String(ip).slice(0, 60)
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

/** Issue a brand-new session. Used by register, login, and MFA verify. */
async function issueSession(userId, { userAgent = '', ip = '' } = {}) {
  const refresh = newRefreshToken();
  const refreshId = await insertRefreshRow(getSupabase(), {
    userId, token: refresh, userAgent, ip
  });

  return { accessToken: signAccessToken(userId), refreshToken: refresh, refreshId };
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

  const { data: row, error } = await db
    .from('refresh_tokens')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', hash)
    .maybeSingle();

  /*
   * Distinguish "no such token" from "no such table".
   *
   * Swallowing the error here made a missing migration look like an ordinary
   * expired session: every refresh returned "Session expired", sessions died
   * after fifteen minutes, and the message pointed at the token rather than at
   * the schema. Surfacing it means the operator reads the actual cause.
   */
  if (error) {
    if (/refresh_tokens/i.test(error.message || '') || error.code === 'PGRST205') {
      throw new Error(
        'Database schema incomplete: refresh_tokens table is missing. ' +
        'Run server/db/migrations/009_auth_tokens.sql in the Supabase SQL Editor.'
      );
    }
    throw error;
  }

  if (!row) throw new RefreshError('Invalid refresh token');

  if (row.revoked_at) {
    await revokeFamily(row.user_id);
    throw new RefreshError('Refresh token reuse detected', { reuse: true });
  }

  if (new Date(row.expires_at) <= new Date()) {
    throw new RefreshError('Refresh token expired');
  }

  const next = newRefreshToken();
  const createdId = await insertRefreshRow(db, {
    userId: row.user_id, token: next, userAgent, ip
  });

  // Retire the presented token only after its successor exists, so a failure
  // between the two leaves the caller with a token that still works.
  const { error: revokeErr } = await db
    .from('refresh_tokens')
    .update({ revoked_at: new Date().toISOString(), replaced_by: createdId })
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


/* ── media cookie ────────────────────────────────────────────
   The credential an <img> can actually send.                  */

const MEDIA_COOKIE = 'nexora_media';
const TOKEN_TYPE_MEDIA = 'media';

/**
 * Media reads need their own credential, and it has to be a cookie.
 *
 * Every other route authenticates with an Authorization header. `<img src>` and
 * `<video src>` cannot send one -- the browser issues those requests itself --
 * and the refresh cookie is scoped to /api/auth, so it never reaches
 * /api/media. Without a dedicated cookie there is no way to authorise an image
 * request at all, which is why the buckets were public in the first place.
 *
 * SameSite=Lax is doing real work here rather than being a relaxation. Our own
 * client reaches the API same-origin through the rewrites in vercel.json, so
 * the cookie is sent. An attacker embedding <img src="https://…/api/media/…">
 * on their own page gets nothing, because Lax withholds cookies on cross-site
 * subresource requests. The default fails in the direction we want.
 *
 * Strict would also work for the embed case but breaks legitimate top-level
 * navigation to a media URL, and Lax already denies the attack that matters.
 *
 * Deliberately narrow: it authorises reading media and nothing else. It cannot
 * be exchanged for a session, and middleware/auth.js will not accept it because
 * of the typ check.
 */
const MEDIA_TTL_DAYS = 30;

function signMediaToken(userId) {
  return jwt.sign({ id: userId, typ: TOKEN_TYPE_MEDIA }, jwtSecret(), {
    expiresIn: `${MEDIA_TTL_DAYS}d`
  });
}

/**
 * @returns {string|null} the user id this token authorises media reads for.
 */
function verifyMediaToken(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret());
    // Only a media token. An access token must not double as one -- they have
    // different lifetimes and a different blast radius if copied.
    if (decoded?.typ !== TOKEN_TYPE_MEDIA || !decoded.id) return null;
    return decoded.id;
  } catch {
    return null;
  }
}

function mediaCookieOptions({ secure = process.env.NODE_ENV === 'production' } = {}) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/api/media',
    maxAge: MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000
  };
}

function setMediaCookie(res, userId) {
  res.cookie(MEDIA_COOKIE, signMediaToken(userId), mediaCookieOptions());
}

function clearMediaCookie(res) {
  res.clearCookie(MEDIA_COOKIE, { ...mediaCookieOptions(), maxAge: undefined });
}

module.exports = {
  assertJwtSecret,
  MIN_JWT_SECRET_LENGTH,
  ACCESS_TTL,
  REFRESH_TTL_DAYS,
  REFRESH_COOKIE,
  MEDIA_COOKIE,
  TOKEN_TYPE_MEDIA,
  MEDIA_TTL_DAYS,
  signMediaToken,
  verifyMediaToken,
  mediaCookieOptions,
  setMediaCookie,
  clearMediaCookie,
  TOKEN_TYPE_ACCESS,
  TOKEN_TYPE_MFA_PENDING,
  MFA_PENDING_TTL,
  RefreshError,
  signAccessToken,
  signMfaPendingToken,
  verifyMfaPendingToken,
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
