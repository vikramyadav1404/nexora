const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');
const { sendEmail } = require('../utils/email');
const { sendError } = require('../utils/respond');

/**
 * Scheduled jobs, triggered by Vercel Cron (see server/vercel.json).
 *
 * Nothing in this app ran on a schedule before: the "weekly digest" only fired
 * when a user clicked a button and returned JSON to the browser rather than
 * emailing anyone, and abandoned checkouts sat in `pending` forever.
 *
 * Budget note: Vercel's free Hobby plan allows only TWO cron jobs, so the
 * maintenance work is combined into one daily job rather than one slot each.
 *
 * These are not behind `protect` — the caller is Vercel, not a user — so a
 * shared secret is the authentication.
 */

function authorize(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({ message: 'CRON_SECRET is not set' });
    return false;
  }

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  return true;
}

/* ── job bodies ──────────────────────────────────────────────
   Plain async functions returning data, so both the individual
   routes and the combined daily job can call them.            */

/**
 * Expires checkouts nobody ever completed. Without this the user's billing
 * history shows a `pending` row forever, and we have no signal that a payment
 * may have been captured without the callback landing.
 */
async function sweepTransactions() {
  const db = getSupabase();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: stale, error } = await db
    .from('transactions')
    .select('id, user_id, plan, razorpay_order_id, created_at')
    .eq('status', 'pending')
    .lt('created_at', cutoff);

  if (error) throw error;
  if (!stale?.length) return { expired: 0 };

  const { error: upErr } = await db
    .from('transactions')
    .update({ status: 'failed' })
    .in('id', stale.map(t => t.id));
  if (upErr) throw upErr;

  // Worth a human look: a real payment may have been captured while the
  // callback never arrived, which the webhook would normally have repaired.
  console.warn(JSON.stringify({
    level: 'warn',
    job: 'sweep-transactions',
    message: 'expired abandoned checkouts',
    count: stale.length,
    orderIds: stale.map(t => t.razorpay_order_id)
  }));

  return { expired: stale.length };
}

async function sweepRateLimits() {
  const { data, error } = await getSupabase().rpc('rate_limit_sweep');
  if (error) throw error;
  return { deleted: data ?? 0 };
}

/** Emails each verified user a recap of the week in their interest areas. */
async function weeklyDigest() {
  const db = getSupabase();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: users } = await db
    .from('users')
    .select('id, name, email, interests')
    .eq('is_active', true)
    .eq('email_verified', true)
    .limit(500);

  if (!users?.length) return { sent: 0, candidates: 0 };

  // Pull the week's content once and slice it per user, rather than running a
  // query per recipient.
  const [{ data: questions }, { data: posts }] = await Promise.all([
    db.from('questions').select('id, title, tags, views, created_at')
      .gte('created_at', since).order('views', { ascending: false }).limit(50),
    db.from('posts').select('id, content, interest_tags, shares, created_at')
      .gte('created_at', since).eq('is_public', true)
      .order('shares', { ascending: false }).limit(50)
  ]);

  let sent = 0;
  for (const user of users) {
    const interests = user.interests || [];
    if (!interests.length) continue;

    const qs = (questions || [])
      .filter(q => (q.tags || []).some(t => interests.includes(t))).slice(0, 5);
    const ps = (posts || [])
      .filter(p => (p.interest_tags || []).some(t => interests.includes(t))).slice(0, 3);

    // Don't email someone an empty digest.
    if (!qs.length && !ps.length) continue;

    const html = `
      <div style="font-family:Arial;max-width:560px;margin:auto;padding:24px">
        <h2>Your week on Nexora</h2>
        <p>Hi ${user.name}, here is what happened in ${interests.slice(0, 3).join(', ')}.</p>
        ${qs.length ? `<h3>Questions worth a look</h3><ul>${
          qs.map(q => `<li>${q.title}</li>`).join('')
        }</ul>` : ''}
        ${ps.length ? `<h3>Posts people shared</h3><ul>${
          ps.map(p => `<li>${String(p.content || '').slice(0, 120)}…</li>`).join('')
        }</ul>` : ''}
        <p style="color:#888;font-size:12px">You can turn digests off in Settings.</p>
      </div>`;

    try {
      await sendEmail(user.email, 'Your week on Nexora', html);
      sent += 1;
    } catch {
      /* one bad address must not stop the run */
    }
  }

  return { sent, candidates: users.length };
}

/**
 * Delete profile-media objects no user row points at.
 *
 * Two ways these appear: a browser that got a signed upload URL, PUT the file,
 * then closed the tab before calling PATCH, and a `cleanupPrevious` delete that
 * failed after a successful replace. Neither is worth failing a user request
 * over, so they accumulate here instead and get collected once a day.
 *
 * This is the one place a bucket listing is acceptable — it runs on a schedule,
 * never on a request path.
 */
