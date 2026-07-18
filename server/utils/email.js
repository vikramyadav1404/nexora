const nodemailer = require('nodemailer');

function isEmailConfigured() {
  const user = (process.env.EMAIL_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) return false;
  if (user === 'your_email@gmail.com') return false;
  if (pass === 'your_app_password') return false;
  return true;
}

function getTransporter() {
  const user = (process.env.EMAIL_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || '').replace(/\s+/g, '');
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

/**
 * Send email. Falls back to console mock when EMAIL_* not configured.
 * @returns {Promise<boolean>}
 */
const sendEmail = async (to, subject, html) => {
  try {
    if (!isEmailConfigured()) {
      console.log(`📧 [MOCK EMAIL] To: ${to} | Subject: ${subject}`);
      console.log(`📧 Content: ${html.replace(/<[^>]*>/g, ' ')}`);
      return true;
    }
    const user = (process.env.EMAIL_USER || '').trim();
    await getTransporter().sendMail({
      from: `"Nexora" <${user}>`,
      to,
      subject,
      html
    });
    console.log(`📧 Email sent to ${to}: ${subject}`);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    // Fallback so OTP still appears in logs during setup
    console.log(`📧 [FALLBACK LOG] To: ${to} | Subject: ${subject}`);
    console.log(`📧 Content: ${html.replace(/<[^>]*>/g, ' ')}`);
    return false;
  }
};

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// Generate password (letters only, mixed case)
const generatePassword = (length = 10) => {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const all = upper + lower;
  let password = '';
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  for (let i = 2; i < length; i++) {
    password += all[Math.floor(Math.random() * all.length)];
  }
  return password.split('').sort(() => Math.random() - 0.5).join('');
};

module.exports = { sendEmail, generateOTP, generatePassword, isEmailConfigured };
