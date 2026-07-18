/**
 * Test email config:  node scripts/testEmail.js you@gmail.com
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sendEmail, isEmailConfigured } = require('../utils/email');

async function main() {
  const to = process.argv[2] || process.env.EMAIL_USER;
  console.log('Configured for real SMTP?', isEmailConfigured());
  console.log('EMAIL_USER:', process.env.EMAIL_USER);
  if (!to || to === 'your_email@gmail.com') {
    console.log('Usage: node scripts/testEmail.js your@gmail.com');
    console.log('First set EMAIL_USER and EMAIL_PASS in server/.env');
    process.exit(1);
  }
  const ok = await sendEmail(
    to,
    'Nexora test email',
    '<p>If you see this, <strong>Step 5 email</strong> works.</p>'
  );
  console.log(ok ? 'Send call finished (check inbox / spam / console mock)' : 'Send failed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
