#!/usr/bin/env node
/**
 * Fill a staging database with synthetic people and content.
 *
 * Usage:
 *   APP_ENV=staging node scripts/seed-staging.js --confirm <project-ref>
 *
 * ------------------------------------------------------------------
 * Synthetic, never a copy of production
 * ------------------------------------------------------------------
 * Copying production into staging would put 29 real people's email addresses
 * and phone numbers in a second place, with weaker access control and more
 * people holding the keys. This month already produced one contact-detail leak;
 * a staging clone would be a standing invitation to a second.
 *
 * Every account here is generated, on @nexora.invalid -- reserved by RFC 2606,
 * so those addresses can never route anywhere real even if something tries to
 * send to them.
 *
 * The guards are in utils/seedGuard.js. The one that matters asks the target
 * database whether it contains anyone real, because config describes intent and
 * intent is what is wrong when someone runs the wrong command.
 */

require('dotenv').config();

const { getSupabase } = require('../db/supabase');
const { hashPassword } = require('../db/helpers');
const { INTERESTS } = require('../db/interests');
const { inspectTarget, configObjections } = require('../utils/seedGuard');

const PASSWORD = 'StagingOnly123!';
const PEOPLE = 12;

const FIRST = ['Asha', 'Rohan', 'Meera', 'Dev', 'Nisha', 'Kabir', 'Priya', 'Arjun', 'Sana', 'Vikram', 'Tara', 'Imran'];
const LAST = ['Rao', 'Sharma', 'Iyer', 'Khan', 'Patel', 'Nair', 'Bose', 'Gupta', 'Reddy', 'Menon', 'Shah', 'Das'];

const BIOS = [
  'Testing things that should not be tested in production.',
  'Synthetic account. Nothing here is real.',
  'Exists so a page has something to render.',
  'Generated for staging. Not a person.'
];

const QUESTIONS = [
  ['How does the posting quota actually work?', 'It says my allowance depends on connections. What is the exact rule?'],
  ['Is there a way to page past 50 search results?', 'I hit a ceiling and cannot get further.'],
  ['What happens to my points if I downvote and then undo it?', 'Asking because the number moved oddly.']
];

const ANSWERS = [
  'Your daily allowance is a function of network size, not your plan.',
  'Not currently — the ranked search caps at 50 and has no cursor.',
  'The point is returned only if one was actually taken.'
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (...a) => console.log(' ', ...a);

/**
 * Refuse, and let the process end on its own.
 *
 * Not process.exit(). The Supabase client holds open handles, and tearing the
 * event loop down underneath them aborts on Windows with a libuv assertion --
 * which overrode the exit code, so a deliberate refusal reported 127 instead of
 * 1. A caller reading exit codes would see a crash rather than a decision, and
 * those mean different things: one is "I checked and the answer is no", the
 * other is "something went wrong and you do not know what state you are in".
 *
 * Setting exitCode and returning lets Node drain and exit with the code that
 * was actually intended.
 */
function refuse() {
  process.exitCode = 1;
}

async function main() {
  const confirmRef = arg('--confirm');

  /* Layer one: config. Cheap, early, clearer message -- not the real guard. */
  const objections = configObjections({
    appEnv: process.env.APP_ENV,
    supabaseUrl: process.env.SUPABASE_URL,
    confirmRef
  });

  if (objections.length) {
    console.error('\nRefusing to seed:\n');
    for (const o of objections) console.error('  - ' + o);
    console.error('\nUsage: APP_ENV=staging node scripts/seed-staging.js --confirm <project-ref>\n');
    return refuse();
  }

  const db = getSupabase();

  /* Layer two: the database itself. This is the one that protects production. */
  log('Checking the target holds nobody real…');
  const target = await inspectTarget(db);

  if (!target.safe) {
    console.error(
      `\nRefusing to seed: this database contains ${target.real} account(s) ` +
      `that are not synthetic, out of ${target.total}.\n`
    );
    for (const e of target.examples) console.error('  - ' + e);
    console.error(
      '\nA database with real people in it is not a staging database, whatever\n' +
      'APP_ENV says. Check SUPABASE_URL.\n'
    );
    return refuse();
  }

  log(`Target holds ${target.total} account(s), all synthetic. Proceeding.\n`);

  const password = await hashPassword(PASSWORD);
  const created = [];

  for (let i = 0; i < PEOPLE; i += 1) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
    const email = `person${String(i + 1).padStart(2, '0')}@nexora.invalid`;
    const interests = [INTERESTS[i % INTERESTS.length].id, INTERESTS[(i + 3) % INTERESTS.length].id];

    const { data, error } = await db.from('users').upsert({
      name,
      email,
      password,
      bio: BIOS[i % BIOS.length],
      gender: i % 2 ? 'female' : 'male',
      language: 'en',
      interests,
      email_verified: true,
      is_active: true,
      onboarding_completed: true,
      points: 40 + i * 17,
      total_answers: i % 5,
      // free|bronze|silver|gold -- users_subscription_plan_check. 'pro' is not
      // a plan this schema allows, and the constraint is the authority.
      subscription_plan: i === 0 ? 'gold' : 'free'
    }, { onConflict: 'email' }).select('id, name, email').single();

    if (error) throw new Error(`creating ${email}: ${error.message}`);
    created.push(data);
    log(`user  ${data.email}  ${data.name}`);
  }

  // Friendships: a small connected cluster, so the quota rules have something
  // to compute against and Profile has a friend count to show.
  let friendships = 0;
  for (let i = 0; i < 6; i += 1) {
    for (const [a, b] of [[created[i].id, created[i + 1].id], [created[i + 1].id, created[i].id]]) {
      const { error } = await db.from('friendships').upsert(
        { user_id: a, friend_id: b }, { onConflict: 'user_id,friend_id' }
      );
      if (!error) friendships += 1;
    }
  }
  log(`\nfriendships: ${friendships}`);

  let questions = 0;
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    const [title, body] = QUESTIONS[i];
    const { data: q, error } = await db.from('questions').insert({
      author_id: created[i].id,
      title,
      body,
      tags: [INTERESTS[i % INTERESTS.length].id]
    }).select('id').single();

    if (error) { log(`question skipped: ${error.message}`); continue; }
    questions += 1;

    await db.from('answers').insert({
      question_id: q.id,
      author_id: created[i + 1].id,
      body: ANSWERS[i]
    });
  }
  log(`questions:   ${questions} (each with one answer)`);

  let posts = 0;
  for (let i = 0; i < 8; i += 1) {
    const { error } = await db.from('posts').insert({
      author_id: created[i % created.length].id,
      content: `Synthetic post ${i + 1}. Staging only.`,
      is_public: true,
      interest_tags: [INTERESTS[i % INTERESTS.length].id]
    });
    if (!error) posts += 1;
  }
  log(`posts:       ${posts}`);

  console.log(`\n  Done. ${created.length} accounts, password: ${PASSWORD}\n`);
}

main().catch((err) => {
  console.error('\nSeed failed:', err.message, '\n');
  refuse();
});
