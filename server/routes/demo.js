/**
 * Demo-mode API shim — activated when DEMO_MODE=true or Supabase is not configured.
 * Mounted over the same paths as the real API for local UI testing.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const {
  store, initDemoStore, shapeDemoUser, findUserByEmail, findUserById,
  listPosts, shapePost, INTERESTS, CHALLENGES,
  pushNotification, touchStreak, bumpChallenge, getAuthor
} = require('../db/demoStore');
const { normalizeInterests } = require('../db/interests');
const { randomUUID } = require('crypto');

const router = express.Router();

/**
 * Demo sessions mirror the real scheme so the client needs no special case:
 * a 15-minute access token plus a refresh cookie.
 *
 * The refresh side is deliberately thinner than the real one. There is no
 * database to store hashes in, so the cookie holds a signed JWT rather than an
 * opaque handle, and rotation issues a new one without a family to revoke.
 * Reuse detection is not reproducible without persistence — demo mode is for
 * exercising the UI, not the security properties, and the real tests cover
 * those against a real store.
 */
const DEMO_REFRESH_COOKIE = 'nexora_refresh';
const demoSecret = () => process.env.JWT_SECRET || 'demo_secret';

const generateToken = (id) =>
  jwt.sign({ id, typ: 'access' }, demoSecret(), {
    expiresIn: process.env.ACCESS_TOKEN_TTL || '15m'
  });

const generateDemoRefresh = (id) =>
  jwt.sign({ id, typ: 'refresh' }, demoSecret(), { expiresIn: '30d' });

function setDemoRefreshCookie(res, id) {
  res.cookie(DEMO_REFRESH_COOKIE, generateDemoRefresh(id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

const protectDemo = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'demo_secret');
    const user = findUserById(decoded.id);
    if (!user) {
      return res.status(401).json({
        message: 'Session expired or demo server restarted. Log in again: demo@nexora.com / demo1234'
      });
    }
    req.user = shapeDemoUser(user);
    // Handlers below reference `req.userRaw`; the real middleware calls the same
    // thing `req.userRow`. Expose both names (same object) so demo mode works.
    req.userRow = user;
    req.userRaw = user;
    next();
  } catch {
    return res.status(401).json({ message: 'Token invalid or expired' });
  }
};

// ── Auth ────────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  try {
    await initDemoStore();
    const { name: rawName, firstName, middleName, lastName, email, phone, password, gender } = req.body;
    const name = [firstName, middleName, lastName].map((s) => (s || '').trim()).filter(Boolean).join(' ')
      || (rawName || '').trim();
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide first name, last name, email and password' });
    }
    if (findUserByEmail(email)) {
      return res.status(400).json({ message: 'Email already registered' });
    }
    const id = randomUUID();
    const user = {
      id,
      name,
      email: email.toLowerCase().trim(),
      phone: phone || '',
      password: await bcrypt.hash(password, 10),
      gender: gender || 'prefer-not-to-say',
      interests: [],
      onboardingCompleted: false,
      language: 'en',
      avatar: '',
      bio: '',
      points: 0,
      badges: [],
      subscriptionPlan: 'free',
      friends: [],
      friendRequests: [],
      postsToday: 0,
      createdAt: new Date().toISOString()
    };
    store.users.set(id, user);
    const token = generateToken(id);
    setDemoRefreshCookie(res, id);
    res.status(201).json({ token, user: shapeDemoUser(user) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    await initDemoStore();
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }
    const user = findUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    const friendIds = user.friends || [];
    const friends = friendIds.map(id => {
      const u = findUserById(id);
      return u ? { _id: u.id, id: u.id, name: u.name, avatar: u.avatar, points: u.points } : { _id: id, id };
    });
    const token = generateToken(user.id);
    setDemoRefreshCookie(res, user.id);
    res.json({ token, user: shapeDemoUser(user, { friends }) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/auth/refresh', async (req, res) => {
  await initDemoStore();
  const presented = req.cookies?.[DEMO_REFRESH_COOKIE];
  if (!presented) return res.status(401).json({ message: 'No refresh token' });

  try {
    const decoded = jwt.verify(presented, demoSecret());
    if (decoded.typ !== 'refresh') throw new Error('wrong token type');
    if (!findUserById(decoded.id)) throw new Error('unknown user');

    setDemoRefreshCookie(res, decoded.id);
    res.json({ token: generateToken(decoded.id) });
  } catch {
    res.clearCookie(DEMO_REFRESH_COOKIE, { path: '/api/auth' });
    res.status(401).json({ message: 'Session expired' });
  }
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie(DEMO_REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ message: 'Logged out' });
});

