const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { getSupabase } = require('../db/supabase');
const {
  hashPassword, comparePassword, shapeUser, isToday, computeBadges,
  withMediaColumns
} = require('../db/helpers');
const { protect, verifyAccessToken, bearerToken } = require('../middleware/auth');
const { sendEmail, generatePassword, generateOTP } = require('../utils/email');
const { pushNotification } = require('../db/features');
const { authLimiter, sensitiveLimiter } = require('../middleware/rateLimit');
const { sendError, isDev, asyncHandler } = require('../utils/respond');
const {
  isValidEmail, isStrongPassword, sanitizeNamePart, sanitizeText
} = require('../utils/validate');

const {
  RefreshError,
  REFRESH_COOKIE,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeFamily,
  setRefreshCookie,
  clearRefreshCookie,
  setMediaCookie,
  clearMediaCookie,
  signMfaPendingToken,
  verifyMfaPendingToken
} = require('../utils/tokens');

const {
  MFA_LOCKOUT_MINUTES,
  lockoutRemainingMs,
  recordFailedAttempt,
  clearFailedAttempts,
  beginEnrolment,
  verifyTotpForUser,
  consumeBackupCode,
  countUnusedBackupCodes,
  regenerateBackupCodes,
  disableMfa
} = require('../utils/mfa');

/**
 * Start a session: 15-minute access token in the body, 30-day refresh token in
 * an httpOnly cookie the client's JavaScript can never read.
 *
 * The access token used to last seven days and live in localStorage, which made
 * it worth stealing. Now it expires before most people finish a coffee, and the
 * thing that does last is unreadable by script.
 */
async function startSession(req, res, userId) {
  const session = await issueSession(userId, {
    userAgent: req.headers['user-agent'] || '',
    ip: req.headers['x-forwarded-for'] || req.ip || ''
  });
  setRefreshCookie(res, session.refreshToken);
  // The credential an <img> can send. Every other route uses the Authorization
  // header, which the browser cannot attach to an image request.
  setMediaCookie(res, userId);
  return session;
}

const VALID_GENDERS = ['male', 'female', 'non-binary', 'prefer-not-to-say'];

const publicUser = (row) => {
  const u = shapeUser(row);
  return {
    id: u.id,
    _id: u._id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    avatar: u.avatar,
    bio: u.bio,
    points: u.points,
    badges: u.badges,
    subscription: u.subscription,
    friends: u.friends,
    language: u.language,
    gender: u.gender,
    interests: u.interests,
    onboardingCompleted: u.onboardingCompleted,
    isCreator: u.isCreator,
    creatorInterest: u.creatorInterest,
    streakCount: u.streakCount,
    totalAnswers: u.totalAnswers,
    emailVerified: u.emailVerified,
    isActive: u.isActive,
    role: u.role
  };
};

