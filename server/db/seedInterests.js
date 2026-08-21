const bcrypt = require('bcryptjs');
const { fixtureCost } = require('../utils/bcryptCost');
const { getSupabase } = require('./supabase');
const { CREATORS, SEED_POSTS } = require('./interests');

/**
 * Ensure seed creator accounts + interest posts exist,
 * then auto-follow creators matching the user's interests.
 */
async function ensureInterestContent(userId, interests = []) {
  if (!interests.length) return { creatorsFollowed: 0, postsSeeded: 0 };

  const db = getSupabase();
  const passwordHash = await bcrypt.hash('NexoraSeed!2026', fixtureCost());
  let postsSeeded = 0;
  let creatorsFollowed = 0;
  const creatorIds = [];

  for (const interest of interests) {
    const creatorMeta = CREATORS.find(c => c.interest === interest);
    if (!creatorMeta) continue;

    // Upsert creator by email
    let { data: creator } = await db
      .from('users')
      .select('id, name, avatar, points, badges, interests')
      .eq('email', creatorMeta.email)
      .maybeSingle();

    if (!creator) {
      const { data: created, error } = await db.from('users').insert({
        name: creatorMeta.name,
        email: creatorMeta.email,
        phone: '',
        password: passwordHash,
        bio: creatorMeta.bio,
        gender: 'prefer-not-to-say',
        interests: [interest],
        is_creator: true,
        creator_interest: interest,
        onboarding_completed: true,
        points: 120,
        badges: ['contributor'],
        is_active: true
      }).select('id, name, avatar, points, badges, interests').single();

      if (error) {
        // Race: someone else created it
        const { data: again } = await db
          .from('users')
          .select('id, name, avatar, points, badges, interests')
          .eq('email', creatorMeta.email)
          .maybeSingle();
        creator = again;
      } else {
        creator = created;
      }
    }

    if (!creator) continue;
    creatorIds.push(creator.id);

    // Seed posts for this interest
    const posts = SEED_POSTS[interest] || [];
    for (let i = 0; i < posts.length; i++) {
      const seedKey = `seed:${interest}:${i}`;
      const { data: existing } = await db
        .from('posts')
        .select('id')
        .eq('seed_key', seedKey)
        .maybeSingle();

      if (existing) continue;

      const { error: pErr } = await db.from('posts').insert({
        author_id: creator.id,
        content: posts[i],
        is_public: true,
        interest_tags: [interest],
        seed_key: seedKey,
        shares: Math.floor(Math.random() * 12)
      });

      if (!pErr) postsSeeded += 1;
    }

    // Auto-follow creator (if not self)
    if (creator.id !== userId) {
      const { error: fErr } = await db.from('follows').upsert({
        follower_id: userId,
        following_id: creator.id
      }, { onConflict: 'follower_id,following_id' });

      if (!fErr) creatorsFollowed += 1;
    }
  }

  return { creatorsFollowed, postsSeeded, creatorIds };
}

module.exports = { ensureInterestContent };
