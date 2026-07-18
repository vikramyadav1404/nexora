const rateLimit = require('express-rate-limit');

/** General API limit */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API || 400),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' }
});

/** Stricter auth (login/register/forgot) */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many auth attempts. Wait 15 minutes and try again.' }
});

/** Password / email OTP actions */
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_SENSITIVE || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many sensitive requests. Try again in an hour.' }
});

/** Report / post creation soft limit */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WRITE || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'You are posting too quickly. Slow down a bit.' }
});

module.exports = { apiLimiter, authLimiter, sensitiveLimiter, writeLimiter };
