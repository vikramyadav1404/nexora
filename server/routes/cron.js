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

/**
 * Escape a value for interpolation into HTML email.
 *
 * The weekly digest built its markup with template literals straight from user
 * content -- the recipient's name, their interest tags, question titles and
 * post bodies. Question titles are the sharpest of those: nothing strips markup
 * on the way in (text is stored as typed, by design), so a question titled
 * `<a href="https://evil.example">Reset your password</a>` was delivered as a
 * live link, from this platform's address, to every verified user sharing that
 * interest. Tracking pixels via <img> would have worked the same way, and a
 * post body sliced at 120 characters could truncate mid-tag and corrupt the
 * rest of the message.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
        <p>Hi ${escapeHtml(user.name)}, here is what happened in ${escapeHtml(interests.slice(0, 3).join(', '))}.</p>
        ${qs.length ? `<h3>Questions worth a look</h3><ul>${
          qs.map(q => `<li>${escapeHtml(q.title)}</li>`).join('')
        }</ul>` : ''}
        ${ps.length ? `<h3>Posts people shared</h3><ul>${
          ps.map(p => `<li>${escapeHtml(String(p.content || '').slice(0, 120))}…</li>`).join('')
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
 * Where the live keys for each media kind actually live.
 *
 * This used to be `kind === 'avatar' ? 'avatar_key' : 'cover_key'`, which was
 * correct for exactly as long as there were two kinds. A third, 'post', was
 * added to KIND_CONFIG later, and that ternary silently answered 'cover_key'
 * for it -- so the sweep compared post objects against the set of cover keys,
 * found no match by construction, and deleted every post attachment in the
 * bucket. Post keys are recorded in post_media.storage_key (migration 011),
 * a table this function never consulted.
 *
 * An explicit map means a kind added later has no entry, and the sweep skips
 * that bucket rather than guessing a column. Skipping leaks orphans; guessing
 * deletes live files. Only one of those is recoverable.
 */
const LIVE_KEY_SOURCES = {
  avatar: { table: 'users', column: 'avatar_key' },
  cover: { table: 'users', column: 'cover_key' },
  post: { table: 'post_media', column: 'storage_key' }
};

/** PostgREST caps a response; page explicitly rather than trusting one call. */
const LIVE_KEY_PAGE = 1000;

/**
 * Every key of one kind that something still points at.
 *
 * Throws rather than returning a partial set. A caller that treats "I could not
 * read the live keys" as "there are no live keys" deletes everything, which is
 * exactly what the discarded error here used to cause: one statement timeout on
 * this query emptied the set and the sweep removed every avatar and cover on
 * the platform.
 */
async function loadLiveKeys(db, kind) {
  const source = LIVE_KEY_SOURCES[kind];
  if (!source) return null; // unknown kind -- caller skips the bucket

  const live = new Set();
  for (let from = 0; ; from += LIVE_KEY_PAGE) {
    const { data, error } = await db
      .from(source.table)
      .select(source.column)
      .neq(source.column, '')
      .range(from, from + LIVE_KEY_PAGE - 1);

    if (error) {
      throw new Error(`live-key lookup failed for ${kind}: ${error.message}`);
    }

    for (const row of data || []) {
      if (row[source.column]) live.add(row[source.column]);
    }

    // A short page is the last page.
    if (!data || data.length < LIVE_KEY_PAGE) break;
  }

  // Avatar thumbnails are derived from the parent key, so they are live too.
  if (kind === 'avatar') {
    for (const key of [...live]) {
      live.add(key.replace(/\.([a-z0-9]+)$/i, '') + '-128.webp');
    }
  }

  return live;
}

/**
 * Delete media objects nothing points at any more.
 *
 * Two ways these appear: a browser that got a signed upload URL, PUT the file,
 * then closed the tab before calling PATCH, and a `cleanupPrevious` delete that
 * failed after a successful replace. Neither is worth failing a user request
 * over, so they accumulate here instead and get collected once a day.
 *
 * Only objects written by the presigned path are in scope -- those use
 * `users/<id>/<kind>/<uuid>.<ext>` (mediaStorage.buildKey). The older multipart
 * path writes `<id>/<timestamp>-<rand>.<ext>` instead, which this prefix
 * listing never sees, so those are neither swept nor collected.
 *
 * This is the one place a bucket listing is acceptable — it runs on a schedule,
 * never on a request path.
 */
/**
 * How much of a scan may be deleted in one run before it is treated as a bug.
 *
 * Both times this job was wrong it was wrong the same way: it concluded that
 * nearly everything was an orphan. The `cover_key` ternary made every post
 * attachment unmatched by construction; the discarded error emptied the live
 * set so nothing matched at all. In both cases the candidate list would have
 * been close to 100% of what was scanned.
 *
 * So that ratio is the signal. A run over the ceiling stops and reports rather
 * than deleting, which turns the failure that has now happened twice into a
 * loud no-op. The floor exists because ratios are meaningless on small numbers
 * -- deleting 2 of 3 genuinely orphaned objects is 67% and completely normal.
 *
 * Deleting nothing is always recoverable. Deleting everything is not. When the
 * two readings disagree, this picks the recoverable one.
 */