router.get('/auth/me', protectDemo, async (req, res) => {
  const friendIds = req.userRaw.friends || [];
  const friends = friendIds.map(id => {
    const u = findUserById(id);
    return u
      ? { _id: u.id, id: u.id, name: u.name, avatar: u.avatar, points: u.points }
      : { _id: id, id };
  });
  res.json({ user: shapeDemoUser(req.userRaw, { friends }) });
});

router.post('/auth/generate-password', (req, res) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let pw = '';
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  res.json({ password: pw });
});

router.post('/auth/forgot-password', async (req, res) => {
  await initDemoStore();
  res.json({ message: 'Demo mode: use password demo1234 for demo@nexora.com', devPassword: 'demo1234' });
});

router.post('/auth/change-password', protectDemo, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!(await bcrypt.compare(currentPassword, req.userRaw.password))) {
    return res.status(401).json({ message: 'Current password is incorrect' });
  }
  req.userRaw.password = await bcrypt.hash(newPassword, 10);
  res.json({ message: 'Password changed successfully' });
});

// ── Posts ───────────────────────────────────────────────────
router.get('/posts', protectDemo, async (req, res) => {
  try {
  await initDemoStore();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const raw = req.userRaw || {};
  const interests = raw.interests || [];
  const following = store.follows.get(req.user?.id) || new Set();

  let posts = listPosts();
  posts = [...posts].sort((a, b) => {
    const score = (p) => {
      let s = 0;
      if (following.has(p.author_id)) s += 50;
      if ((p.interest_tags || []).some(t => interests.includes(t))) s += 30;
      return s;
    };
    return score(b) - score(a);
  });

  // Cursor pagination, matching the real route (routes/posts.js). The demo
  // store is an in-memory array, so the "cursor" is just the index after the
  // last id we handed out — but the wire contract is identical, which is the
  // point: the client cannot tell the two backends apart.
  const cursorId = req.query.cursor
    ? Buffer.from(String(req.query.cursor), 'base64url').toString('utf8')
    : null;

  const startAt = cursorId ? posts.findIndex(p => p.id === cursorId) + 1 : 0;
  const slice = posts.slice(startAt, startAt + limit);
  const hasMore = startAt + limit < posts.length;
  const last = slice[slice.length - 1];

  res.json({
    posts: slice.map(shapePost),
    nextCursor: hasMore && last ? Buffer.from(last.id).toString('base64url') : null,
    hasMore,
    personalized: interests.length > 0,
    interests
  });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Failed to load posts' });
  }
});

router.post('/posts', protectDemo, async (req, res) => {
  const content = req.body.content || '';
  if (!content.trim()) return res.status(400).json({ message: 'Post must have content or media' });
  const id = randomUUID();
  const post = {
    id,
    author_id: req.user.id,
    content,
    shares: 0,
    is_public: true,
    interest_tags: req.userRaw.interests?.slice(0, 2) || [],
    seed_key: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  store.posts.set(id, post);
  store.postLikes.set(id, new Set());
  store.postComments.set(id, []);
  req.userRaw.postsToday = (req.userRaw.postsToday || 0) + 1;
  touchStreak(req.userRaw);
  bumpChallenge(req.userRaw, 'posts');
  res.status(201).json({ post: shapePost(post), postsToday: req.userRaw.postsToday, postLimit: '∞' });
});

router.post('/posts/:id/like', protectDemo, async (req, res) => {
  const likes = store.postLikes.get(req.params.id) || new Set();
  const uid = req.user.id;
  let liked;
  if (likes.has(uid)) {
    likes.delete(uid);
    liked = false;
  } else {
    likes.add(uid);
    liked = true;
  }
  store.postLikes.set(req.params.id, likes);
  res.json({ likes: likes.size, liked });
});

router.post('/posts/:id/comment', protectDemo, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ message: 'Comment cannot be empty' });
  const list = store.postComments.get(req.params.id) || [];
  list.push({
    id: randomUUID(),
    author_id: req.user.id,
    content,
    created_at: new Date().toISOString()
  });
  store.postComments.set(req.params.id, list);
  const comments = list.map(c => ({
    _id: c.id,
    author: shapePost({ author_id: c.author_id, id: '', content: '' }).author,
    content: c.content,
    createdAt: c.created_at
  }));
  // fix author via getAuthor
  const { getAuthor } = require('../db/demoStore');
  res.json({
    comments: list.map(c => ({
      _id: c.id,
      author: getAuthor(c.author_id),
      content: c.content,
      createdAt: c.created_at
    }))
  });
});

