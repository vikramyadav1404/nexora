const { publicAssetUrl } = require('./helpers');

/**
 * User serialisation, as an allowlist.
 *
 * Every user shape in this codebase was a denylist, and the bug that produced
 * this module is what denylists do. `shapeUser` destructures four secrets out
 * of the row -- password, the two OTPs, the reset token -- and then names the
 * rest. So it does not leak a password. It leaks everything nobody thought to
 * remove: email, phone, role, is_active, the Razorpay subscription id, the
 * daily quota counters. Any logged-in account could read all of it for any
 * other account by opening their profile.
 *
 * `shapePerson` was the supposedly-safe alternative, added specifically to stop
 * that. It strips phone and keeps email, and it is used in three places whose
 * comments state it protects contact details. A wrong comment on a security
 * boundary is worse than no comment: it stops the next person checking.
 *
 * ------------------------------------------------------------------
 * The property that matters
 * ------------------------------------------------------------------
 * Nothing below spreads. There is no `...rest`, no `...safe`, no Object.assign
 * over a row. Each field is written out by hand, so a column added by a future
 * migration is absent from the response until somebody adds it here on purpose.
 *
 * That is the entire point. A denylist means the next migration leaks silently
 * and nothing fails; an allowlist means the next migration is invisible until
 * someone decides otherwise. Only one of those failure modes is safe.
 *
 * If you are adding a column and it belongs in the API, add it to PUBLIC_USER
 * or to OWNER_ONLY deliberately, and say which in the commit.
 */

/**
 * What anyone logged in may see about anyone else.
 *
 * Names, avatars and public reputation. No contact details, no account state,
 * no internal counters, and no social graph -- see friendCount below.
 */
function publicUser(row) {
  if (!row) return null;

  const id = row.id;
  return {
    _id: id,
    id,
    name: row.name,

    // avatarUrl mirrors avatar because the client reads avatarUrl and older
    // callers still read avatar. Thumb falls back to full size so a row whose
    // derivative has not been generated yet still renders something.
    avatar: publicAssetUrl(row.avatar || ''),
    avatarUrl: publicAssetUrl(row.avatar || ''),
    avatarThumbUrl: publicAssetUrl(row.avatar_thumb_url || row.avatar || ''),
    coverUrl: publicAssetUrl(row.cover_url || ''),

    bio: row.bio || '',
    interests: row.interests || [],
    isCreator: !!row.is_creator,
    creatorInterest: row.creator_interest || '',

    // Reputation. Already public via shapeAuthor on every post and answer, so
    // withholding it here would be inconsistent rather than private.
    points: row.points || 0,
    badges: row.badges || [],
    totalAnswers: row.total_answers || 0,
    totalUpvotesReceived: row.total_upvotes_received || 0,
    streakCount: row.streak_count || 0,

    /*
     * Plan and expiry only. razorpay_subscription_id is an identifier in a
     * payment processor's system and has no business being in a public
     * profile -- it is owner-only below.
     */
    subscription: {
      plan: row.subscription_plan || 'free',
      expiresAt: row.subscription_expires_at || null
    },

    // "Joined" is conventional on a profile. updated_at is not -- it is a
    // behaviour signal that says when someone last touched their account.
    createdAt: row.created_at
  };
}

/**
 * Everything in the public shape, plus what only the account holder may see.
 *
 * Two groups, and they are different kinds of private. Contact details are
 * personal data. The rest -- role, quota counters, billing state -- is internal
 * bookkeeping that happens to live on the same row, and is withheld because a
 * stranger has no use for it, not because it is sensitive.
 */
function ownerUser(row, extras = {}) {
  if (!row) return null;

  const base = publicUser(row);

  return {
    ...base,

    // Personal data. The reason this module exists.
    email: row.email,
    phone: row.phone || '',

    // Account and privilege state.
    emailVerified: row.email_verified || false,
    isActive: row.is_active !== false,
    role: row.role || 'user',
    onboardingCompleted: !!row.onboarding_completed,
    language: row.language || 'en',
    gender: row.gender || '',

    // Billing, including the processor id withheld from publicUser.
    subscription: {
      ...base.subscription,
      razorpaySubscriptionId: row.razorpay_subscription_id || '',
      // Undefined until migration 014 is applied, which reads as "eligible" --
      // the same answer every existing account should get anyway.
      trialUsedAt: row.trial_used_at || null
    },

    // Quota counters. The client renders "3 posts left today" from these.
    questionsToday: row.questions_today || 0,
    lastQuestionDate: row.last_question_date || null,
    postsToday: row.posts_today || 0,
    lastPostDate: row.last_post_date || null,
    challengeProgress: row.challenge_progress || {},
    lastActivityDate: row.last_activity_date || null,
    updatedAt: row.updated_at,

    /*
     * The full social graph, owner only. friendRequests in particular is a list
     * of people who approached this account, which is theirs and not the
     * viewer's business.
     */
    friends: extras.friends || [],
    friendRequests: extras.friendRequests || [],
    following: extras.following || []
  };
}

/**
 * Pick the shape from who is asking.
 *
 * `viewerId` is the authenticated caller. Comparison is on the row id, so a
 * caller can only ever reach the owner shape for their own row -- there is no
 * flag to pass and therefore no flag a route can forget to pass correctly.
 *
 * `extras.friendIds` lets a non-owner response answer "are we friends?" without
 * handing over who else is. The count is a number; the list is not.
 */
function serializeUser(row, viewerId, extras = {}) {
  if (!row) return null;

  if (viewerId && row.id === viewerId) return ownerUser(row, extras);

  const friendIds = extras.friendIds || extras.friends || [];
  const ids = friendIds.map(f => (typeof f === 'string' ? f : f && (f.id || f._id)));

  return {
    ...publicUser(row),
    friendCount: ids.length,
    isFriend: viewerId ? ids.includes(viewerId) : false
  };
}

module.exports = { publicUser, ownerUser, serializeUser };
