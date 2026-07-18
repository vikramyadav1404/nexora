/**
 * In-memory demo store — used when DEMO_MODE=true
 * or when Supabase is not configured.
 */
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { INTERESTS, SEED_POSTS, CREATORS } = require('./interests');

const store = {
  users: new Map(),
  posts: new Map(),
  postLikes: new Map(), // postId -> Set(userId)
  postComments: new Map(),
  follows: new Map(), // followerId -> Set(followingId)
  friendships: new Map(),
  notifications: [], // { id, userId, type, title, body, link, read, createdAt }
  bookmarks: new Map(), // userId -> [{ type, id, createdAt }]
  blocks: new Map(), // blockerId -> Set(blockedId)
  reports: [],
  questions: new Map(),
  ready: false
};

const CHALLENGES = [
  { id: 'answer_3', title: 'Helpful Human', desc: 'Post 3 answers this week', goal: 3, metric: 'answers', reward: 15 },
  { id: 'post_2', title: 'Share the Love', desc: 'Create 2 feed posts', goal: 2, metric: 'posts', reward: 10 },
  { id: 'follow_3', title: 'Network Builder', desc: 'Follow 3 people', goal: 3, metric: 'follows', reward: 10 },
  { id: 'streak_3', title: 'On Fire', desc: 'Keep a 3-day activity streak', goal: 3, metric: 'streak', reward: 20 }
];

function shapeDemoUser(u, extras = {}) {
  return {
    _id: u.id,
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone || '',
    avatar: u.avatar || '',
    bio: u.bio || '',
    language: u.language || 'en',
    gender: u.gender || '',
    interests: u.interests || [],
    onboardingCompleted: !!u.onboardingCompleted,
    isCreator: !!u.isCreator,
    creatorInterest: u.creatorInterest || '',
    subscription: {
      plan: u.subscriptionPlan || 'free',
      expiresAt: u.subscriptionExpiresAt || null,
      razorpaySubscriptionId: ''
    },
    points: u.points || 0,
    badges: u.badges || [],
    totalAnswers: u.totalAnswers || 0,
    friends: extras.friends || [],
    friendRequests: extras.friendRequests || [],
    postsToday: u.postsToday || 0,
    lastPostDate: u.lastPostDate || null,
    questionsToday: u.questionsToday || 0,
    lastQuestionDate: u.lastQuestionDate || null,
    streakCount: u.streakCount || 0,
    lastActivityDate: u.lastActivityDate || null,
    challengeProgress: u.challengeProgress || {},
    createdAt: u.createdAt
  };
}

function pushNotification(userId, { type = 'info', title, body = '', link = '' }) {
  store.notifications.unshift({
    id: randomUUID(),
    userId,
    type,
    title,
    body,
    link,
    read: false,
    createdAt: new Date().toISOString()
  });
  // keep last 100
  if (store.notifications.length > 100) store.notifications.length = 100;
}

function touchStreak(user) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.lastActivityDate === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (user.lastActivityDate === yesterday) {
    user.streakCount = (user.streakCount || 0) + 1;
  } else {
    user.streakCount = 1;
  }
  user.lastActivityDate = today;
}

function bumpChallenge(user, metric, amount = 1) {
  if (!user.challengeProgress) user.challengeProgress = {};
  user.challengeProgress[metric] = (user.challengeProgress[metric] || 0) + amount;
}