router.post('/posts/:id/share', protectDemo, async (req, res) => {
  const post = store.posts.get(req.params.id);
  if (!post) return res.status(404).json({ message: 'Post not found' });
  post.shares = (post.shares || 0) + 1;
  res.json({ shares: post.shares });
});

router.delete('/posts/:id', protectDemo, async (req, res) => {
  const post = store.posts.get(req.params.id);
  if (!post) return res.status(404).json({ message: 'Post not found' });
  if (post.author_id !== req.user.id) return res.status(403).json({ message: 'Not authorized' });
  store.posts.delete(req.params.id);
  res.json({ message: 'Post deleted' });
});

// ── Users / onboarding ──────────────────────────────────────
router.get('/users/interests/catalog', protectDemo, (req, res) => {
  res.json({ interests: INTERESTS, genders: [] });
});

router.post('/users/onboarding', protectDemo, async (req, res) => {
  await initDemoStore();
  const normalized = normalizeInterests(req.body.interests || []);
  if (!normalized.length) return res.status(400).json({ message: 'Pick at least 1 interest' });

  req.userRaw.interests = normalized;
  req.userRaw.onboardingCompleted = true;
  if (req.body.gender) req.userRaw.gender = req.body.gender;

  // Auto-follow matching creators
  let followed = 0;
  for (const u of store.users.values()) {
    if (u.isCreator && normalized.includes(u.creatorInterest)) {
      if (!store.follows.has(req.user.id)) store.follows.set(req.user.id, new Set());
      store.follows.get(req.user.id).add(u.id);
      followed++;
    }
  }

  res.json({
    message: 'Preferences saved! Your feed is ready.',
    user: shapeDemoUser(req.userRaw),
    seed: { creatorsFollowed: followed, postsSeeded: 0 }
  });
});

router.get('/users/suggestions', protectDemo, async (req, res) => {
  await initDemoStore();
  const following = store.follows.get(req.user.id) || new Set();
  const interests = req.userRaw.interests || [];
  const suggestions = [];
  for (const u of store.users.values()) {
    if (u.id === req.user.id || following.has(u.id)) continue;
    if (u.isCreator || (u.interests || []).some(i => interests.includes(i))) {
      suggestions.push({
        _id: u.id,
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        bio: u.bio,
        points: u.points,
        badges: u.badges || [],
        interests: u.interests || [],
        isCreator: !!u.isCreator,
        creatorInterest: u.creatorInterest || '',
        isFollowing: false
      });
    }
    if (suggestions.length >= 12) break;
  }
  res.json({ suggestions });
});

router.post('/users/follow/:id', protectDemo, async (req, res) => {
  const target = findUserById(req.params.id);
  if (!target) return res.status(404).json({ message: 'User not found' });
  if (!store.follows.has(req.user.id)) store.follows.set(req.user.id, new Set());
  store.follows.get(req.user.id).add(req.params.id);
  touchStreak(req.userRaw);
  bumpChallenge(req.userRaw, 'follows');
  pushNotification(req.params.id, {
    type: 'follow',
    title: 'New follower',
    body: `${req.user.name} started following you`,
    link: `/profile/${req.user.id}`
  });
  res.json({ message: `You are now following ${target.name}`, following: true });
});

router.delete('/users/follow/:id', protectDemo, async (req, res) => {
  store.follows.get(req.user.id)?.delete(req.params.id);
  res.json({ message: 'Unfollowed', following: false });
});

