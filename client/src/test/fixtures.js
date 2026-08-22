/**
 * Fixture responses for every endpoint the pages GET.
 *
 * Deliberately plausible rather than minimal: a page that renders nothing
 * because its list was empty proves nothing about whether it can render a list.
 * Each fixture carries at least one item, and the user objects match the shapes
 * db/serialize.js actually emits -- public shape for other people, owner shape
 * for the signed-in account.
 */

export const ME = 'f7014f58-05ef-4eb1-8f28-4daf22a1ee36';
export const OTHER = '00000000-0000-4000-8000-000000000002';
export const QUESTION_ID = '00000000-0000-4000-8000-0000000000q1'.replace('q1', '11');

/** What db/serialize.js `publicUser` returns -- no email, no friends array. */
function publicPerson(id, name) {
  return {
    _id: id,
    id,
    name,
    avatar: '',
    avatarUrl: '',
    avatarThumbUrl: '',
    coverUrl: '',
    bio: 'Builds things',
    interests: ['technology'],
    isCreator: false,
    creatorInterest: '',
    points: 120,
    badges: ['bronze'],
    totalAnswers: 4,
    totalUpvotesReceived: 9,
    streakCount: 2,
    subscription: { plan: 'free', expiresAt: null },
    createdAt: '2026-01-01T00:00:00Z'
  };
}

/**
 * The owner shape.
 *
 * onboardingCompleted MUST be true. ProtectedRoute redirects to /onboarding
 * without it, so every route would render the same page and the whole suite
 * would pass while testing one screen.
 */
export const CURRENT_USER = {
  ...publicPerson(ME, 'Vikram Yadav'),
  email: 'me@nexora.test',
  phone: '',
  emailVerified: true,
  isActive: true,
  role: 'admin',
  onboardingCompleted: true,
  language: 'en',
  gender: 'male',
  subscription: { plan: 'pro', expiresAt: '2027-01-01T00:00:00Z', razorpaySubscriptionId: '', trialUsedAt: null },
  questionsToday: 0,
  postsToday: 0,
  challengeProgress: {},
  friends: [publicPerson(OTHER, 'Asha Rao')],
  friendRequests: [],
  following: []
};

const post = (id) => ({
  _id: id,
  id,
  author: publicPerson(OTHER, 'Asha Rao'),
  content: 'A post that exists',
  media: [],
  likes: [],
  comments: [],
  shares: 0,
  isPublic: true,
  interestTags: ['technology'],
  createdAt: '2026-02-01T00:00:00Z'
});

const question = (id) => ({
  _id: id,
  id,
  author: publicPerson(OTHER, 'Asha Rao'),
  title: 'How does the quota work?',
  body: 'Asking because the docs are thin.',
  tags: ['technology'],
  answers: [],
  upvotes: [],
  downvotes: [],
  acceptedAnswerId: null,
  createdAt: '2026-02-01T00:00:00Z'
});

/**
 * URL (without query string) -> response body.
 *
 * Keys are matched exactly first, then by prefix for the `:id` routes.
 */
export const FIXTURES = {
  '/api/auth/me': { user: CURRENT_USER },
  '/api/auth/mfa/status': { enabled: false, backupCodesRemaining: 0 },
  '/api/health': { status: 'ok' },
  // The banner reads this. 'production' so the smoke suite renders the app as
  // production sees it -- a banner in every snapshot would mask its absence.
  '/api/version': { name: 'nexora', environment: 'production', isProduction: true, commit: 'test', stamped: true },

  '/api/posts': { posts: [post('p1'), post('p2')], nextCursor: null },
  '/api/questions': { questions: [question('q1')], nextCursor: null },
  '/api/questions/:id': { question: question('q1'), answers: [] },

  '/api/users/suggestions': { suggestions: [publicPerson(OTHER, 'Asha Rao')] },
  '/api/users/search': { users: [publicPerson(OTHER, 'Asha Rao')] },
  '/api/users/me/requests': { requests: [] },
  '/api/users/interests/catalog': {
    interests: [{ id: 'technology', label: 'Technology', emoji: '💻' }],
    genders: ['male', 'female', 'other']
  },
  // A non-owner profile: friendCount and isFriend, never the friends array.
  '/api/users/:id': {
    user: { ...publicPerson(OTHER, 'Asha Rao'), friendCount: 3, isFriend: false }
  },

  '/api/rewards/leaderboard': {
    leaderboard: [
      publicPerson(ME, 'Vikram Yadav'),
      publicPerson(OTHER, 'Asha Rao'),
      publicPerson('00000000-0000-4000-8000-000000000003', 'Third Person')
    ]
  },
  '/api/rewards/transfers': { transfers: [] },

  '/api/spaces': { spaces: [{ id: 'technology', label: 'Technology', emoji: '💻', count: 4 }] },
  '/api/spaces/:id': {
    space: { id: 'technology', label: 'Technology', emoji: '💻' },
    posts: [post('p1')],
    questions: [question('q1')],
    members: [publicPerson(OTHER, 'Asha Rao')]
  },

  '/api/notifications': { notifications: [], unread: 0 },
  '/api/bookmarks': { bookmarks: [] },
  '/api/challenges': { challenges: [], streak: 0, checkedInToday: false },
  '/api/digests/weekly': { digest: null },
  '/api/search': { people: [], posts: [], questions: [], spaces: [], query: '' },

  '/api/subscriptions/plans': {
    plans: [{ id: 'free', name: 'Free', price: 0, features: ['Basic'] }]
  },
  '/api/subscriptions/history': { history: [] },

  '/api/admin/stats': { users: 29, posts: 4, questions: 2, reports: 0 },
  '/api/admin/reports': { reports: [] }
};

/**
 * Resolve a request URL to a fixture.
 *
 * Throws on an unmatched URL rather than returning `{}`.
 *
 * This is the important line in the file. A silent empty default would let a
 * page mount, render nothing, and pass -- which is exactly how an empty
 * `people: []` and a wrong mount path each produced a green test earlier this
 * month. If a page starts calling something new, this suite should fail loudly
 * until someone decides what that endpoint returns.
 */
export function resolveFixture(url) {
  const path = String(url || '').split('?')[0].replace(/\/$/, '') || '/';

  if (path in FIXTURES) return FIXTURES[path];

  // `:id` routes -- match the longest registered prefix.
  const parametrised = ['/api/users/', '/api/spaces/', '/api/questions/'];
  for (const prefix of parametrised) {
    if (path.startsWith(prefix) && path.length > prefix.length) {
      const key = `${prefix.slice(0, -1)}/:id`;
      if (key in FIXTURES) return FIXTURES[key];
    }
  }

  throw new Error(
    `No fixture for ${path}. Add one to src/test/fixtures.js — a page is ` +
    `calling an endpoint this harness does not know about, and guessing an ` +
    `empty response would hide whatever it renders.`
  );
}