async function initDemoStore() {
  if (store.ready) return store;

  const passwordHash = await bcrypt.hash('demo1234', 10);
  const now = new Date().toISOString();

  // Main demo user
  const demoId = '00000000-0000-4000-8000-000000000001';
  store.users.set(demoId, {
    id: demoId,
    name: 'Demo User',
    email: 'demo@nexora.com',
    phone: '',
    password: passwordHash,
    avatar: '',
    bio: 'Demo account for exploring Nexora',
    language: 'en',
    gender: 'prefer-not-to-say',
    interests: ['technology', 'music', 'gaming'],
    onboardingCompleted: true,
    isCreator: false,
    subscriptionPlan: 'free',
    points: 42,
    badges: ['bronze'],
    totalAnswers: 3,
    postsToday: 0,
    lastPostDate: null,
    questionsToday: 0,
    lastQuestionDate: null,
    friends: [],
    friendRequests: [],
    streakCount: 3,
    lastActivityDate: new Date().toISOString().slice(0, 10),
    challengeProgress: { answers: 1, posts: 1, follows: 2, streak: 3 },
    createdAt: now
  });

  store.bookmarks.set(demoId, []);
  store.blocks.set(demoId, new Set());

  // Seed notifications for demo user
  pushNotification(demoId, {
    type: 'welcome',
    title: 'Welcome to Nexora 🎉',
    body: 'Your personalized feed is ready. Explore Spaces and Challenges!',
    link: '/feed'
  });
  pushNotification(demoId, {
    type: 'challenge',
    title: 'Weekly challenge unlocked',
    body: 'Complete “Helpful Human” — answer 3 questions this week.',
    link: '/challenges'
  });
  pushNotification(demoId, {
    type: 'points',
    title: 'You earned points',
    body: '+5 points for being active in the community.',
    link: '/leaderboard'
  });

  // Sample questions for search / spaces
  const q1 = randomUUID();
  store.questions.set(q1, {
    id: q1,
    author_id: demoId,
    title: 'How do I structure a React app with Vite?',
    body: 'Looking for folder structure best practices for a medium app.',
    tags: ['react', 'vite', 'technology'],
    interest: 'technology',
    upvotes: [],
    downvotes: [],
    answers: [],
    views: 12,
    isResolved: false,
    createdAt: now
  });
  const q2 = randomUUID();
  store.questions.set(q2, {
    id: q2,
    author_id: demoId,
    title: 'Best warm-up before a football match?',
    body: 'Share your pre-game routine that actually works.',
    tags: ['sports', 'fitness'],
    interest: 'sports',
    upvotes: [],
    downvotes: [],
    answers: [],
    views: 8,
    isResolved: false,
    createdAt: now
  });

  // Seed interest creators + posts
  for (const c of CREATORS) {
    const id = randomUUID();
    store.users.set(id, {
      id,
      name: c.name,
      email: c.email,
      password: passwordHash,
      avatar: '',
      bio: c.bio,
      language: 'en',
      gender: 'prefer-not-to-say',
      interests: [c.interest],
      onboardingCompleted: true,
      isCreator: true,
      creatorInterest: c.interest,
      subscriptionPlan: 'free',
      points: 100,
      badges: ['contributor'],
      totalAnswers: 5,
      postsToday: 0,
      friends: [],
      friendRequests: [],
      createdAt: now
    });

    // Auto-follow tech/music/gaming creators for demo user
    if (['technology', 'music', 'gaming'].includes(c.interest)) {
      if (!store.follows.has(demoId)) store.follows.set(demoId, new Set());
      store.follows.get(demoId).add(id);
    }

    const posts = SEED_POSTS[c.interest] || [];
    posts.forEach((content, i) => {
      const postId = randomUUID();
      store.posts.set(postId, {
        id: postId,
        author_id: id,
        content,
        shares: Math.floor(Math.random() * 10),
        is_public: true,
        interest_tags: [c.interest],
        seed_key: `demo:${c.interest}:${i}`,
        created_at: new Date(Date.now() - i * 3600000).toISOString(),
        updated_at: now
      });
      store.postLikes.set(postId, new Set());
      store.postComments.set(postId, []);
    });
  }

  // One post from demo user
  const ownPostId = randomUUID();
  store.posts.set(ownPostId, {
    id: ownPostId,
    author_id: demoId,
    content: 'Hey! This is the demo account. Explore the feed, Q&A, Spaces, Challenges & more 👋',
    shares: 2,
    is_public: true,
    interest_tags: ['technology'],
    seed_key: null,
    created_at: now,
    updated_at: now
  });
  store.postLikes.set(ownPostId, new Set());
  store.postComments.set(ownPostId, []);

  // Give demo user friends so feed posting is unlocked in UI
  const demoUser = store.users.get(demoId);
  const friendIds = [...store.users.values()]
    .filter(u => u.isCreator)
    .slice(0, 3)
    .map(u => u.id);
  demoUser.friends = friendIds;

  store.ready = true;
  console.log('✅ Demo mode ready');
  console.log('   Email:    demo@nexora.com');
  console.log('   Password: demo1234');
  return store;
}

function findUserByEmail(email) {
  for (const u of store.users.values()) {
    if (u.email === email.toLowerCase().trim()) return u;
  }
  return null;
}

function findUserById(id) {
  return store.users.get(id) || null;
}

function listPosts() {
  return [...store.posts.values()].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );
}

function getAuthor(id) {
  const u = findUserById(id);
  if (!u) return { _id: id, id, name: 'User', avatar: '', points: 0, badges: [] };
  return {
    _id: u.id,
    id: u.id,
    name: u.name,
    avatar: u.avatar || '',
    points: u.points || 0,
    badges: u.badges || [],
    subscription: { plan: u.subscriptionPlan || 'free', expiresAt: null }
  };
}

function shapePost(post) {
  const likes = [...(store.postLikes.get(post.id) || [])];
  const comments = (store.postComments.get(post.id) || []).map(c => ({
    _id: c.id,
    author: getAuthor(c.author_id),
    content: c.content,
    createdAt: c.created_at
  }));
  return {
    _id: post.id,
    id: post.id,
    author: getAuthor(post.author_id),
    content: post.content || '',
    media: [],
    likes,
    comments,
    shares: post.shares || 0,
    isPublic: post.is_public !== false,
    interestTags: post.interest_tags || [],
    isSeed: !!post.seed_key,
    createdAt: post.created_at,
    updatedAt: post.updated_at
  };
}

module.exports = {
  store,
  initDemoStore,
  shapeDemoUser,
  findUserByEmail,
  findUserById,
  listPosts,
  getAuthor,
  shapePost,
  INTERESTS,
  CHALLENGES,
  pushNotification,
  touchStreak,
  bumpChallenge
};