router.get('/users/search', protectDemo, async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (q.length < 2) return res.json({ users: [] });
  const users = [...store.users.values()]
    .filter(u => u.id !== req.user.id && (u.name.toLowerCase().includes(q) || u.email.includes(q)))
    .slice(0, 10)
    .map(u => shapeDemoUser(u));
  res.json({ users });
});

router.get('/users/me/requests', protectDemo, (req, res) => {
  res.json({ requests: [] });
});

router.get('/users/:id', protectDemo, async (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ message: 'User not found' });
  res.json({ user: shapeDemoUser(u, { friends: [] }) });
});

router.put('/users/profile', protectDemo, async (req, res) => {
  // Mirrors the real route: multipart is refused rather than silently ignored.
  if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    return res.status(415).json({
      message: 'Send JSON. Images now upload via POST /api/uploads/presign, then PATCH /api/users/me/avatar.'
    });
  }

  const { name, firstName, middleName, lastName, bio, phone } = req.body;
  const composed = [firstName, middleName, lastName].map((s) => (s || '').trim()).filter(Boolean).join(' ');
  if (composed) req.userRaw.name = composed;
  else if (name) req.userRaw.name = String(name).trim();
  if (bio !== undefined) req.userRaw.bio = bio;
  if (phone !== undefined) req.userRaw.phone = phone;
  res.json({ user: shapeDemoUser(req.userRaw) });
});

/**
 * Profile media, demo edition.
 *
 * There is no object storage in demo mode, so presign hands back a `data:` URL
 * sink instead of a signed PUT target and the client short-circuits the upload.
 * The endpoints, request shapes and response shapes match the real API exactly,
 * which is the whole point — the frontend cannot tell the difference.
 */
router.post('/uploads/presign', protectDemo, (req, res) => {
  const kind = String(req.body?.kind || '').toLowerCase();
  const mimeType = String(req.body?.mimeType || '').toLowerCase();

  if (!['avatar', 'cover'].includes(kind)) {
    return res.status(400).json({ message: 'kind must be one of: avatar, cover' });
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    return res.status(400).json({ message: 'Unsupported image type. Use image/jpeg, image/png, image/webp.' });
  }

  res.json({
    key: `users/${req.user.id}/${kind}/${randomUUID()}.webp`,
    bucket: kind === 'avatar' ? 'avatars' : 'covers',
    signedUrl: '',
    token: '',
    expiresIn: 300,
    contentType: mimeType,
    demo: true
  });
});

function attachDemoMedia(req, res, kind) {
  const key = String(req.body?.key || '');
  if (!key.startsWith(`users/${req.user.id}/${kind}/`)) {
    return res.status(403).json({ message: 'That upload does not belong to you' });
  }
  // The client sends the cropped data URL alongside the key in demo mode; there
  // is nowhere else for the bytes to live.
  const dataUrl = String(req.body?.dataUrl || '');
  if (kind === 'avatar') req.userRaw.avatar = dataUrl;
  else req.userRaw.coverUrl = dataUrl;
  res.json({ user: shapeDemoUser(req.userRaw) });
}

router.patch('/users/me/avatar', protectDemo, (req, res) => attachDemoMedia(req, res, 'avatar'));
router.patch('/users/me/cover', protectDemo, (req, res) => attachDemoMedia(req, res, 'cover'));

router.delete('/users/me/avatar', protectDemo, (req, res) => {
  req.userRaw.avatar = '';
  res.json({ user: shapeDemoUser(req.userRaw) });
});

router.delete('/users/me/cover', protectDemo, (req, res) => {
  req.userRaw.coverUrl = '';
  res.json({ user: shapeDemoUser(req.userRaw) });
});

// ── Questions (demo store) ──────────────────────────────────
function shapeQuestion(q) {
  return {
    _id: q.id,
    id: q.id,
    title: q.title,
    body: q.body,
    tags: q.tags || [],
    author: getAuthor(q.author_id),
    upvotes: q.upvotes || [],
    downvotes: q.downvotes || [],
    answers: (q.answers || []).map(a => ({
      _id: a.id,
      body: a.body,
      author: getAuthor(a.author_id),
      upvotes: a.upvotes || [],
      downvotes: a.downvotes || [],
      isAccepted: !!a.isAccepted,
      createdAt: a.createdAt
    })),
    views: q.views || 0,
    isResolved: !!q.isResolved,
    interest: q.interest || '',
    createdAt: q.createdAt
  };
}

