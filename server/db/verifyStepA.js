/**
 * Verify Supabase connection + required tables + auth smoke test.
 * Usage: npm run verify:supabase
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const REQUIRED_TABLES = [
  'users',
  'posts',
  'post_media',
  'post_likes',
  'post_comments',
  'questions',
  'answers',
  'question_votes',
  'answer_votes',
  'friendships',
  'friend_requests',
  'follows',
  'transactions',
  'point_transfers',
  'notifications',
  'bookmarks',
  'blocks',
  'reports'
];

function isPlaceholder(url, key) {
  if (!url || !key) return true;
  return ['YOUR_PROJECT_REF', 'your_service_role_key', 'your_service_role_key_here', 'xxxxxxxx'].some(
    b => url.includes(b) || key.includes(b)
  );
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  console.log('\n🔍 Nexora — Supabase verification\n');

  if (isPlaceholder(url, key)) {
    console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY still placeholders.');
    console.error('   Edit server/.env with real values from Supabase → Project Settings → API\n');
    process.exit(1);
  }

  if (process.env.DEMO_MODE === 'true' || process.env.DEMO_MODE === '1') {
    console.warn('⚠️  DEMO_MODE=true — set DEMO_MODE=false to use Supabase in the app.\n');
  }

  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let failed = false;

  for (const table of REQUIRED_TABLES) {
    const { error } = await db.from(table).select('*').limit(1);
    if (error) {
      console.error(`  ✗ ${table}: ${error.message}`);
      failed = true;
    } else {
      console.log(`  ✓ ${table}`);
    }
  }

  if (failed) {
    console.error('\n❌ Missing tables. Run server/db/setup_step_a.sql in Supabase SQL Editor.\n');
    process.exit(1);
  }

  // Smoke: insert + delete test user
  const testEmail = `nexora.verify.${Date.now()}@nexora.test`;
  const hash = await bcrypt.hash('VerifyTest123', 10);
  const { data: created, error: cErr } = await db
    .from('users')
    .insert({
      name: 'Nexora Verify',
      email: testEmail,
      password: hash,
      gender: 'prefer-not-to-say',
      interests: ['technology'],
      onboarding_completed: true
    })
    .select('id, email')
    .single();

  if (cErr) {
    console.error('\n❌ Auth write failed:', cErr.message);
    if (cErr.message?.includes('gender') || cErr.message?.includes('column')) {
      console.error('   Re-run setup_step_a.sql (adds gender/interests/feature columns).');
    }
    process.exit(1);
  }

  const { data: found, error: rErr } = await db
    .from('users')
    .select('id, email, name')
    .eq('email', testEmail)
    .single();

  if (rErr || !found) {
    console.error('\n❌ Auth read failed:', rErr?.message);
    process.exit(1);
  }

  // Notification write smoke
  const { error: nErr } = await db.from('notifications').insert({
    user_id: created.id,
    type: 'info',
    title: 'Verify OK',
    body: 'smoke test'
  });
  if (nErr) {
    console.error('\n❌ Notifications write failed:', nErr.message);
    await db.from('users').delete().eq('id', created.id);
    process.exit(1);
  }

  // Cleanup
  await db.from('notifications').delete().eq('user_id', created.id);
  await db.from('users').delete().eq('id', created.id);

  console.log('\n✅ Database OK — auth + features read/write work');
  console.log('   Next: DEMO_MODE=false → npm run dev → register a real user\n');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
