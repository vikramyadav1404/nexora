const bcrypt = require('bcryptjs');
const { passwordCost } = require('../utils/bcryptCost');

/**
 * Migration 008 adds avatar_thumb_url and cover_url.
 *
 * PostgREST rejects an entire query when any selected column is missing, so
 * naming them unconditionally means a deploy that lands before the migration
 * has run returns 500 from the feed, the leaderboard, search, suggestions and
 * every author lookup simultaneously. index.js probes for the columns once at
 * boot; until it confirms them we select the pre-008 list, and shapeUser falls
 * back to the full-size avatar for avatarThumbUrl.
 *
 * Optimistic default is false: a probe that never ran must not break the app.
 */
let hasMediaColumns = false;

function setMediaColumnSupport(supported) {
  hasMediaColumns = !!supported;
}

function mediaColumnsAvailable() {
  return hasMediaColumns;
}

/** Append the 008 columns to an explicit select list, when they exist. */
function withMediaColumns(fields, { cover = false } = {}) {
  if (!hasMediaColumns) return fields;
  return `${fields}, avatar_thumb_url${cover ? ', cover_url' : ''}`;
}

// fields we usually join onto posts/comments
const AUTHOR_FIELDS_BASE =
  'id, name, avatar, points, badges, subscription_plan, subscription_expires_at';

/** Call this rather than referencing a constant — the list is boot-dependent. */
function authorFields() {
  return withMediaColumns(AUTHOR_FIELDS_BASE);
}

// /uploads/... needs a full host when frontend and API are on different domains
function publicAssetUrl(url) {
  if (!url || typeof url !== 'string') return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
  const base = (
    process.env.PUBLIC_API_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ''
  ).replace(/\/$/, '');
  if (base && url.startsWith('/')) return base + url;
  return url;
}

function isToday(date) {
  if (!date) return false;
  const d = new Date(date);
  const now = new Date();
  return (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  );
}

function computeBadges(points = 0, totalAnswers = 0) {
  const badges = [];
  if (points >= 50) badges.push('bronze');
  if (points >= 200) badges.push('silver');
  if (points >= 500) badges.push('gold');
  if (totalAnswers >= 10) badges.push('contributor');
  if (totalAnswers >= 50) badges.push('expert');
  return badges;
}

function getActivePlan(user) {
  const plan = user.subscription_plan || user.subscription?.plan || 'free';
  if (plan === 'free') return 'free';
  const expires = user.subscription_expires_at || user.subscription?.expiresAt;
  if (expires && new Date() > new Date(expires)) return 'free';
  return plan;
}

function getDailyQuestionLimit(user) {
  const plan = getActivePlan(user);
  const limits = { free: 1, bronze: 5, silver: 10, gold: Infinity };
  return limits[plan] ?? 1;
}

function getDailyPostLimit(friendCount) {
  if (friendCount === 0) return 0;
  if (friendCount === 1) return 1;
  if (friendCount < 10) return 2;
  return Infinity;
}

async function hashPassword(password) {
  return bcrypt.hash(password, passwordCost());
}