const composeFullName = (firstName, middleName, lastName, fallbackName) => {
  const parts = [firstName, middleName, lastName].map((s) => (s || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  return (fallbackName || '').trim();
};

// POST /api/auth/register
router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const {
    name: rawName,
    firstName,
    middleName,
    lastName,
    email,
    phone,
    password,
    gender
  } = req.body;

  const name = composeFullName(
    sanitizeNamePart(firstName),
    sanitizeNamePart(middleName),
    sanitizeNamePart(lastName),
    sanitizeNamePart(rawName, 120)
  );
  if (!name || !email || !password) {
    return res.status(400).json({
      message: 'Please provide first name, last name, email and password'
    });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Please provide a valid email address' });
  }
  if (!isStrongPassword(password)) {
    return res.status(400).json({ message: 'Password must be 6–128 characters' });
  }
  if (!gender || !VALID_GENDERS.includes(gender)) {
    return res.status(400).json({ message: 'Please select your gender' });
  }

  const db = getSupabase();
  const { data: exists } = await db.from('users').select('id').eq('email', email.toLowerCase()).maybeSingle();
  if (exists) return res.status(400).json({ message: 'Email already registered' });

  const hashed = await hashPassword(password);
  const emailOtp = generateOTP();
  const { data: user, error } = await db.from('users').insert({
    name,
    email: email.toLowerCase().trim(),
    phone: sanitizeText(phone, 30),
    password: hashed,
    gender,
    interests: [],
    onboarding_completed: false,
    email_verified: false,
    email_otp: emailOtp,
    email_otp_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    is_active: true
  }).select().single();

  if (error) {
    console.error('register error:', error);
    if (error.message?.includes('column') || error.code === 'PGRST204') {
      return res.status(503).json({
        message: 'Database schema incomplete. Run server/db/migrations/001_setup_step_a.sql in Supabase SQL Editor.'
      });
    }
    if (error.code === '23505') {
      return res.status(400).json({ message: 'Email already registered' });
    }
    throw error;
  }

  await sendEmail(
    user.email,
    'Verify your Nexora email',
    `<div style="font-family:Arial;max-width:560px;margin:auto;padding:24px">
      <h2>Welcome to Nexora</h2>
      <p>Hi <strong>${user.name}</strong>, your verification code is:</p>
      <p style="font-size:28px;letter-spacing:6px;font-weight:700;color:#0866FF">${emailOtp}</p>
      <p>This code expires in 30 minutes.</p>
    </div>`
  );

  pushNotification(user.id, {
    type: 'welcome',
    title: 'Welcome to Nexora 🎉',
    body: 'Verify your email from Settings, then pick interests for a personalized feed.',
    link: '/settings'
  }).catch(() => {});

  const { accessToken } = await startSession(req, res, user.id);
  res.status(201).json({
    token: accessToken,
    user: publicUser(user),
    message: 'Account created. Check your email for a verification code.',
    ...(isDev() && { devEmailOtp: emailOtp })
  });
}, 'Could not create your account'));

// POST /api/auth/login
router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: 'Invalid email or password' });
  }

  let user, error;
  try {
    const result = await getSupabase()
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    user = result.data;
    error = result.error;
  } catch (dbErr) {
    return res.status(503).json({
      message: 'Database not configured. Set real SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env'
    });
  }

  if (error) {
    if (error.message?.includes('fetch failed') || error.message?.includes('ENOTFOUND')) {
      return res.status(503).json({
        message: 'Cannot reach Supabase. Check SUPABASE_URL in server/.env'
      });
    }
    throw error;
  }
  if (!user || !(await comparePassword(password, user.password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  if (user.is_active === false) {
    return res.status(403).json({ message: 'This account has been deactivated. Contact support.' });
  }

  /*
   * Second factor: stop here, before any session exists.
   *
   * The token returned carries typ 'mfa_pending', which middleware/auth.js
   * refuses. It is a receipt proving the password was correct and nothing
   * more — no refresh cookie is set, so an attacker who stops at this point
   * holds something that expires in five minutes and opens no route.
   */
  if (user.mfa_enabled) {
    return res.json({
      mfaRequired: true,
      mfaToken: signMfaPendingToken(user.id),
      // Named so the client can prompt for the right thing, without saying
      // anything a caller who reached here doesn't already know.
      methods: ['totp', 'backup_code']
    });
  }

  const { accessToken } = await startSession(req, res, user.id);
  res.json({ token: accessToken, user: publicUser(user) });
}, "Authentication failed"));

/**
 * POST /api/auth/refresh
 *
 * Takes nothing from the body — the token comes from the httpOnly cookie, which
 * is why it cannot be read or forged by page script.
 *
 * Deliberately not behind `protect`: the whole point is to be callable once the
 * access token has expired. It is also not behind authLimiter, because a client
 * refreshing every fifteen minutes is normal traffic, not a login attempt.
 */
router.post('/refresh', async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];
  if (!presented) {
    return res.status(401).json({ message: 'No refresh token' });
  }

  try {
    const { accessToken, refreshToken, userId } = await rotateRefreshToken(presented, {
      userAgent: req.headers['user-agent'] || '',
      ip: req.headers['x-forwarded-for'] || req.ip || ''
    });
    setRefreshCookie(res, refreshToken);
    // Renewed on rotation so it cannot lapse mid-session while the
    // access token keeps working.
    setMediaCookie(res, userId);
    res.json({ token: accessToken });
  } catch (err) {
    if (err instanceof RefreshError) {
      // Includes the reuse case, where rotateRefreshToken has already revoked
      // the family. Clear the cookie so the client stops retrying a token that
      // will never work again.
      clearRefreshCookie(res);
      clearMediaCookie(res);
      return res.status(401).json({
        message: err.reuse ? 'Session ended for security reasons. Please log in again.' : 'Session expired'
      });
    }
    sendError(res, err, req, 'Could not refresh your session');
  }
});

