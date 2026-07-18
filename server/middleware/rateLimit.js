const rateLimit = require('express-rate-limit');

// general API traffic
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_API || 400),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Try again in a bit.' }
});

// login / register / forgot
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Wait 15 minutes.' }
});

// otp, password change, delete account
const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_SENSITIVE || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts. Try again later.' }
});

// posts / reports spam guard
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_WRITE || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Slow down a little.' }
});

module.exports = { apiLimiter, authLimiter, sensitiveLimiter, writeLimiter };
