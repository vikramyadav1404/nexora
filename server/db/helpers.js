const bcrypt = require('bcryptjs');

/** Public author fields for embeds */
const AUTHOR_FIELDS = 'id, name, avatar, points, badges, subscription_plan, subscription_expires_at';

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
  return bcrypt.hash(password, 12);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Map DB user row → API shape expected by the React client */
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
    avatar: safe.avatar || '',
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
      razorpaySubscriptionId: safe.razorpay_subscription_id || ''
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
    updatedAt: safe.updated_at,
    // raw fields sometimes needed server-side
    _raw: safe
  };
}

function shapeAuthor(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    avatar: row.avatar || '',
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
    media: media.map(m => ({ type: m.type, url: m.url })),
    likes: likes.map(l => (typeof l === 'string' ? l : l.user_id)),
    comments: comments.map(c => ({
      _id: c.id,
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

module.exports = {
  AUTHOR_FIELDS,
  isToday,
  computeBadges,
  getActivePlan,
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
