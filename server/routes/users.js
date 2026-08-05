const express = require('express');
const router = express.Router();
const { getSupabase } = require('../db/supabase');
const { shapeUser, shapeAuthor, withMediaColumns, mediaColumnsAvailable } = require('../db/helpers');
const { protect } = require('../middleware/auth');
const { sendEmail, generateOTP } = require('../utils/email');
const { INTERESTS, GENDERS, normalizeInterests } = require('../db/interests');
const { ensureInterestContent } = require('../db/seedInterests');
const { pushNotification, touchUserActivity } = require('../db/features');
const { sanitizeText, sanitizeNamePart, escapePostgrestValue } = require('../utils/validate');
const { sendError } = require('../utils/respond');
const { MediaError, verifyUpload, buildDerivatives, cleanupPrevious } = require('../utils/profileMedia');

async function getFriendIds(db, userId) {
  const { data } = await db.from('friendships').select('friend_id').eq('user_id', userId);
  return (data || []).map(r => r.friend_id);
}

async function getUsersByIds(db, ids) {
  if (!ids.length) return [];
  const { data } = await db.from('users').select(withMediaColumns('id, name, avatar, email, points, badges')).in('id', ids);
  return (data || []).map(u => ({
    _id: u.id,
    id: u.id,
    name: u.name,
    avatar: u.avatar,
    avatarUrl: u.avatar,
    avatarThumbUrl: u.avatar_thumb_url || u.avatar,
    email: u.email,
    points: u.points,
    badges: u.badges || []
  }));
}

