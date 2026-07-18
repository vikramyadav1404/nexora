const nodemailer = require('nodemailer');

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

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// letters only, mixed case — used for forgot-password
function generatePassword(length = 10) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const all = upper + lower;
  let out = upper[Math.floor(Math.random() * upper.length)];
  out += lower[Math.floor(Math.random() * lower.length)];
  for (let i = 2; i < length; i++) {
    out += all[Math.floor(Math.random() * all.length)];
  }
  // cheap shuffle
  return out.split('').sort(() => Math.random() - 0.5).join('');
}

module.exports = { sendEmail, generateOTP, generatePassword, isEmailConfigured };