async function comparePassword(plain, hash) {
  if (!plain || !hash || typeof hash !== 'string') return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Split a vote table into upvoter and downvoter id lists.
 *
 * Lived in both questions.js and answers.js -- answers.js held a copy with
 * 'answer_votes' and 'answer_id' hardcoded, so the two could drift while
 * looking identical. The generic form covers both callers.
 */
async function getVoteLists(db, table, idCol, id) {
  const { data } = await db.from(table).select('user_id, vote_type').eq(idCol, id);
  const upvotes = [];
  const downvotes = [];
  (data || []).forEach(v => {
    if (v.vote_type === 'up') upvotes.push(v.user_id);
    else downvotes.push(v.user_id);
  });
  return { upvotes, downvotes };
}

/**
 * The lightweight person shape used by friend lists, suggestions and people
 * search -- distinct from shapeUser, which is the full self/profile payload.
 *
 * getUsersByIds and the people-search mapper each built this object literal
 * separately and identically, so a field added to one silently produced two
 * different shapes on endpoints the same page consumes.
 *
 * It is also the shape to reach for whenever a list of OTHER people is being
 * returned. shapeUser carries email, phone and role -- correct for the caller's
 * own record and for an admin listing, and wrong for the member list of a
 * Space, which handed every member's email and phone to any logged-in user who
 * asked.
 */
/**
 * @deprecated Use `publicUser` from db/serialize.js.
 *
 * Kept only so nothing breaks on an import; it now delegates, and returns no
 * email. It used to include one, which is the bug that produced serialize.js:
 * this function existed specifically to be the safe shape for other people, was
 * used in four places whose comments said it withheld contact details, and
 * withheld only the phone number.
 *
 * Do not add fields here. Add them to the allowlist in db/serialize.js.
 */
function shapePerson(u) {
  return require('./serialize').publicUser(u);
}

/**
 * Apply a patch to the caller's own row and hand back the updated record.
 *
 * The four-line PostgREST chain plus `if (error) throw` appeared four times in
 * this file -- once per profile, avatar, cover and media route. Identical every
 * time, and every one of them scoped to req.user.id, which is the part that
 * must not be got wrong.
 */
async function updateSelf(db, userId, updates) {
  const { data: row, error } = await db
    .from('users')
    .update(updates)
    .eq('id', userId)
    .select()
    .single();

  if (error) throw error;
  return row;
}

// turn a users table row into what the frontend expects
/**
 * The only thing that turns a users row into a response body.
 *
 * Everything below is an explicit allowlist, and it has to stay one. This
 * function used to end with `_raw: safe` -- the whole row minus four fields --
 * which meant mfa_secret, mfa_locked_until, mfa_failed_attempts,
 * forgot_password_expire and email_otp_expire were attached to every user it
 * shaped. GET /api/users/:id accepts any id, so any logged-in account could
 * read the AES-GCM ciphertext of any other user's TOTP secret, plus the state
 * of their brute-force lockout.
 *
 * That defeated the threat model 010_mfa.sql was written against: encrypting
 * the secret only helps against someone holding a database dump, and this
 * handed it over without one. Worse, utils/mfa.js derives its key from
 * JWT_SECRET when MFA_SECRET_KEY is unset, so one leaked signing secret plus
 * that endpoint would have yielded plaintext secrets for every user.
 *
 * Nothing consumed _raw. It was referenced exactly once in the codebase: the
 * line that created it.
 *
 * Callers may still select('*') -- this allowlist is what makes that safe, so
 * adding a field here is the thing to be careful about, not the query.
 */
function shapeUser(row, extras = {}) {
  if (!row) return null;
  const {
    password,
    forgot_password_token,
    language_otp,
    email_otp,
    ...safe
  } = row;

  const id = safe.id;
  return {
    _id: id,
    id,
    name: safe.name,
    email: safe.email,
    phone: safe.phone || '',
    avatar: publicAssetUrl(safe.avatar || ''),
    // avatarUrl mirrors avatar; the client reads avatarUrl, older callers still
    // read avatar. Thumb falls back to full size so a row whose derivative has
    // not been generated yet still renders something.
    avatarUrl: publicAssetUrl(safe.avatar || ''),
    avatarThumbUrl: publicAssetUrl(safe.avatar_thumb_url || safe.avatar || ''),
    coverUrl: publicAssetUrl(safe.cover_url || ''),
    bio: safe.bio || '',
    language: safe.language || 'en',
    gender: safe.gender || '',
    interests: safe.interests || [],
    onboardingCompleted: !!safe.onboarding_completed,
    isCreator: !!safe.is_creator,
    creatorInterest: safe.creator_interest || '',
    subscription: {
      plan: safe.subscription_plan || 'free',
      expiresAt: safe.subscription_expires_at || null,
      razorpaySubscriptionId: safe.razorpay_subscription_id || '',
      // Undefined until migration 014 is applied, which reads as "eligible" --
      // the same answer every existing account should get anyway.
      trialUsedAt: safe.trial_used_at || null
    },
    questionsToday: safe.questions_today || 0,
    lastQuestionDate: safe.last_question_date || null,
    postsToday: safe.posts_today || 0,
    lastPostDate: safe.last_post_date || null,
    points: safe.points || 0,
    badges: safe.badges || [],
    totalAnswers: safe.total_answers || 0,
    totalUpvotesReceived: safe.total_upvotes_received || 0,
    emailVerified: safe.email_verified || false,
    isActive: safe.is_active !== false,
    role: safe.role || 'user',
    streakCount: safe.streak_count || 0,
    lastActivityDate: safe.last_activity_date || null,
    challengeProgress: safe.challenge_progress || {},
    friends: extras.friends || [],
    friendRequests: extras.friendRequests || [],
    following: extras.following || [],
    createdAt: safe.created_at,
    updatedAt: safe.updated_at
  };
}

function shapeAuthor(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    avatar: publicAssetUrl(row.avatar || ''),
    avatarUrl: publicAssetUrl(row.avatar || ''),
    avatarThumbUrl: publicAssetUrl(row.avatar_thumb_url || row.avatar || ''),
    points: row.points || 0,
    badges: row.badges || [],
    subscription: {
      plan: row.subscription_plan || 'free',
      expiresAt: row.subscription_expires_at || null
    }
  };
}

function shapePost(post, { author, media = [], likes = [], comments = [] } = {}) {
  return {
    _id: post.id,
    id: post.id,
    author: author || shapeAuthor({ id: post.author_id }),
    content: post.content || '',
    media: media.map(m => ({ type: m.type, url: publicAssetUrl(m.url) })),
    likes: likes.map(l => (typeof l === 'string' ? l : l.user_id)),
    comments: comments.map(c => ({
      _id: c.id,
      id: c.id,
      author: c.author || shapeAuthor({ id: c.author_id, name: 'User' }),
      content: c.content,
      createdAt: c.created_at
    })),
    shares: post.shares || 0,
    isPublic: post.is_public !== false,
    interestTags: post.interest_tags || [],
    isSeed: !!post.seed_key,
    createdAt: post.created_at,
    updatedAt: post.updated_at
  };
}