// GET /api/users/search?q=
router.get('/search', protect, async (req, res) => {
  try {
    // Raw `q` used to be interpolated straight into the PostgREST .or() filter,
    // so a comma or dot in the query could inject extra filter terms.
    const q = escapePostgrestValue(req.query.q);
    if (!q || q.length < 2) return res.json({ users: [] });

    const db = getSupabase();
    const { data, error } = await db
      .from('users')
      .select(withMediaColumns('id, name, avatar, email, points, badges'))
      .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
      .neq('id', req.user.id)
      .limit(10);

    if (error) throw error;
    res.json({
      users: (data || []).map(u => ({
        _id: u.id, id: u.id, name: u.name, avatar: u.avatar,
        avatarUrl: u.avatar, avatarThumbUrl: u.avatar_thumb_url || u.avatar,
        email: u.email, points: u.points, badges: u.badges || []
      }))
    });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// GET /api/users/interests/catalog
router.get('/interests/catalog', protect, (req, res) => {
  res.json({ interests: INTERESTS, genders: GENDERS });
});

// POST /api/users/onboarding — save interests (+ optional gender), seed feed, auto-follow
router.post('/onboarding', protect, async (req, res) => {
  try {
    const { interests, gender } = req.body;
    const normalized = normalizeInterests(interests);

    if (normalized.length < 1) {
      return res.status(400).json({ message: 'Pick at least 1 interest' });
    }
    if (normalized.length > 8) {
      return res.status(400).json({ message: 'You can select up to 8 interests' });
    }

    const updates = {
      interests: normalized,
      onboarding_completed: true
    };

    const validGenders = ['male', 'female', 'non-binary', 'prefer-not-to-say'];
    if (gender && validGenders.includes(gender)) {
      updates.gender = gender;
    }

    const db = getSupabase();
    const { data: row, error } = await db
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    // Generate interest feed + auto-follow related creators
    const seed = await ensureInterestContent(req.user.id, normalized);

    res.json({
      message: 'Preferences saved! Your feed is ready.',
      user: shapeUser(row),
      seed
    });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// GET /api/users/suggestions — accounts matching interests
router.get('/suggestions', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const interests = req.userRow.interests || [];

    const { data: following } = await db
      .from('follows')
      .select('following_id')
      .eq('follower_id', req.user.id);
    const followingIds = new Set((following || []).map(f => f.following_id));
    followingIds.add(req.user.id);

    let query = db
      .from('users')
      .select(withMediaColumns('id, name, avatar, bio, points, badges, interests, is_creator, creator_interest', { cover: true }))
      .eq('is_active', true)
      .neq('id', req.user.id)
      .limit(40);

    // Prefer creators / users with overlapping interests
    if (interests.length) {
      query = query.or(
        `is_creator.eq.true,interests.ov.{${interests.join(',')}}`
      );
    } else {
      query = query.eq('is_creator', true);
    }

    const { data, error } = await query;
    if (error) throw error;

    const suggestions = (data || [])
      .filter(u => !followingIds.has(u.id))
      .slice(0, 12)
      .map(u => ({
        _id: u.id,
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        bio: u.bio,
        points: u.points,
        badges: u.badges || [],
        interests: u.interests || [],
        isCreator: !!u.is_creator,
        creatorInterest: u.creator_interest || '',
        isFollowing: false
      }));

    res.json({ suggestions });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/users/follow/:id
router.post('/follow/:id', protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.id) {
      return res.status(400).json({ message: 'You cannot follow yourself' });
    }

    const db = getSupabase();
    const { data: target } = await db.from('users').select('id, name').eq('id', targetId).maybeSingle();
    if (!target) return res.status(404).json({ message: 'User not found' });

    const { error } = await db.from('follows').upsert({
      follower_id: req.user.id,
      following_id: targetId
    }, { onConflict: 'follower_id,following_id' });

    if (error) throw error;

    pushNotification(targetId, {
      type: 'follow',
      title: `${req.user.name} started following you`,
      body: 'Say hello or check their profile.',
      link: `/profile/${req.user.id}`
    }).catch(() => {});

    try {
      await touchUserActivity(req.user.id, req.userRow, { metric: 'follows' });
    } catch (_) { /* ignore */ }

    res.json({ message: `You are now following ${target.name}`, following: true });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// DELETE /api/users/follow/:id
router.delete('/follow/:id', protect, async (req, res) => {
  try {
    await getSupabase()
      .from('follows')
      .delete()
      .eq('follower_id', req.user.id)
      .eq('following_id', req.params.id);
    res.json({ message: 'Unfollowed', following: false });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// GET /api/users/me/requests  (must be before /:id)
router.get('/me/requests', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data } = await db
      .from('friend_requests')
      .select('from_user_id')
      .eq('to_user_id', req.user.id);

    const ids = (data || []).map(r => r.from_user_id);
    const requests = await getUsersByIds(db, ids);
    res.json({ requests });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// GET /api/users/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const { data: row, error } = await db.from('users').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ message: 'User not found' });

    const friendIds = await getFriendIds(db, row.id);
    const friends = await getUsersByIds(db, friendIds);
    const user = shapeUser(row, { friends });
    res.json({ user });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

/**
 * PUT /api/users/profile — text fields only.
 *
 * This used to accept a multipart avatar and stream it through the API. That
 * path is gone: Vercel caps a serverless body at ~4.5MB, and images now go
 * browser → storage directly via /api/uploads/presign, then PATCH me/avatar.
 */
router.put('/profile', protect, async (req, res) => {
  try {
    // Without this, a stale multipart caller gets a cheerful 200 and no change:
    // express.json() ignores the body, so `updates` comes out empty. Failing
    // loudly is the difference between a five-second fix and an afternoon.
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      return res.status(415).json({
        message: 'Send JSON. Images now upload via POST /api/uploads/presign, then PATCH /api/users/me/avatar.'
      });
    }

    const { name, firstName, middleName, lastName, bio, phone } = req.body;
    const updates = {};
    const composed = [firstName, middleName, lastName]
      .map((s) => sanitizeNamePart(s))
      .filter(Boolean)
      .join(' ');
    if (composed) updates.name = composed;
    else if (name) updates.name = sanitizeNamePart(name, 120);
    if (bio !== undefined) updates.bio = sanitizeText(bio, 500);
    if (phone !== undefined) updates.phone = sanitizeText(phone, 30);

    const { data: row, error } = await getSupabase()
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ user: shapeUser(row) });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

/**
 * Profile media — attach and remove.
 *
 * The bytes never pass through here. The browser has already PUT the object to
 * a signed URL from POST /api/uploads/presign and sends us just the key; we
 * confirm it is ours, confirm it is really an image, then persist.
 */
const MEDIA_COLUMNS = {
  avatar: { url: 'avatar', key: 'avatar_key', extra: ['avatar_thumb_url'] },
  cover: { url: 'cover_url', key: 'cover_key', extra: [] }
};

async function attachMedia(req, res, kind) {
  try {
    if (!mediaColumnsAvailable()) {
      return res.status(503).json({ message: 'Image uploads are not enabled on this server yet.' });
    }
    const key = String(req.body?.key || '');
    const cols = MEDIA_COLUMNS[kind];
    const db = getSupabase();

    const { bucket } = await verifyUpload({ key, kind, userId: req.user.id });

    // Read the outgoing key before overwriting it, so the old object can be
    // cleaned up once the new one is safely saved.
    const { data: before } = await db
      .from('users')
      .select(cols.key)
      .eq('id', req.user.id)
      .single();
    const previousKey = before?.[cols.key] || '';

    const updates = await buildDerivatives({ bucket, key, kind });

    const { data: row, error } = await db
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    if (previousKey && previousKey !== key) {
      await cleanupPrevious({ kind, previousKey });
    }

    res.json({ user: shapeUser(row) });
  } catch (err) {
    if (err instanceof MediaError) {
      return res.status(err.status).json({ message: err.message });
    }
    sendError(res, err, req, `Could not update your ${kind}`);
  }
}

async function removeMedia(req, res, kind) {
  try {
    const cols = MEDIA_COLUMNS[kind];
    const db = getSupabase();

    const { data: before } = await db
      .from('users')
      .select(cols.key)
      .eq('id', req.user.id)
      .single();
    const previousKey = before?.[cols.key] || '';

    const updates = { [cols.url]: '', [cols.key]: '' };
    for (const col of cols.extra) updates[col] = '';

    const { data: row, error } = await db
      .from('users')
      .update(updates)
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    await cleanupPrevious({ kind, previousKey });

    res.json({ user: shapeUser(row) });
  } catch (err) { sendError(res, err, req, `Could not remove your ${kind}`); }
}

// PATCH /api/users/me/avatar   — body: { key }
router.patch('/me/avatar', protect, (req, res) => attachMedia(req, res, 'avatar'));

// DELETE /api/users/me/avatar
router.delete('/me/avatar', protect, (req, res) => removeMedia(req, res, 'avatar'));

// PATCH /api/users/me/cover    — body: { key }
router.patch('/me/cover', protect, (req, res) => attachMedia(req, res, 'cover'));

// DELETE /api/users/me/cover
router.delete('/me/cover', protect, (req, res) => removeMedia(req, res, 'cover'));

// POST /api/users/friend-request/:id
router.post('/friend-request/:id', protect, async (req, res) => {
  try {
    const targetId = req.params.id;
    const db = getSupabase();

    if (targetId === req.user.id) {
      return res.status(400).json({ message: 'You cannot add yourself' });
    }

    const { data: target } = await db.from('users').select('id, name').eq('id', targetId).maybeSingle();
    if (!target) return res.status(404).json({ message: 'User not found' });

    const { data: existingFriend } = await db
      .from('friendships')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('friend_id', targetId)
      .maybeSingle();
    if (existingFriend) return res.status(400).json({ message: 'Already friends' });

    const { data: existingReq } = await db
      .from('friend_requests')
      .select('*')
      .eq('from_user_id', req.user.id)
      .eq('to_user_id', targetId)
      .maybeSingle();

    if (!existingReq) {
      const { error } = await db.from('friend_requests').insert({
        from_user_id: req.user.id,
        to_user_id: targetId
      });
      if (error) throw error;

      pushNotification(targetId, {
        type: 'friend_request',
        title: `${req.user.name} sent you a friend request`,
        body: 'Open Settings to accept or decline.',
        link: '/settings'
      }).catch(() => {});
    }

    res.json({ message: `Friend request sent to ${target.name}` });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/users/accept-friend/:id
router.post('/accept-friend/:id', protect, async (req, res) => {
  try {
    const requesterId = req.params.id;
    const db = getSupabase();

    const { data: reqRow } = await db
      .from('friend_requests')
      .select('*')
      .eq('from_user_id', requesterId)
      .eq('to_user_id', req.user.id)
      .maybeSingle();

    if (!reqRow) return res.status(400).json({ message: 'No friend request from this user' });

    const { data: requester } = await db.from('users').select('name').eq('id', requesterId).maybeSingle();
    if (!requester) return res.status(404).json({ message: 'User not found' });

    // Bidirectional friendships
    await db.from('friendships').upsert([
      { user_id: req.user.id, friend_id: requesterId },
      { user_id: requesterId, friend_id: req.user.id }
    ]);

    await db.from('friend_requests')
      .delete()
      .eq('from_user_id', requesterId)
      .eq('to_user_id', req.user.id);

    pushNotification(requesterId, {
      type: 'friend_accept',
      title: `${req.user.name} accepted your friend request`,
      body: 'You are now friends on Nexora.',
      link: `/profile/${req.user.id}`
    }).catch(() => {});

    res.json({ message: `You and ${requester.name} are now friends!` });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/users/decline-friend/:id
router.post('/decline-friend/:id', protect, async (req, res) => {
  try {
    await getSupabase()
      .from('friend_requests')
      .delete()
      .eq('from_user_id', req.params.id)
      .eq('to_user_id', req.user.id);
    res.json({ message: 'Friend request declined' });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// DELETE /api/users/friend/:id
router.delete('/friend/:id', protect, async (req, res) => {
  try {
    const db = getSupabase();
    const friendId = req.params.id;
    await db.from('friendships').delete().eq('user_id', req.user.id).eq('friend_id', friendId);
    await db.from('friendships').delete().eq('user_id', friendId).eq('friend_id', req.user.id);
    res.json({ message: 'Friend removed' });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/users/language
router.post('/language', protect, async (req, res) => {
  try {
    const { language } = req.body;
    const validLangs = ['en', 'hi', 'es', 'pt', 'zh', 'fr'];
    if (!validLangs.includes(language)) return res.status(400).json({ message: 'Invalid language' });

    const user = req.userRow;
    if (user.language === language) return res.status(400).json({ message: 'Already using this language' });

    const otp = generateOTP();
    const { error } = await getSupabase().from('users').update({
      language_otp: otp,
      language_otp_expire: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      pending_language: language
    }).eq('id', user.id);
    if (error) throw error;

    if (language === 'fr') {
      await sendEmail(user.email, 'Nexora - Language Change Verification', `
        <div style="font-family:Arial; background:#1a1a2e; color:#fff; padding:30px; border-radius:12px; max-width:500px;">
          <h2 style="color:#6c63ff;">🌍 Language Change Verification</h2>
          <p>Your OTP is:</p>
          <div style="background:#16213e; padding:20px; text-align:center; border-radius:8px; font-size:32px; letter-spacing:8px; color:#6c63ff;">
            ${otp}
          </div>
        </div>
      `);
      const isMockEmail = !process.env.EMAIL_USER || process.env.EMAIL_USER === 'your_email@gmail.com';
      res.json({
        message: 'OTP sent to your email to verify French language switch',
        method: 'email',
        ...(isMockEmail ? { devOTP: otp } : {})
      });
    } else {
      // There is no real SMS provider wired up, so in dev we surface the code.
      // In production this must never leave the server — it previously did,
      // unconditionally, which made the OTP gate decorative.
      const isDev = process.env.NODE_ENV !== 'production';
      if (isDev) {
        console.log(`[mock sms] to ${user.phone || 'no-phone'} | otp ${otp}`);
      }
      res.json({
        message: 'OTP sent to your mobile number to verify language switch',
        method: 'sms',
        ...(isDev ? { devOTP: otp } : {})
      });
    }
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

// POST /api/users/verify-language-otp
router.post('/verify-language-otp', protect, async (req, res) => {
  try {
    const { otp } = req.body;
    const user = req.userRow;

    if (!user.language_otp || user.language_otp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }
    if (user.language_otp_expire && new Date() > new Date(user.language_otp_expire)) {
      return res.status(400).json({ message: 'OTP has expired. Please request again.' });
    }

    const { data, error } = await getSupabase().from('users').update({
      language: user.pending_language,
      language_otp: '',
      pending_language: '',
      language_otp_expire: null
    }).eq('id', user.id).select('language').single();

    if (error) throw error;
    res.json({ message: 'Language changed successfully!', language: data.language });
  } catch (err) { sendError(res, err, req, "Could not complete that request"); }
});

module.exports = router;