async function sweepOrphanedMedia() {
  const { KIND_CONFIG, deleteObject } = require('../utils/mediaStorage');
  const db = getSupabase();
  let removed = 0;
  let scanned = 0;

  for (const [kind, { bucket }] of Object.entries(KIND_CONFIG)) {
    const keyColumn = kind === 'avatar' ? 'avatar_key' : 'cover_key';

    const { data: rows } = await db
      .from('users')
      .select(keyColumn)
      .neq(keyColumn, '');
    const live = new Set((rows || []).map(r => r[keyColumn]).filter(Boolean));

    // Avatar thumbnails are derived from the parent key, so they are live too.
    if (kind === 'avatar') {
      for (const key of [...live]) {
        live.add(key.replace(/\.([a-z0-9]+)$/i, '') + '-128.webp');
      }
    }

    const { data: users } = await db.from('users').select('id').limit(1000);
    for (const user of users || []) {
      const prefix = `users/${user.id}/${kind}`;
      const { data: objects } = await db.storage.from(bucket).list(prefix, { limit: 100 });
      for (const obj of objects || []) {
        scanned += 1;
        const key = `${prefix}/${obj.name}`;
        if (live.has(key)) continue;

        // Grace period: an upload in flight has no row pointing at it yet.
        const age = Date.now() - new Date(obj.created_at || obj.updated_at || 0).getTime();
        if (age < 60 * 60 * 1000) continue;

        if (await deleteObject(bucket, key)) removed += 1;
      }
    }
  }

  return { scanned, removed };
}

/* ── routes ──────────────────────────────────────────────── */

/**
 * POST /api/cron/daily — cron slot 1 of 2.
 *
 * Runs all maintenance in one job, and by querying the database daily it also
 * keeps the Supabase project from going idle. One job failing does not stop
 * the others; the response reports each independently.
 */
router.post('/daily', async (req, res) => {
  if (!authorize(req, res)) return;

  const result = {
    ok: true,
    transactions: null, rateLimits: null, orphanedMedia: null, refreshTokens: null,
    errors: []
  };

  for (const [name, job] of [
    ['transactions', sweepTransactions],
    ['rateLimits', sweepRateLimits],
    ['orphanedMedia', sweepOrphanedMedia],
    // Rotation writes a row per refresh — roughly 96 per active user per day at
    // a 15-minute access lifetime. Without this the table only grows.
    ['refreshTokens', require('../utils/tokens').sweepRefreshTokens]
  ]) {
    try {
      result[name] = await job();
    } catch (err) {
      result.ok = false;
      result.errors.push(`${name}: ${err.message}`);
    }
  }

  // 207 = partial success, so a failure is visible in Vercel's cron log.
  res.status(result.ok ? 200 : 207).json(result);
});

/** POST /api/cron/weekly-digest — cron slot 2 of 2. */
router.post('/weekly-digest', async (req, res) => {
  if (!authorize(req, res)) return;
  try {
    res.json(await weeklyDigest());
  } catch (err) {
    sendError(res, err, req, 'Digest run failed');
  }
});

/**
 * ANY /api/cron/keepalive
 *
 * Touches the database so Supabase does not consider the project idle.
 *
 * This is not optional housekeeping — it is why the project stays alive. A free
 * Supabase project pauses after roughly a week without database activity, and a
 * project left paused long enough is deleted. That is exactly how the previous
 * database was lost.
 *
 * Answers GET as well as POST, and needs no secret, so any free uptime monitor
 * (cron-job.org, UptimeRobot) can call it. It writes nothing and returns no
 * private data, so leaving it open costs nothing.
 */
router.all('/keepalive', async (req, res) => {
  try {
    // A real read against a real table — a HEAD request may not register as
    // activity, so fetch one cheap row.
    const { error } = await getSupabase().from('users').select('id').limit(1);
    if (error) throw error;

    res.set('Cache-Control', 'no-store');
    res.json({ alive: true, db: 'reachable', at: new Date().toISOString() });
  } catch (err) {
    // Surface loudly — if this starts failing, the project is heading for a
    // pause and someone needs to notice.
    console.error(JSON.stringify({
      level: 'error',
      job: 'keepalive',
      message: 'database unreachable — project may pause',
      detail: err.message
    }));
    res.status(503).json({ alive: false, db: 'unreachable' });
  }
});

// Kept individually addressable for manual runs and debugging.
router.post('/sweep-transactions', async (req, res) => {
  if (!authorize(req, res)) return;
  try { res.json(await sweepTransactions()); }
  catch (err) { sendError(res, err, req, 'Sweep failed'); }
});

router.post('/sweep-rate-limits', async (req, res) => {
  if (!authorize(req, res)) return;
  try { res.json(await sweepRateLimits()); }
  catch (err) { sendError(res, err, req, 'Sweep failed'); }
});

module.exports = router;