/**
 * POST /api/auth/logout
 *
 * Revokes the presented token only. `all: true` revokes every session for the
 * user — the "log out everywhere" case, which needs a valid access token
 * because it affects sessions beyond this one.
 */
router.post('/logout', asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];

  if (req.body?.all) {
    /*
     * The same validation protect uses, not a second hand-rolled one.
     *
     * This verified the token inline and skipped two checks the middleware
     * performs. It accepted typ: 'mfa_pending' -- issued after a correct
     * password but before the second factor -- so someone holding a stolen
     * password and blocked by MFA could still log the victim out of every
     * session, repeatedly. It also fell back to a hardcoded secret.
     *
     * Revoking every session is a bigger action than most routes take, so it
     * has no business accepting a weaker token than they do.
     */
    const result = verifyAccessToken(bearerToken(req));
    if (!result.ok) {
      return res.status(401).json({ message: 'Not authorized' });
    }
    await revokeFamily(result.decoded.id);
  } else {
    await revokeRefreshToken(presented);
  }

  clearRefreshCookie(res);
  clearMediaCookie(res);
  res.json({ message: 'Logged out' });
}, 'Could not log out'));

/* ============================================================
 * Two-factor authentication
 * ============================================================
 *
 * Enrolment is deliberately two steps. /mfa/setup mints a secret and stores it
 * with mfa_enabled still false; only /mfa/enable, after a code proves the
 * authenticator app actually holds that secret, flips the flag. Enabling on
 * setup would let anyone who mis-scanned the QR lock themselves out of their own
 * account with nothing to recover it with.
 */

/** A missing migration should name itself rather than surface as a 500. */
function rethrowNamingMigration(err) {
  const msg = err?.message || '';
  if (/mfa_|mfa_backup_codes/i.test(msg) && /column|schema cache|relation|does not exist/i.test(msg)) {
    throw new Error(
      'Database schema incomplete: the MFA columns are missing. ' +
      'Run server/db/migrations/010_mfa.sql in the Supabase SQL Editor.'
    );
  }
  throw err;
}

/** Six digits is a TOTP code; anything else is treated as a backup code. */
const looksLikeTotp = (code) => /^\d{6}$/.test(String(code || '').replace(/\s/g, ''));

/**
 * POST /api/auth/mfa/verify
 *
 * The second half of login. Takes the mfa_pending token from /login plus a code,
 * and only here does a session come into existence.
 *
 * Not behind `protect` — by definition the caller has no access token yet.
 * authLimiter applies because this is a login attempt, and the per-account
 * lockout in utils/mfa.js applies on top of it, since an IP-keyed limiter that
 * fails open is not enough to guard the last factor.
 */