router.get('/questions', protectDemo, async (req, res) => {
  await initDemoStore();
  let list = [...store.questions.values()];
  const search = (req.query.search || '').toLowerCase();
  if (search) {
    list = list.filter(q =>
      q.title.toLowerCase().includes(search) || q.body.toLowerCase().includes(search)
    );
  }
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({
    questions: list.map(q => shapeQuestion(q)),
    total: list.length,
    pages: 1
  });
});

router.post('/questions', protectDemo, async (req, res) => {
  await initDemoStore();
  const id = randomUUID();
  const tags = req.body.tags
    ? (Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags).split(',').map(t => t.trim()).filter(Boolean))
    : [];
  const q = {
    id,
    author_id: req.user.id,
    title: req.body.title,
    body: req.body.body,
    tags,
    interest: tags[0] || (req.userRaw.interests || [])[0] || 'technology',
    upvotes: [],
    downvotes: [],
    answers: [],
    views: 0,
    isResolved: false,
    createdAt: new Date().toISOString()
  };
  store.questions.set(id, q);
  touchStreak(req.userRaw);
  pushNotification(req.user.id, {
    type: 'question',
    title: 'Question posted',
    body: q.title,
    link: `/qa/${id}`
  });
  res.status(201).json({ question: shapeQuestion(q) });
});

router.get('/questions/:id', protectDemo, async (req, res) => {
  await initDemoStore();
  const q = store.questions.get(req.params.id);
  if (!q) return res.status(404).json({ message: 'Question not found' });
  q.views = (q.views || 0) + 1;
  res.json({ question: shapeQuestion(q) });
});

router.post('/answers/:questionId', protectDemo, async (req, res) => {
  await initDemoStore();
  const q = store.questions.get(req.params.questionId);
  if (!q) return res.status(404).json({ message: 'Question not found' });
  if (!req.body.body) return res.status(400).json({ message: 'Answer body is required' });
  const answer = {
    id: randomUUID(),
    body: req.body.body,
    author_id: req.user.id,
    upvotes: [],
    downvotes: [],
    isAccepted: false,
    createdAt: new Date().toISOString()
  };
  q.answers = q.answers || [];
  q.answers.push(answer);
  req.userRaw.points = (req.userRaw.points || 0) + 5;
  req.userRaw.totalAnswers = (req.userRaw.totalAnswers || 0) + 1;
  touchStreak(req.userRaw);
  bumpChallenge(req.userRaw, 'answers');
  if (q.author_id !== req.user.id) {
    pushNotification(q.author_id, {
      type: 'answer',
      title: 'New answer on your question',
      body: q.title,
      link: `/qa/${q.id}`
    });
  }
  res.status(201).json({
    answer: {
      _id: answer.id,
      body: answer.body,
      author: getAuthor(req.user.id),
      upvotes: [],
      downvotes: [],
      isAccepted: false,
      createdAt: answer.createdAt
    },
    pointsEarned: 5
  });
});

router.get('/rewards/leaderboard', protectDemo, async (req, res) => {
  await initDemoStore();
  const leaderboard = [...store.users.values()]
    .filter(u => !u.isCreator || true)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 20)
    .map(u => ({
      _id: u.id, id: u.id, name: u.name, avatar: u.avatar,
      points: u.points, badges: u.badges || [], totalAnswers: u.totalAnswers || 0
    }));
  res.json({ leaderboard });
});

router.get('/rewards/transfers', protectDemo, (req, res) => {
  res.json({ transfers: [] });
});

router.post('/rewards/transfer', protectDemo, (req, res) => {
  res.status(400).json({ message: 'Point transfer is limited in demo mode' });
});

router.get('/subscriptions/plans', (req, res) => {
  res.json({
    plans: {
      bronze: { price: 10000, name: 'Bronze', description: '5 questions/day' },
      silver: { price: 30000, name: 'Silver', description: '10 questions/day' },
      gold: { price: 100000, name: 'Gold', description: 'Unlimited questions/day' }
    },
    windowOpen: true
  });
});

