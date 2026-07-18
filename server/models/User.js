const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  phone: { type: String, default: '' },
  password: { type: String, required: true },
  avatar: { type: String, default: '' },
  bio: { type: String, default: '' },
  language: { type: String, default: 'en', enum: ['en', 'hi', 'es', 'pt', 'zh', 'fr'] },

  // Friends
  friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  friendRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Subscription
  subscription: {
    plan: { type: String, default: 'free', enum: ['free', 'bronze', 'silver', 'gold'] },
    expiresAt: { type: Date, default: null },
    razorpaySubscriptionId: { type: String, default: '' }
  },

  // Q&A post limits per day
  questionsToday: { type: Number, default: 0 },
  lastQuestionDate: { type: Date, default: null },

  // Feed post limits per day  
  postsToday: { type: Number, default: 0 },
  lastPostDate: { type: Date, default: null },

  // Rewards
  points: { type: Number, default: 0 },
  badges: [{ type: String, enum: ['bronze', 'silver', 'gold', 'contributor', 'expert'] }],
  totalAnswers: { type: Number, default: 0 },
  totalUpvotesReceived: { type: Number, default: 0 },

  // Forgot password
  forgotPasswordToken: { type: String, default: '' },
  forgotPasswordExpire: { type: Date, default: null },
  forgotPasswordRequestedAt: { type: Date, default: null },
  forgotPasswordCountToday: { type: Number, default: 0 },
  lastForgotPasswordDate: { type: Date, default: null },

  // OTP for language change
  languageOTP: { type: String, default: '' },
  languageOTPExpire: { type: Date, default: null },
  pendingLanguage: { type: String, default: '' },

  // Email verification
  emailVerified: { type: Boolean, default: false },
  emailOTP: { type: String, default: '' },
  emailOTPExpire: { type: Date, default: null },

  isActive: { type: Boolean, default: true },
  role: { type: String, default: 'user', enum: ['user', 'admin'] }
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
userSchema.methods.comparePassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Check subscription validity
userSchema.methods.getActivePlan = function () {
  if (this.subscription.plan === 'free') return 'free';
  if (this.subscription.expiresAt && new Date() > this.subscription.expiresAt) {
    return 'free'; // expired
  }
  return this.subscription.plan;
};

// Get daily question limit based on plan
userSchema.methods.getDailyQuestionLimit = function () {
  const plan = this.getActivePlan();
  const limits = { free: 1, bronze: 5, silver: 10, gold: Infinity };
  return limits[plan];
};

// Get daily post limit based on friends
userSchema.methods.getDailyPostLimit = function () {
  const friendCount = this.friends.length;
  if (friendCount === 0) return 0;
  if (friendCount === 1) return 1;
  if (friendCount < 10) return 2;
  return Infinity; // 10+ friends
};

// Update badges based on points
userSchema.methods.updateBadges = function () {
  const p = this.points;
  this.badges = [];
  if (p >= 50) this.badges.push('bronze');
  if (p >= 200) this.badges.push('silver');
  if (p >= 500) this.badges.push('gold');
  if (this.totalAnswers >= 10) this.badges.push('contributor');
  if (this.totalAnswers >= 50) this.badges.push('expert');
};

module.exports = mongoose.model('User', userSchema);