router.post('/mfa/verify', authLimiter, asyncHandler(async (req, res) => {
  const { mfaToken, code } = req.body || {};

  const userId = verifyMfaPendingToken(mfaToken);
  if (!userId) {
    return res.status(401).json({ message: 'Verification expired. Please sign in again.' });
  }
  if (!code) {
    return res.status(400).json({ message: 'Enter the code from your authenticator app' });
  }

  const { data: user, error } = await getSupabase()
    .from('users').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;

  // A pending token outliving its account, or MFA switched off mid-flow.
  if (!user || !user.mfa_enabled) {
    return res.status(401).json({ message: 'Verification expired. Please sign in again.' });
  }
  if (user.is_active === false) {
    return res.status(403).json({ message: 'This account has been deactivated. Contact support.' });
  }

  const lockedFor = lockoutRemainingMs(user);
  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60000);
    return res.status(429).json({
      message: `Too many incorrect codes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      retryAfterSeconds: Math.ceil(lockedFor / 1000)
    });
  }

  const usedBackupCode = !looksLikeTotp(code);
  const ok = usedBackupCode
    ? await consumeBackupCode(user.id, code)
    : await verifyTotpForUser(user, code);

  if (!ok) {
    const { locked } = await recordFailedAttempt(user);
    // The count is not reported back. Telling an attacker how many tries
    // remain hands them the shape of the defence for free, and a real user
    // gets the same outcome either way: fix the code, or wait.
    return res.status(401).json({
      message: locked
        ? `Too many incorrect codes. Try again in ${MFA_LOCKOUT_MINUTES} minutes.`
        : 'That code is not valid'
    });
  }

  await clearFailedAttempts(user.id);
  const { accessToken } = await startSession(req, res, user.id);

  const remaining = usedBackupCode ? await countUnusedBackupCodes(user.id) : null;

  res.json({
    token: accessToken,
    user: publicUser(user),
    usedBackupCode,
    // Surfaced only when one was spent, so the client can nudge before the
    // last one is gone and the account becomes unrecoverable on a lost phone.
    backupCodesRemaining: remaining
  });
}, 'Verification failed'));

/** GET /api/auth/mfa/status — what the settings screen renders from. */
router.get('/mfa/status', protect, asyncHandler(async (req, res) => {
  const row = req.userRow;
  res.json({
    enabled: !!row.mfa_enabled,
    enabledAt: row.mfa_enabled_at || null,
    backupCodesRemaining: row.mfa_enabled ? await countUnusedBackupCodes(row.id) : 0
  });
}, 'Could not load two-factor status'));

/**
 * POST /api/auth/mfa/setup
 *
 * Mints a secret and returns it as a QR code plus the raw string, for anyone
 * enrolling on the same device they are reading the screen on, or using an app
 * that cannot scan.
 *
 * Re-runnable: calling it again discards the previous unconfirmed secret. That
 * is what makes an abandoned setup recoverable rather than a permanent snag.
 */
router.post('/mfa/setup', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const row = req.userRow;
  if (row.mfa_enabled) {
    return res.status(409).json({
      message: 'Two-factor is already on. Turn it off before setting it up again.'
    });
  }

  const { secret, uri } = await beginEnrolment(row.id, row.email).catch(rethrowNamingMigration);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' });

  res.json({ secret, uri, qr, digits: 6, period: 30 });
}, 'Could not start two-factor setup'));

/**
 * POST /api/auth/mfa/enable
 *
 * Confirms the app holds the secret, then turns MFA on and hands back the backup
 * codes. This is the only time those codes exist in readable form.
 */
router.post('/mfa/enable', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const row = req.userRow;
  const { code } = req.body || {};

  if (row.mfa_enabled) {
    return res.status(409).json({ message: 'Two-factor is already on' });
  }
  if (!row.mfa_secret) {
    return res.status(400).json({ message: 'Start setup first' });
  }
  if (!looksLikeTotp(code)) {
    return res.status(400).json({ message: 'Enter the 6-digit code from your app' });
  }

  if (!(await verifyTotpForUser(row, code))) {
    return res.status(401).json({
      message: 'That code is not valid. Check your phone\'s clock is set automatically.'
    });
  }

  const { error } = await getSupabase()
    .from('users')
    .update({ mfa_enabled: true, mfa_enabled_at: new Date().toISOString() })
    .eq('id', row.id);
  if (error) rethrowNamingMigration(error);

  const backupCodes = await regenerateBackupCodes(row.id);

  /*
   * Every other session ends here, and the caller gets a fresh one.
   *
   * People turn this on because they suspect their password is known. A
   * session opened with that password before MFA existed would otherwise keep
   * refreshing for thirty days, completely untouched by the factor just added.
   */
  await revokeFamily(row.id);
  const { accessToken } = await startSession(req, res, row.id);

  res.json({
    message: 'Two-factor authentication is on',
    token: accessToken,
    backupCodes
  });
}, 'Could not enable two-factor'));

/**
 * POST /api/auth/mfa/disable
 *
 * Requires the password *and* a current code. Requiring only the session would
 * mean a stolen access token could strip the protection off in one call, which
 * would make MFA decorative — the attacker turns it off and logs in freely
 * afterwards.
 */
router.post('/mfa/disable', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const row = req.userRow;
  const { password, code } = req.body || {};

  if (!row.mfa_enabled) {
    return res.status(409).json({ message: 'Two-factor is not on' });
  }
  if (!(await comparePassword(password, row.password))) {
    return res.status(401).json({ message: 'Password is incorrect' });
  }

  const lockedFor = lockoutRemainingMs(row);
  if (lockedFor > 0) {
    return res.status(429).json({
      message: `Too many incorrect codes. Try again in ${Math.ceil(lockedFor / 60000)} minutes.`
    });
  }

  // A backup code is accepted, because "lost my phone" is exactly when someone
  // needs to turn this off, and they have already proved the password.
  const ok = looksLikeTotp(code)
    ? await verifyTotpForUser(row, code)
    : await consumeBackupCode(row.id, code);

  if (!ok) {
    await recordFailedAttempt(row);
    return res.status(401).json({ message: 'That code is not valid' });
  }

  await disableMfa(row.id).catch(rethrowNamingMigration);
  await clearFailedAttempts(row.id);

  res.json({ message: 'Two-factor authentication is off' });
}, 'Could not disable two-factor'));

/**
 * POST /api/auth/mfa/backup-codes
 *
 * Issues a fresh set and invalidates the old one. Password required: the point
 * of these codes is that they bypass the second factor, so handing a new set to
 * whoever holds the session would route straight around it.
 */
router.post('/mfa/backup-codes', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const row = req.userRow;
  const { password } = req.body || {};

  if (!row.mfa_enabled) {
    return res.status(409).json({ message: 'Turn on two-factor first' });
  }
  if (!(await comparePassword(password, row.password))) {
    return res.status(401).json({ message: 'Password is incorrect' });
  }

  const backupCodes = await regenerateBackupCodes(row.id).catch(rethrowNamingMigration);

  res.json({
    message: 'New backup codes generated. The old ones no longer work.',
    backupCodes
  });
}, 'Could not generate backup codes'));

// GET /api/auth/me
router.get('/me', protect, asyncHandler(async (req, res) => {
  const db = getSupabase();
  const userId = req.user.id;

  /*
   * Also set here, and this is the one that matters for the rollout.
   *
   * Every session that existed before the media cookie shipped has none, so
   * their avatars would 401 until they happened to log in again. /me runs on
   * every app boot, so refreshing the page is enough -- nobody has to notice
   * anything, and nobody sees a page of broken images.
   *
   * Harmless to reissue: it is derived from the already-authenticated user, not
   * from anything the caller sent.
   */
  setMediaCookie(res, userId);

  let friends = [];
  const { data: links } = await db.from('friendships').select('friend_id').eq('user_id', userId);
  const ids = (links || []).map(l => l.friend_id);
  if (ids.length) {
    const { data: users } = await db.from('users').select(withMediaColumns('id, name, avatar, points, badges')).in('id', ids);
    friends = (users || []).map(f => ({
      _id: f.id, id: f.id, name: f.name, avatar: f.avatar, points: f.points, badges: f.badges || []
    }));
  }

  const { count: followCount } = await db
    .from('follows')
    .select('*', { count: 'exact', head: true })
    .eq('follower_id', userId);

  const user = shapeUser(req.userRow, { friends });
  user.followCount = followCount || 0;
  user.friendCount = friends.length;
  user.networkSize = friends.length + (followCount || 0);
  user.canPost = user.networkSize > 0;
  user.streakCount = req.userRow.streak_count || 0;
  res.json({ user });
}, "Authentication failed"));

// POST /api/auth/send-email-otp — resend verification
router.post('/send-email-otp', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const row = req.userRow;
  if (row.email_verified) {
    return res.json({ message: 'Email already verified', emailVerified: true });
  }
  const otp = generateOTP();
  const { error } = await getSupabase().from('users').update({
    email_otp: otp,
    email_otp_expire: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  }).eq('id', row.id);
  if (error) throw error;

  await sendEmail(
    row.email,
    'Nexora email verification code',
    `<p>Your verification code is <strong style="font-size:22px">${otp}</strong> (expires in 30 minutes).</p>`
  );

  res.json({
    message: 'Verification code sent to your email',
    ...(isDev() && { devEmailOtp: otp })
  });
}, "Authentication failed"));

// POST /api/auth/verify-email
router.post('/verify-email', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const otp = String(req.body.otp || '').trim();
  const row = req.userRow;
  if (row.email_verified) {
    return res.json({ message: 'Already verified', user: publicUser(row) });
  }
  if (!otp || otp !== String(row.email_otp || '')) {
    return res.status(400).json({ message: 'Invalid verification code' });
  }
  if (row.email_otp_expire && new Date(row.email_otp_expire) < new Date()) {
    return res.status(400).json({ message: 'Code expired. Request a new one.' });
  }

  const { data: user, error } = await getSupabase().from('users').update({
    email_verified: true,
    email_otp: '',
    email_otp_expire: null
  }).eq('id', row.id).select().single();
  if (error) throw error;

  res.json({ message: 'Email verified successfully', user: publicUser(user) });
}, "Authentication failed"));

// DELETE /api/auth/account — permanent delete (GDPR-style)
router.delete('/account', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') {
    return res.status(400).json({ message: 'Type confirm: "DELETE" to permanently remove your account' });
  }
  if (!password || !(await comparePassword(password, req.userRow.password))) {
    return res.status(401).json({ message: 'Password is incorrect' });
  }

  const userId = req.user.id;
  const db = getSupabase();

  // Best-effort cleanup of related rows (order matters for FKs if any)
  const cleanups = [
    () => db.from('notifications').delete().eq('user_id', userId),
    () => db.from('bookmarks').delete().eq('user_id', userId),
    () => db.from('blocks').delete().eq('blocker_id', userId),
    () => db.from('blocks').delete().eq('blocked_id', userId),
    () => db.from('follows').delete().eq('follower_id', userId),
    () => db.from('follows').delete().eq('following_id', userId),
    () => db.from('friendships').delete().eq('user_id', userId),
    () => db.from('friendships').delete().eq('friend_id', userId),
    () => db.from('friend_requests').delete().eq('from_user_id', userId),
    () => db.from('friend_requests').delete().eq('to_user_id', userId),
    () => db.from('post_likes').delete().eq('user_id', userId),
    () => db.from('post_comments').delete().eq('author_id', userId),
    () => db.from('posts').delete().eq('author_id', userId),
    () => db.from('answers').delete().eq('author_id', userId),
    () => db.from('questions').delete().eq('author_id', userId),
    () => db.from('reports').delete().eq('reporter_id', userId)
  ];

  /*
   * The dependent rows are best-effort. Every foreign key onto users is
   * ON DELETE CASCADE, so the row going away takes them regardless; sweeping
   * first just keeps the cascade small, and one failing step is not a reason to
   * refuse the deletion.
   */
  for (const fn of cleanups) {
    try { await fn(); } catch (e) { console.warn('account cleanup step:', e.message); }
  }

  /*
   * The users row is NOT best-effort, and it used to be.
   *
   * It was the last entry in the loop above, so its failure was swallowed like
   * any other step and the response said "Account deleted permanently" whether
   * or not the account still existed. Someone exercising a deletion right was
   * told it had happened when it had not.
   */
  const { error: deleteErr } = await db.from('users').delete().eq('id', userId);
  if (deleteErr) throw deleteErr;

  res.json({ message: 'Account deleted permanently' });
}, "Authentication failed"));

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, sensitiveLimiter, asyncHandler(async (req, res) => {
  const { email, phone } = req.body;
  const db = getSupabase();

  let query = db.from('users').select('*');
  if (email) query = query.eq('email', email.toLowerCase().trim());
  else if (phone) query = query.eq('phone', phone);
  else return res.status(400).json({ message: 'Provide email or phone' });

  const { data: user, error } = await query.maybeSingle();
  if (error) throw error;

  /*
   * One response for every input.
   *
   * This used to answer 404 "User not found" for an unknown address, 200 for
   * a known one, and 429 for a known one that had already reset today. Three
   * distinguishable answers make the endpoint an oracle: anyone can test an
   * email against it and learn whether that person has an account here, which
   * for a social platform is a membership disclosure, and everywhere else is
   * the first half of a credential-stuffing run.
   *
   * The work below is now conditional but the reply is not.
   *
   * Residual: a real address does bcrypt and an SMTP round-trip, so it takes
   * measurably longer than an unknown one. Closing that needs the send moved
   * off the request path; the obvious oracle is what is being removed here.
   */
  const genericReply = () => res.json({
    message: `If an account exists for that ${email ? 'email' : 'phone'}, a new password has been sent.`
  });

  if (!user) return genericReply();

  // Silently cap at one reset per day. The caller cannot tell this apart from
  // a successful send, which is the point.
  if (isToday(user.last_forgot_password_date) && (user.forgot_password_count_today || 0) >= 1) {
    return genericReply();
  }

  const newPassword = generatePassword(10);
  const hashed = await hashPassword(newPassword);
  const count = isToday(user.last_forgot_password_date)
    ? (user.forgot_password_count_today || 0) + 1
    : 1;

  const { error: upErr } = await db.from('users').update({
    password: hashed,
    forgot_password_count_today: count,
    last_forgot_password_date: new Date().toISOString()
  }).eq('id', user.id);

  if (upErr) throw upErr;

  // Recovery implies the account may already be in someone else's hands, so
  // every existing session goes with the old password. Unlike change-password
  // no replacement session is issued: the caller here is unauthenticated and
  // has to log in with the emailed password.
  await revokeFamily(user.id);

  await sendEmail(
    user.email,
    'Nexora - Your New Password',
    `
    <div style="font-family: Arial; max-width: 600px; margin: auto; background: #1a1a2e; color: #fff; padding: 30px; border-radius: 12px;">
      <h2 style="color: #6c63ff;">Your New Password</h2>
      <p>Hi <strong>${user.name}</strong>,</p>
      <p>Here is your new auto-generated password for Nexora:</p>
      <div style="background: #16213e; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
        <code style="font-size: 24px; color: #6c63ff; letter-spacing: 3px;">${newPassword}</code>
      </div>
      <p style="color: #aaa;">Please login and change your password immediately.</p>
    </div>
    `
  );

  if (isDev()) {
    return res.json({
      message: `If an account exists for that ${email ? 'email' : 'phone'}, a new password has been sent.`,
      devPassword: newPassword
    });
  }
  return genericReply();
}, "Authentication failed"));

// POST /api/auth/change-password
router.post('/change-password', protect, sensitiveLimiter, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const row = req.userRow;

  if (!(await comparePassword(currentPassword, row.password))) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({ message: 'New password must be 6–128 characters' });
  }

  const hashed = await hashPassword(newPassword);
  const { error } = await getSupabase().from('users').update({ password: hashed }).eq('id', row.id);
  if (error) throw error;

  /*
   * Changing a password ends every other session.
   *
   * People change passwords because they think someone else has one. Leaving
   * a stolen 30-day refresh token valid would make the change theatre — the
   * attacker keeps refreshing indefinitely and never needs the password
   * again. This was moot when tokens were unrevocable; now that they are not,
   * failing to revoke would be a choice.
   *
   * The caller is then re-issued a session so they are not logged out of the
   * device they just used.
   */
  await revokeFamily(row.id);
  const { accessToken } = await startSession(req, res, row.id);

  res.json({ message: 'Password changed successfully', token: accessToken });
}, "Authentication failed"));

// POST /api/auth/generate-password
router.post('/generate-password', (req, res) => {
  res.json({ password: generatePassword(12) });
});

/**
 * GET /api/auth/realtime-token
 *
 * Mints a short-lived Supabase-compatible JWT so the browser can open a
 * Realtime subscription to its own notifications.
 *
 * Nexora signs its own session tokens with JWT_SECRET, which Supabase knows
 * nothing about — so the app token can't authenticate a Realtime socket, and
 * `auth.uid()` is always null. This issues a second, narrowly-scoped token
 * signed with the project's SUPABASE_JWT_SECRET; the RLS policy in migration
 * 007 matches on its `sub` claim.
 *
 * Deliberately short-lived (1h) and carries no privileges beyond `authenticated`.
 * The service_role key is never exposed to the client.
 */
router.get('/realtime-token', protect, (req, res) => {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    return res.status(503).json({
      message: 'Realtime is not configured',
      hint: 'Set SUPABASE_JWT_SECRET (Supabase → Project Settings → API → JWT Secret)'
    });
  }

  const expiresIn = 60 * 60;
  const token = jwt.sign(
    {
      sub: req.user.id,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + expiresIn
    },
    secret
  );

  res.json({ token, expiresIn });
});

module.exports = router;