router.get('/subscriptions/history', protectDemo, (req, res) => {
  res.json({ transactions: [] });
});

router.post('/subscriptions/create-order', protectDemo, (req, res) => {
  res.json({
    orderId: `order_demo_${Date.now()}`,
    amount: 10000,
    currency: 'INR',
    plan: req.body.plan || 'bronze',
    transactionId: randomUUID(),
    keyId: 'rzp_test_mock',
    isMock: true
  });
});

router.post('/subscriptions/verify-payment', protectDemo, (req, res) => {
  req.userRaw.subscriptionPlan = req.body.plan || 'bronze';
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  req.userRaw.subscriptionExpiresAt = expires.toISOString();
  res.json({
    message: 'Payment verified! Subscription activated. (Demo)',
    subscription: { plan: req.userRaw.subscriptionPlan, expiresAt: req.userRaw.subscriptionExpiresAt }
  });
});

// Mirrors POST /api/subscriptions/cancel. No conditional update here: the demo
// store is a single in-process object mutated synchronously, so there is no
// read-then-write window for two callers to race through.
router.post('/subscriptions/cancel', protectDemo, (req, res) => {
  const plan = req.userRaw.subscriptionPlan || 'free';
  const expires = req.userRaw.subscriptionExpiresAt;
  const expired = expires && new Date() > new Date(expires);

  if (plan === 'free' || expired) {
    return res.status(400).json({ message: 'You are not on a paid plan' });
  }

  const daysForfeited = expires
    ? Math.max(0, Math.ceil((new Date(expires) - Date.now()) / 86400000))
    : 0;

  req.userRaw.subscriptionPlan = 'free';
  req.userRaw.subscriptionExpiresAt = null;

  res.json({
    message: 'Subscription cancelled. You are back on the free plan. (Demo)',
    subscription: { plan: 'free', expiresAt: null },
    cancelledPlan: plan,
    daysForfeited
  });
});

// ── Notifications ───────────────────────────────────────────
router.get('/notifications', protectDemo, async (req, res) => {
  await initDemoStore();
  const list = store.notifications
    .filter(n => n.userId === req.user.id)
    .map(n => ({
      _id: n.id, id: n.id, type: n.type, title: n.title, body: n.body,
      link: n.link, read: n.read, createdAt: n.createdAt
    }));
  const unread = list.filter(n => !n.read).length;
  res.json({ notifications: list, unread });
});

router.post('/notifications/read-all', protectDemo, async (req, res) => {
  store.notifications.forEach(n => {
    if (n.userId === req.user.id) n.read = true;
  });
  res.json({ message: 'All marked as read' });
});

router.post('/notifications/:id/read', protectDemo, async (req, res) => {
  const n = store.notifications.find(x => x.id === req.params.id && x.userId === req.user.id);
  if (n) n.read = true;
  res.json({ message: 'ok' });
});

// ── Global search ───────────────────────────────────────────
router.get('/search', protectDemo, async (req, res) => {
  await initDemoStore();
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) {
    return res.json({ people: [], posts: [], questions: [], spaces: [] });
  }
  const blocked = store.blocks.get(req.user.id) || new Set();
  const people = [...store.users.values()]
    .filter(u => u.id !== req.user.id && !blocked.has(u.id))
    .filter(u => u.name.toLowerCase().includes(q) || u.email.includes(q) || (u.interests || []).some(i => i.includes(q)))
    .slice(0, 10)
    .map(u => shapeDemoUser(u));
  const posts = listPosts()
    .filter(p => (p.content || '').toLowerCase().includes(q))
    .slice(0, 10)
    .map(shapePost);
  const questions = [...store.questions.values()]
    .filter(x => x.title.toLowerCase().includes(q) || x.body.toLowerCase().includes(q))
    .slice(0, 10)
    .map(shapeQuestion);
  const spaces = INTERESTS.filter(i =>
    i.id.includes(q) || i.label.toLowerCase().includes(q)
  );
  res.json({ people, posts, questions, spaces, query: q });
});