const BREAKER_MAX_SHARE = 0.25;
const BREAKER_FLOOR = 10;

/**
 * @param {object}  [options]
 * @param {boolean} [options.dryRun]   report what would be deleted, delete nothing
 * @param {boolean} [options.force]    proceed even if the breaker would trip
 */
async function sweepOrphanedMedia({ dryRun = false, force = false } = {}) {
  const { KIND_CONFIG, deleteObject } = require('../utils/mediaStorage');
  const db = getSupabase();
  let scanned = 0;
  const skipped = [];

  /*
   * Two phases, and the split is what makes the breaker possible: every
   * candidate is collected before anything is deleted. Deciding per-object, as
   * this used to, means the thousandth bad deletion is as unstoppable as the
   * first -- there is no point at which the job can notice it is deleting far
   * more than it should.
   */
  const candidates = [];

  for (const [kind, { bucket }] of Object.entries(KIND_CONFIG)) {
    const live = await loadLiveKeys(db, kind);

    if (live === null) {
      // A kind nothing knows how to resolve. Leaving its objects alone is the
      // only safe answer -- see LIVE_KEY_SOURCES.
      skipped.push(kind);
      continue;
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
        const ageMs = Date.now() - new Date(obj.created_at || obj.updated_at || 0).getTime();
        if (ageMs < 60 * 60 * 1000) continue;

        candidates.push({
          bucket,
          kind,
          key,
          ageHours: Math.round(ageMs / 3_600_000),
          reason: `no row in ${LIVE_KEY_SOURCES[kind].table}.${LIVE_KEY_SOURCES[kind].column} references it`
        });
      }
    }
  }

  const ceiling = Math.max(BREAKER_FLOOR, Math.floor(scanned * BREAKER_MAX_SHARE));
  const wouldTrip = candidates.length > ceiling;

  const report = {
    dryRun,
    scanned,
    candidates: candidates.length,
    keys: candidates,
    ...(skipped.length ? { skipped } : {})
  };

  if (wouldTrip && !force) {
    /*
     * Reported as ok:false with removed:0 rather than thrown. A throw here
     * would be swallowed into /daily's errors array and read as "the job broke"
     * -- which is a different fact from "the job worked and what it found looks
     * wrong". The second one needs a human to look at it.
     */
    return {
      ...report,
      removed: 0,
      aborted: true,
      reason:
        `would delete ${candidates.length} of ${scanned} scanned objects, over the ` +
        `${Math.round(BREAKER_MAX_SHARE * 100)}% ceiling (${ceiling}). Refusing. ` +
        `Re-run with force:true if this is genuinely correct.`
    };
  }

  if (dryRun) return { ...report, removed: 0 };

  let removed = 0;
  for (const c of candidates) {
    if (await deleteObject(c.bucket, c.key)) removed += 1;
  }

  return { ...report, removed };
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
    /*
     * dryRun:false spelled out. It is the default, so this changes nothing --
     * which is the point: the one caller that deletes should say so at the call
     * site, rather than deleting because nobody passed an argument. If the
     * default is ever flipped to safe, this line keeps working and stays true.
     */
    ['orphanedMedia', () => sweepOrphanedMedia({ dryRun: false })],
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

/**
 * POST /api/cron/sweep-media — the human entry point, dry by default.
 *
 * The nightly job deletes; this one reports unless told otherwise. That
 * asymmetry is deliberate: the scheduled caller has been configured once, on
 * purpose, and knows what it is doing. A person reaching for this route is
 * usually trying to find out what it *would* do, and the cost of guessing
 * wrong is objects nobody can get back.
 *
 * Deleting requires `{"confirm":"delete"}` in the body. Not a boolean --
 * `{"dryRun":false}` is one typo away from being sent by something that meant
 * the opposite, and a word cannot be arrived at by accident.
 */
router.post('/sweep-media', async (req, res) => {
  if (!authorize(req, res)) return;

  const confirmed = req.body?.confirm === 'delete';
  const force = req.body?.force === true;

  try {
    const result = await sweepOrphanedMedia({ dryRun: !confirmed, force });
    // 409 when the breaker stopped it: the request was understood and refused,
    // which a 200 would hide from anything reading status codes.
    res.status(result.aborted ? 409 : 200).json(result);
  } catch (err) {
    sendError(res, err, req, 'Sweep failed');
  }
});

module.exports = router;

// Exported for test/cronSweep.test.mjs. This job deletes things nobody can get
// back, so it needs to be reachable directly rather than only through the route.
module.exports.__sweepOrphanedMedia = sweepOrphanedMedia;