function shapeQuestion(q, { author, answers = [], upvotes = [], downvotes = [] } = {}) {
  return {
    _id: q.id,
    id: q.id,
    author: author || shapeAuthor({ id: q.author_id }),
    title: q.title,
    body: q.body,
    tags: q.tags || [],
    upvotes,
    downvotes,
    views: q.views || 0,
    answers,
    acceptedAnswer: q.accepted_answer_id,
    isResolved: q.is_resolved || false,
    bounty: q.bounty || 0,
    createdAt: q.created_at,
    updatedAt: q.updated_at
  };
}

function shapeAnswer(a, { author, upvotes = [], downvotes = [] } = {}) {
  return {
    _id: a.id,
    id: a.id,
    question: a.question_id,
    author: author || shapeAuthor({ id: a.author_id }),
    body: a.body,
    upvotes,
    downvotes,
    isAccepted: a.is_accepted || false,
    pointsAwarded: a.points_awarded || false,
    bonusPointsAwarded: a.bonus_points_awarded || false,
    createdAt: a.created_at,
    updatedAt: a.updated_at
  };
}

function shapeTransaction(t) {
  return {
    _id: t.id,
    id: t.id,
    user: t.user_id,
    plan: t.plan,
    amount: Number(t.amount),
    currency: t.currency || 'INR',
    razorpayOrderId: t.razorpay_order_id || '',
    razorpayPaymentId: t.razorpay_payment_id || '',
    razorpaySignature: t.razorpay_signature || '',
    status: t.status,
    invoiceNumber: t.invoice_number || '',
    invoiceDate: t.invoice_date,
    createdAt: t.created_at
  };
}

/**
 * Fetch many authors in ONE query and return an id -> shapedAuthor map.
 *
 * Several routes used to do `await db.from('users')...single()` inside a
 * `.map()`, which is one round trip per row — the feed alone was spending
 * 40+ requests on a page of 10 posts.
 */
async function loadAuthorMap(db, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return {};
  const { data } = await db.from('users').select(authorFields()).in('id', unique);
  return Object.fromEntries((data || []).map(a => [a.id, shapeAuthor(a)]));
}

/** Groups rows by a foreign-key column: [{post_id, ...}] -> { postId: [rows] }. */
function groupBy(rows, key) {
  const out = {};
  for (const row of rows || []) {
    (out[row[key]] ||= []).push(row);
  }
  return out;
}

/**
 * Hydrate a whole page of posts in a fixed number of queries.
 *
 * Five round trips regardless of page size: media, likes, comments, and one
 * author lookup covering both post authors and comment authors. The version
 * this replaced issued 4–5 per post, so a page of 10 cost 42–52 requests.
 *
 * It lives here rather than in routes/posts.js because three routes need it.
 * bookmarks.js and spaces.js each kept their own per-post variant and so never
 * got the fix — bookmarks was still doing five queries for every saved post.
 */
async function loadPostBundles(db, posts, { withComments = true } = {}) {
  if (!posts.length) return [];
  const ids = posts.map(p => p.id);

  // Spaces lists posts without ever rendering their comments, so it opts out
  // rather than fetching and shipping data the page throws away.
  const [{ data: media }, { data: likes }, { data: comments }] = await Promise.all([
    db.from('post_media').select('*').in('post_id', ids),
    db.from('post_likes').select('post_id, user_id').in('post_id', ids),
    withComments
      ? db.from('post_comments').select('*').in('post_id', ids).order('created_at', { ascending: true })
      : Promise.resolve({ data: [] })
  ]);

  const authors = await loadAuthorMap(db, [
    ...posts.map(p => p.author_id),
    ...(comments || []).map(c => c.author_id)
  ]);

  const mediaBy = groupBy(media, 'post_id');
  const likesBy = groupBy(likes, 'post_id');
  const commentsBy = groupBy(comments, 'post_id');

  return posts.map(post =>
    shapePost(post, {
      author: authors[post.author_id],
      media: mediaBy[post.id] || [],
      likes: likesBy[post.id] || [],
      comments: (commentsBy[post.id] || []).map(c => ({
        ...c,
        author: authors[c.author_id] || shapeAuthor({ id: c.author_id, name: 'User' })
      }))
    })
  );
}

/** Single-post convenience wrapper, used after create/comment. */
async function loadPostBundle(db, post) {
  const [shaped] = await loadPostBundles(db, [post]);
  return shaped;
}

module.exports = {
  loadPostBundles,
  loadPostBundle,
  authorFields,
  withMediaColumns,
  setMediaColumnSupport,
  mediaColumnsAvailable,
  loadAuthorMap,
  groupBy,
  publicAssetUrl,
  isToday,
  computeBadges,
  getActivePlan,
  getVoteLists,
  shapePerson,
  updateSelf,
  getDailyQuestionLimit,
  getDailyPostLimit,
  hashPassword,
  comparePassword,
  shapeUser,
  shapeAuthor,
  shapePost,
  shapeQuestion,
  shapeAnswer,
  shapeTransaction
};