// ── Bookmarks ───────────────────────────────────────────────
router.get('/bookmarks', protectDemo, async (req, res) => {
  await initDemoStore();
  const list = store.bookmarks.get(req.user.id) || [];
  const enriched = list.map(b => {
    if (b.type === 'post') {
      const p = store.posts.get(b.id);
      return { ...b, item: p ? shapePost(p) : null };
    }
    if (b.type === 'question') {
      const q = store.questions.get(b.id);
      return { ...b, item: q ? shapeQuestion(q) : null };
    }
    return b;
  }).filter(b => b.item);
  res.json({ bookmarks: enriched });
});

router.post('/bookmarks', protectDemo, async (req, res) => {
  const { type, id } = req.body;
  if (!type || !id || !['post', 'question'].includes(type)) {
    return res.status(400).json({ message: 'type and id required' });
  }
  if (!store.bookmarks.has(req.user.id)) store.bookmarks.set(req.user.id, []);
  const list = store.bookmarks.get(req.user.id);
  if (!list.find(b => b.type === type && b.id === id)) {
    list.unshift({ type, id, createdAt: new Date().toISOString() });
  }
  res.json({ message: 'Saved', bookmarked: true });
});

router.delete('/bookmarks', protectDemo, async (req, res) => {
  const { type, id } = req.body;
  const list = store.bookmarks.get(req.user.id) || [];
  store.bookmarks.set(req.user.id, list.filter(b => !(b.type === type && b.id === id)));
  res.json({ message: 'Removed', bookmarked: false });
});

// ── Safety: block + report ──────────────────────────────────
router.post('/blocks/:id', protectDemo, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ message: 'Cannot block yourself' });
  if (!store.blocks.has(req.user.id)) store.blocks.set(req.user.id, new Set());
  store.blocks.get(req.user.id).add(req.params.id);
  res.json({ message: 'User blocked', blocked: true });
});

router.delete('/blocks/:id', protectDemo, async (req, res) => {
  store.blocks.get(req.user.id)?.delete(req.params.id);
  res.json({ message: 'User unblocked', blocked: false });
});

router.get('/blocks', protectDemo, async (req, res) => {
  const ids = [...(store.blocks.get(req.user.id) || [])];
  const users = ids.map(id => {
    const u = findUserById(id);
    return u ? shapeDemoUser(u) : { id, name: 'Unknown' };
  });
  res.json({ blocks: users });
});

router.post('/reports', protectDemo, async (req, res) => {
  const { targetType, targetId, reason, details } = req.body;
  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ message: 'targetType, targetId, and reason required' });
  }
  store.reports.push({
    id: randomUUID(),
    reporterId: req.user.id,
    targetType,
    targetId,
    reason,
    details: details || '',
    status: 'open',
    createdAt: new Date().toISOString()
  });
  res.status(201).json({ message: 'Report submitted. Our team will review it.' });
});

// ── Spaces (interest communities) ───────────────────────────
router.get('/spaces', protectDemo, async (req, res) => {
  await initDemoStore();
  const spaces = INTERESTS.map(i => {
    const postCount = listPosts().filter(p => (p.interest_tags || []).includes(i.id)).length;
    const qCount = [...store.questions.values()].filter(q =>
      q.interest === i.id || (q.tags || []).includes(i.id)
    ).length;
    const memberCount = [...store.users.values()].filter(u =>
      (u.interests || []).includes(i.id) || u.creatorInterest === i.id
    ).length;
    return { ...i, postCount, questionCount: qCount, memberCount };
  });
  res.json({ spaces });
});

router.get('/spaces/:id', protectDemo, async (req, res) => {
  await initDemoStore();
  const space = INTERESTS.find(i => i.id === req.params.id);
  if (!space) return res.status(404).json({ message: 'Space not found' });
  const posts = listPosts()
    .filter(p => (p.interest_tags || []).includes(space.id))
    .slice(0, 20)
    .map(shapePost);
  const questions = [...store.questions.values()]
    .filter(q => q.interest === space.id || (q.tags || []).includes(space.id))
    .map(shapeQuestion);
  const members = [...store.users.values()]
    .filter(u => (u.interests || []).includes(space.id) || u.creatorInterest === space.id)
    .slice(0, 20)
    .map(u => shapeDemoUser(u));
  res.json({ space, posts, questions, members });
});

