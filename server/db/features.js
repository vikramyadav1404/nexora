// notifications, streaks, challenge progress — used by a few routes
const { getSupabase } = require('./supabase');

const CHALLENGES = [
  { id: 'answer_3', title: 'Helpful Human', desc: 'Post 3 answers this week', goal: 3, metric: 'answers', reward: 15 },
  { id: 'post_2', title: 'Share the Love', desc: 'Create 2 feed posts', goal: 2, metric: 'posts', reward: 10 },
  { id: 'follow_3', title: 'Network Builder', desc: 'Follow 3 people', goal: 3, metric: 'follows', reward: 10 },
  { id: 'streak_3', title: 'On Fire', desc: 'Keep a 3-day activity streak', goal: 3, metric: 'streak', reward: 20 }
];

async function pushNotification(userId, { type = 'info', title, body = '', link = '' }) {
  if (!userId || !title) return null;
  try {
    const { data, error } = await getSupabase()
      .from('notifications')
      .insert({ user_id: userId, type, title, body, link })
      .select()
      .single();
    if (error) {
      console.warn('notify failed:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.warn('notify failed:', e.message);
    return null;
  }
}

function computeStreakUpdate(userRow) {
  const today = new Date().toISOString().slice(0, 10);
  const last = userRow.last_activity_date
    ? String(userRow.last_activity_date).slice(0, 10)
    : null;

  if (last === today) {
    return {
      streak_count: userRow.streak_count || 0,
      last_activity_date: today
    };
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = 1;
  if (last === yesterday) streak = (userRow.streak_count || 0) + 1;

  return { streak_count: streak, last_activity_date: today };
}

function bumpChallengeProgress(progress, metric, amount = 1) {
  const next = { ...(progress || {}) };
  next[metric] = (next[metric] || 0) + amount;
  return next;
}

async function touchUserActivity(userId, userRow, { metric = null, amount = 1 } = {}) {
  const db = getSupabase();
  const streak = computeStreakUpdate(userRow);

  let progress = userRow.challenge_progress || {};
  if (typeof progress === 'string') {
    try {
      progress = JSON.parse(progress);
    } catch {
      progress = {};
    }
  }
  if (metric) progress = bumpChallengeProgress(progress, metric, amount);
  progress.streak = streak.streak_count;

  const { data, error } = await db
    .from('users')
    .update({
      streak_count: streak.streak_count,
      last_activity_date: streak.last_activity_date,
      challenge_progress: progress
    })
    .eq('id', userId)
    .select()
    .single();

  if (error) {
    console.warn('touchUserActivity:', error.message);
    return userRow;
  }
  return data;
}

function shapeNotification(n) {
  return {
    _id: n.id,
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body || '',
    link: n.link || '',
    read: !!n.read,
    createdAt: n.created_at
  };
}

module.exports = {
  CHALLENGES,
  pushNotification,
  computeStreakUpdate,
  bumpChallengeProgress,
  touchUserActivity,
  shapeNotification
};
