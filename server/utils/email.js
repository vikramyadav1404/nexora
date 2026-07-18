const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const sendEmail = async (to, subject, html) => {
  try {
    if (!process.env.EMAIL_USER || process.env.EMAIL_USER === 'your_email@gmail.com') {
      console.log(`📧 [MOCK EMAIL] To: ${to} | Subject: ${subject}`);
      console.log(`📧 Content: ${html.replace(/<[^>]*>/g, '')}`);
      return true;
    }
    await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, html });
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
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
  // Ensure at least one uppercase and one lowercase
  password += upper[Math.floor(Math.random() * upper.length)];
  password += lower[Math.floor(Math.random() * lower.length)];
  for (let i = 2; i < length; i++) {
    password += all[Math.floor(Math.random() * all.length)];
  }
  // Shuffle
  return password.split('').sort(() => Math.random() - 0.5).join('');
};

module.exports = { sendEmail, generateOTP, generatePassword };