// ── Challenges & streaks ────────────────────────────────────
router.get('/challenges', protectDemo, async (req, res) => {
  try {
    await initDemoStore();
    const raw = req.userRaw || findUserById(req.user?.id) || {};
    if (!raw.challengeProgress) raw.challengeProgress = {};
    const progress = raw.challengeProgress;
    const streak = raw.streakCount || 0;
    const list = (CHALLENGES || []).map(c => {
      const current = c.metric === 'streak' ? streak : (progress[c.metric] || 0);
      return {
        ...c,
        current: Math.min(current, c.goal),
        completed: current >= c.goal,
        percent: Math.min(100, Math.round((current / c.goal) * 100))
      };
    });
    res.json({
      challenges: list,
      streak: {
        count: streak,
        lastActivityDate: raw.lastActivityDate || null
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/challenges/check-in', protectDemo, async (req, res) => {
  try {
    await initDemoStore();
    const raw = req.userRaw || findUserById(req.user?.id);
    if (!raw) return res.status(401).json({ message: 'User not found' });
    if (!raw.challengeProgress) raw.challengeProgress = {};
    touchStreak(raw);
    raw.challengeProgress.streak = raw.streakCount || 0;
    pushNotification(raw.id, {
      type: 'streak',
      title: `🔥 ${raw.streakCount}-day streak!`,
      body: 'Keep showing up. Consistency builds reputation.',
      link: '/challenges'
    });
    res.json({
      message: 'Checked in',
      streakCount: raw.streakCount,
      user: shapeDemoUser(raw)
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── AI assist (local draft helper — no external API) ────────
router.post('/ai/draft-answer', protectDemo, async (req, res) => {
  const { title = '', body = '', tone = 'helpful' } = req.body;
  const topic = title || 'this topic';
  const draft =
    `Here's a practical take on **${topic}**:\n\n` +
    `1. **Clarify the goal** — ${body ? 'Based on what you described, ' : ''}` +
    `start by restating the problem in one sentence so answers stay focused.\n` +
    `2. **Try the simplest fix first** — check inputs, edge cases, and recent changes before complex refactors.\n` +
    `3. **Share a minimal example** — a short snippet or steps to reproduce helps the community help you faster.\n` +
    `4. **Next steps** — if that doesn't work, compare against a known-good baseline and isolate what differs.\n\n` +
    `Happy to refine this if you share more details (errors, versions, what you already tried).`;
  res.json({
    draft,
    tone,
    note: 'Local AI-style draft (no external model). Edit before posting.'
  });
});

router.post('/ai/draft-question', protectDemo, async (req, res) => {
  const { topic = '', details = '' } = req.body;
  const title = topic
    ? `How do I ${topic.trim().replace(/\?$/, '')}?`
    : 'How should I approach this problem?';
  const body =
    `### What I'm trying to do\n${details || 'Describe your goal here.'}\n\n` +
    `### What I've tried\n- \n\n` +
    `### Expected vs actual\n- Expected:\n- Actual:\n\n` +
    `### Environment\n- Stack / versions:\n`;
  res.json({ title, body, note: 'Structured question draft — edit before posting.' });
});

// ── Digests (in-app weekly summary) ─────────────────────────
router.get('/digests/weekly', protectDemo, async (req, res) => {
  try {
    await initDemoStore();
    const raw = req.userRaw || findUserById(req.user?.id) || {};
    const interests = raw.interests || [];
    const topPosts = listPosts()
      .filter(p => (p.interest_tags || []).some(t => interests.includes(t)))
      .slice(0, 5)
      .map(shapePost);
    const topQs = [...store.questions.values()]
      .filter(q => interests.includes(q.interest) || (q.tags || []).some(t => interests.includes(t)))
      .slice(0, 5)
      .map(shapeQuestion);
    res.json({
      title: 'Your weekly Nexora digest',
      interests,
      streak: raw.streakCount || 0,
      topPosts,
      topQuestions: topQs,
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Catch-all
router.use((req, res) => {
  res.status(501).json({
    message: `Demo mode: ${req.method} ${req.originalUrl} is not implemented yet.`
  });
});

module.exports = router;
