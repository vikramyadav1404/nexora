const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const {
  hashPassword, comparePassword, shapeUser, isToday, computeBadges
} = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendEmail, generatePassword, generateOTP } = require('../utils/email');
const { pushNotification } = require('../db/features');
const { authLimiter, sensitiveLimiter } = require('../middleware/rateLimit');
const {
  isValidEmail, isStrongPassword, sanitizeNamePart, sanitizeText
} = require('../utils/validate');

const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'dev_insecure_jwt', { expiresIn: '7d' });

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
router.post('/register', authLimiter, async (req, res) => {
  try {
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

    const token = generateToken(user.id);
    res.status(201).json({
      token,
      user: publicUser(user),
      message: 'Account created. Check your email for a verification code.',
      ...(process.env.NODE_ENV !== 'production' && { devEmailOtp: emailOtp })
    });
  } catch (err) {
    console.error('register:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
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

    const token = generateToken(user.id);
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const userId = req.user.id;

    let friends = [];
    const { data: links } = await db.from('friendships').select('friend_id').eq('user_id', userId);
    const ids = (links || []).map(l => l.friend_id);
    if (ids.length) {
      const { data: users } = await db.from('users').select('id, name, avatar, points, badges').in('id', ids);
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/send-email-otp — resend verification
router.post('/send-email-otp', protect, sensitiveLimiter, async (req, res) => {
  try {
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
      ...(process.env.NODE_ENV !== 'production' && { devEmailOtp: otp })
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/verify-email
router.post('/verify-email', protect, sensitiveLimiter, async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/auth/account — permanent delete (GDPR-style)
router.delete('/account', protect, sensitiveLimiter, async (req, res) => {
  try {
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
      () => db.from('reports').delete().eq('reporter_id', userId),
      () => db.from('users').delete().eq('id', userId)
    ];
    for (const fn of cleanups) {
      try { await fn(); } catch (e) { console.warn('account cleanup step:', e.message); }
    }

    res.json({ message: 'Account deleted permanently' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', authLimiter, sensitiveLimiter, async (req, res) => {
  try {
    const { email, phone } = req.body;
    const db = getSupabase();

    let query = db.from('users').select('*');
    if (email) query = query.eq('email', email.toLowerCase().trim());
    else if (phone) query = query.eq('phone', phone);
    else return res.status(400).json({ message: 'Provide email or phone' });

    const { data: user, error } = await query.maybeSingle();
    if (error) throw error;
    if (!user) return res.status(404).json({ message: 'User not found with that email/phone' });

    if (isToday(user.last_forgot_password_date)) {
      if ((user.forgot_password_count_today || 0) >= 1) {
        return res.status(429).json({
          message: '⚠️ You have already requested a password reset today. Please try again tomorrow.',
          warning: true
        });
      }
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

    await sendEmail(
      user.email,
      'Nexora - Your New Password',
      `
      <div style="font-family: Arial; max-width: 600px; margin: auto; background: #1a1a2e; color: #fff; padding: 30px; border-radius: 12px;">
        <h2 style="color: #6c63ff;">🔐 Your New Password</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Here is your new auto-generated password for Nexora:</p>
        <div style="background: #16213e; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <code style="font-size: 24px; color: #6c63ff; letter-spacing: 3px;">${newPassword}</code>
        </div>
        <p style="color: #aaa;">Please login and change your password immediately.</p>
      </div>
      `
    );

    res.json({
      message: `✅ New password sent to your ${email ? 'email' : 'phone'}. Check your inbox!`,
      ...(process.env.NODE_ENV !== 'production' && { devPassword: newPassword })
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/change-password
router.post('/change-password', protect, sensitiveLimiter, async (req, res) => {
  try {
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

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/generate-password
router.post('/generate-password', (req, res) => {
  res.json({ password: generatePassword(12) });
});

module.exports = router;
