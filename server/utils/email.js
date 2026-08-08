const nodemailer = require('nodemailer');
const crypto = require('node:crypto');

function isEmailConfigured() {
  const user = (process.env.EMAIL_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return false;
  if (user === 'your_email@gmail.com' || pass === 'your_app_password') return false;
  return true;
}

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: (process.env.EMAIL_USER || '').trim(),
      pass: (process.env.EMAIL_PASS || '').replace(/\s+/g, '')
    }
  });
}

// if gmail isn't set up we just dump the message to the console (handy for local dev)
async function sendEmail(to, subject, html) {
  try {
    if (!isEmailConfigured()) {
      console.log('[mail mock]', to, '-', subject);
      console.log(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
      return true;
    }

    await getTransporter().sendMail({
      from: `"Nexora" <${process.env.EMAIL_USER.trim()}>`,
      to,
      subject,
      html
    });
    console.log('[mail] sent to', to);
    return true;
  } catch (err) {
    console.error('[mail] failed:', err.message);
    // still print body so OTP isn't lost during setup
    console.log('[mail fallback]', to, subject);
    console.log(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    return false;
  }
}

/*
 * Both generators below mint credentials, so both must come from a CSPRNG.
 *
 * They used to use Math.random(). V8 implements that as xorshift128+, whose
 * internal state is recoverable from a short run of consecutive outputs -- and
 * POST /api/auth/generate-password hands out draws from the same generator in
 * the same process to anyone, unauthenticated. An attacker could harvest
 * outputs there, recover the state, then trigger /forgot-password for a victim
 * and predict the password just written to that victim's row. Since
 * forgot-password replaces the password without the victim doing anything,
 * they would be locked out either way.
 *
 * crypto.randomInt is rejection-sampled, so there is no modulo bias, and its
 * output tells an observer nothing about any other output. That makes the
 * public endpoint harmless rather than an oracle.
 *
 * The rest of the codebase already got this right -- utils/tokens.js and
 * utils/mfa.js both use crypto.randomBytes. This file was the outlier.
 */
function generateOTP() {
  // Upper bound is exclusive, so this is a uniform draw across 100000-999999.
  return String(crypto.randomInt(100000, 1000000));
}

// letters only, mixed case — used for forgot-password
function generatePassword(length = 10) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const all = upper + lower;

  // Guarantee one of each case, then fill the rest from the full alphabet.
  const chars = [
    upper[crypto.randomInt(upper.length)],
    lower[crypto.randomInt(lower.length)]
  ];
  for (let i = 2; i < length; i++) {
    chars.push(all[crypto.randomInt(all.length)]);
  }

  /*
   * Fisher-Yates, not `.sort(() => Math.random() - 0.5)`.
   *
   * A comparator returning random values is not a shuffle: the result depends
   * on the sort implementation and is measurably biased, which for a password
   * means the guaranteed upper/lower characters were more likely to stay near
   * the front than a uniform shuffle would leave them.
   */
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

module.exports = { sendEmail, generateOTP, generatePassword, isEmailConfigured };
