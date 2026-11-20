/**
 * A minimal in-memory stand-in for the Supabase JS client.
 *
 * The tests run the real routers against this, never against a second
 * implementation of the API, so what passes here is the code that ships.
 *
 * This implements just enough of the PostgREST builder that the real routers
 * use: from().select().eq().maybeSingle()/single(), insert, update, delete,
 * plus rpc(). It is intentionally small; when a route needs an operator this
 * doesn't support, add it here rather than reaching for a live database.
 */

function compare(row, op, col, val) {
  if (op === 'eq') return row[col] === val;
  if (op === 'neq') return row[col] !== val;
  if (op === 'in') return val.includes(row[col]);
  // PostgREST `.is(col, null)` means IS NULL, which is not the same as === null:
  // an absent property must match too, since the column simply has no value.
  if (op === 'is') return val === null ? row[col] == null : row[col] === val;
  if (op === 'lt') return row[col] != null && row[col] < val;
  if (op === 'gt') return row[col] != null && row[col] > val;
  if (op === 'or') return val.some(([o, c, v]) => compare(row, o, c, v));
  /*
   * PostgREST `.contains(col, [a, b])` is the array `@>` operator: the column
   * must contain *every* listed value. Used by spaces.js on posts.interest_tags
   * and questions.tags. Implemented rather than stubbed for the reason in the
   * parseOr note below — an operator that silently matches everything turns a
   * filtered query into a full scan and still looks like a passing test.
   */
  if (op === 'contains') {
    const cell = row[col];
    if (!Array.isArray(cell)) return false;
    return (Array.isArray(val) ? val : [val]).every(v => cell.includes(v));
  }
  return true;
}

function matches(row, filters) {
  return filters.every(([op, col, val]) => compare(row, op, col, val));
}

/**
 * Parse the PostgREST `.or()` string form, e.g.
 *   "expires_at.lt.2026-01-01,revoked_at.lt.2025-12-01"
 *
 * Only the operators this codebase actually passes to `.or()` are handled.
 * Previously `.or()` was a no-op returning `this`, which silently matched every
 * row — harmless on a select, but on the DELETE in sweepRefreshTokens it would
 * have wiped the table and looked like a pass.
 */
function parseOr(expr) {
  return String(expr)
    .split(',')
    .map(part => {
      const [col, op, ...rest] = part.split('.');
      return [op, col, rest.join('.')];
    })
    .filter(([op]) => op);
}

class Query {
  constructor(table, rows, op = 'select', payload = null) {
    this.table = table;
    this.rows = rows;
    this.op = op;
    this.payload = payload;
    this.filters = [];
    this._limit = null;
    this._range = null;
    this._wantCount = false;
    this._headOnly = false;
  }

  /**
   * `select('*', { count: 'exact', head: true })` asks for a count and no rows.
   *
   * Returning `this` and nothing else made every such call resolve with
   * `count: undefined`. Routes read that as zero — POST /api/posts computes the
   * daily allowance from friend and follow counts, saw a network of 0, and
   * refused every post with a 403 that looked like a permissions bug.
   */
  select(_fields, opts) {
    if (opts?.count) this._wantCount = true;
    if (opts?.head) this._headOnly = true;
    return this;
  }
  order() { return this; }
  eq(col, val) { this.filters.push(['eq', col, val]); return this; }
  neq(col, val) { this.filters.push(['neq', col, val]); return this; }
  in(col, val) { this.filters.push(['in', col, val]); return this; }
  is(col, val) { this.filters.push(['is', col, val]); return this; }
  lt(col, val) { this.filters.push(['lt', col, val]); return this; }
  gt(col, val) { this.filters.push(['gt', col, val]); return this; }
  or(expr) { this.filters.push(['or', null, parseOr(expr)]); return this; }
  contains(col, val) { this.filters.push(['contains', col, val]); return this; }
  ilike() { return this; }
  limit(n) { this._limit = n; return this; }
  /*
   * Inclusive on both ends, as PostgREST is. Added for the cron media sweep,
   * which pages the live-key set explicitly rather than trusting one response
   * to hold every row -- a truncated live set is what makes it delete files
   * that are still in use.
   */
  range(from, to) { this._range = [from, to]; return this; }

  _found() {
    return this.rows.filter(r => matches(r, this.filters));
  }

  _run() {
    if (this.op === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const created = items.map(item => ({
        id: item.id || `row_${Math.random().toString(36).slice(2, 10)}`,
        created_at: new Date().toISOString(),
        ...item
      }));
      this.rows.push(...created);
      return created;
    }
    if (this.op === 'update') {
      const hits = this._found();
      hits.forEach(r => Object.assign(r, this.payload));
      return hits;
    }
    if (this.op === 'delete') {
      const hits = this._found();
      for (const r of hits) this.rows.splice(this.rows.indexOf(r), 1);
      return hits;
    }
    const found = this._found();
    if (this._range) {
      const [from, to] = this._range;
      return found.slice(from, to + 1);
    }
    return this._limit ? found.slice(0, this._limit) : found;
  }

  maybeSingle() { return Promise.resolve({ data: this._run()[0] || null, error: null }); }

  single() {
    const row = this._run()[0];
    return Promise.resolve(
      row ? { data: row, error: null } : { data: null, error: { message: 'No rows found' } }
    );
  }

  // Awaiting the builder directly resolves the query, same as the real client.
  then(resolve, reject) {
    try {
      const rows = this._run();
      const out = { data: this._headOnly ? null : rows, error: null };
      // Counts ignore limit, matching PostgREST: `count` is the size of the
      // filtered set, not of the page returned.
      if (this._wantCount) out.count = this._found().length;
      return Promise.resolve(out).then(resolve, reject);
    } catch (err) {
      return Promise.resolve({ data: null, error: err }).then(resolve, reject);
    }
  }
}

/** Mirrors compute_badges (005) — the thresholds the SQL functions use. */
function fakeBadges(points, answers) {
  const badges = [];
  if (points >= 50) badges.push('bronze');
  if (points >= 200) badges.push('silver');
  if (points >= 500) badges.push('gold');
  if (answers >= 10) badges.push('contributor');
  if (answers >= 50) badges.push('expert');
  return badges;
}

function createFakeSupabase(seed = {}) {
  const tables = {
    users: [],
    transactions: [],
    point_transfers: [],
    notifications: [],
    posts: [],
    follows: [],
    blocks: [],
    ...seed
  };

  /**
   * The real named parameters of each SQL function, from the migration files.
   *
   * PostgREST matches an RPC call by its named parameters; a call with a wrong
   * name returns PGRST202 (function not found for that signature). So the fake
   * reimplementing a function is not enough — if a caller drifts from
   * `p_from_user` to `p_sender`, the real DB would refuse the call while the
   * fake, destructuring by name, would read `undefined` and quietly compute the
   * wrong answer. That exact drift is what made a production probe wrong during
   * the audit.
   *
   * assertRpcSignature turns that silent divergence into a loud test failure:
   * an unknown or missing parameter throws here, where a test will see it.
   */
  const RPC_SIGNATURES = {
    admin_set_user_active: { required: ['p_actor', 'p_user', 'p_active'] },
    admin_update_report: { required: ['p_actor', 'p_report', 'p_status'], optional: ['p_note'] },
    apply_vote_points: { required: ['p_user_id', 'p_points_delta', 'p_upvotes_delta'] },
    claim_daily_quota: { required: ['p_user_id', 'p_kind', 'p_limit'] },
    apply_subscription_event: {
      required: ['p_event_id', 'p_event_type', 'p_event_at', 'p_subscription_id'],
      optional: ['p_status', 'p_plan', 'p_current_end', 'p_payment_id', 'p_amount', 'p_grace_days']
    },
    transfer_points: { required: ['p_from_user', 'p_to_user', 'p_points'], optional: ['p_message'] },
    rate_limit_hit: { required: ['p_key', 'p_window_ms'] },
    rate_limit_reset: { required: ['p_key'] },
    cast_answer_vote: { required: ['p_answer_id', 'p_voter_id', 'p_type'] },
    create_answer: { required: ['p_question_id', 'p_author_id', 'p_body'] },
    delete_answer: { required: ['p_answer_id', 'p_author_id'] }
  };

  function assertRpcSignature(name, args = {}) {
    const sig = RPC_SIGNATURES[name];
    if (!sig) return; // handler with no declared signature — nothing to check
    const allowed = new Set([...(sig.required || []), ...(sig.optional || [])]);

    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        throw new Error(
          `fakeSupabase: rpc('${name}') called with unexpected parameter '${key}'. ` +
          `The real function takes (${[...allowed].join(', ')}); PostgREST would ` +
          `answer PGRST202 for this call. A parameter-name drift is a real bug — ` +
          `fix the caller, not this guard.`
        );
      }
    }
    for (const key of sig.required || []) {
      if (!(key in args)) {
        throw new Error(
          `fakeSupabase: rpc('${name}') is missing required parameter '${key}'. ` +
          `The real function would not match this call.`
        );
      }
    }
  }

  const rpcHandlers = {
    /*
     * Mirror migration 023's admin functions. The audit row the real trigger
     * writes is mirrored too, with the actor the function sets, so a route
     * test can see attribution; the trigger itself is covered by the contract
     * suite against Postgres.
     */
    admin_set_user_active({ p_actor, p_user, p_active }) {
      const actor = tables.users.find(u => u.id === p_actor);
      if (!actor || actor.role !== 'admin') return { data: null, error: { code: '42501', message: 'admin required' } };
      const user = tables.users.find(u => u.id === p_user);
      if (!user) return { data: null, error: { code: 'P0002', message: 'user not found' } };
      if (user.is_active !== p_active) {
        (tables.audit_logs ||= []).push({
          actor_id: p_actor, subject_id: p_user,
          action: p_active ? 'account.reactivated' : 'account.deactivated', meta: {}
        });
      }
      user.is_active = p_active;
      return { data: null, error: null };
    },
    admin_update_report({ p_actor, p_report, p_status, p_note = null }) {
      if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(p_status)) {
        return { data: null, error: { code: '23514', message: 'invalid status' } };
      }
      const actor = tables.users.find(u => u.id === p_actor);
      if (!actor || actor.role !== 'admin') return { data: null, error: { code: '42501', message: 'admin required' } };
      const report = (tables.reports || []).find(r => r.id === p_report);
      if (!report) return { data: null, error: { code: 'P0002', message: 'report not found' } };
      const before = { status: report.status, admin_note: report.admin_note };
      report.status = p_status;
      report.resolved_at = ['resolved', 'dismissed'].includes(p_status) ? new Date().toISOString() : null;
      if (p_note !== null) report.admin_note = p_note;
      if (before.status !== report.status || before.admin_note !== report.admin_note) {
        (tables.audit_logs ||= []).push({
          actor_id: p_actor, subject_id: report.reporter_id, action: 'report.updated',
          meta: { report_id: report.id, from: before.status, to: report.status,
                  note_changed: before.admin_note !== report.admin_note }
        });
      }
      return { data: [{ ...report }], error: null };
    },

    /**
     * Mirrors migration 016's apply_vote_points.
     *
     * Deltas against the stored row, floored at zero, badges recomputed -- the
     * same contract as the SQL. The badge thresholds are duplicated in the
     * migration by necessity; a test asserts the two agree.
     */
    apply_vote_points({ p_user_id, p_points_delta, p_upvotes_delta }) {
      const row = tables.users.find(u => u.id === p_user_id);
      if (!row) return { data: null, error: { code: 'P0002', message: 'user not found' } };

      const points = Math.max(0, (row.points || 0) + (p_points_delta || 0));
      const upvotes = Math.max(0, (row.total_upvotes_received || 0) + (p_upvotes_delta || 0));
      const answers = row.total_answers || 0;

      const badges = [];
      if (points >= 50) badges.push('bronze');
      if (points >= 200) badges.push('silver');
      if (points >= 500) badges.push('gold');
      if (answers >= 10) badges.push('contributor');
      if (answers >= 50) badges.push('expert');

      row.points = points;
      row.total_upvotes_received = upvotes;
      row.badges = badges;

      return { data: [{ points, total_upvotes_received: upvotes, badges }], error: null };
    },

    /**
     * Mirrors migration 024's apply_subscription_event: once per event id,
     * status only from a newer event, a period extended only by a new payment,
     * the period end only forward. The real function does it in one
     * transaction under a lock on the user; sqlFunctions.contract.test.mjs runs
     * that against Postgres.
     */
    apply_subscription_event(a) {
      const ok = ['created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'paused'];
      if (a.p_status != null && !ok.includes(a.p_status)) {
        return { data: null, error: { code: '23514', message: `unknown subscription status ${a.p_status}` } };
      }
      const events = (tables.billing_events ||= []);
      if (events.some(e => e.event_id === a.p_event_id)) {
        return { data: [{ outcome: 'duplicate', affected_user: null, new_plan: null, new_expires_at: null }], error: null };
      }
      const ev = { event_id: a.p_event_id, event_type: a.p_event_type, razorpay_subscription_id: a.p_subscription_id, outcome: 'received' };
      events.push(ev);

      const user = a.p_subscription_id
        ? tables.users.find(u => u.razorpay_subscription_id === a.p_subscription_id)
        : null;
      if (!user) {
        ev.outcome = 'unknown_subscription';
        return { data: [{ outcome: 'unknown_subscription', affected_user: null, new_plan: null, new_expires_at: null }], error: null };
      }

      const ms = (v) => (v ? new Date(v).getTime() : null);
      let newPayment = false;
      if (a.p_payment_id) {
        const txns = (tables.transactions ||= []);
        if (!txns.some(t => t.user_id === user.id && t.razorpay_payment_id === a.p_payment_id)) {
          txns.push({
            id: `txn_${txns.length + 1}`, user_id: user.id, plan: a.p_plan, amount: a.p_amount ?? 0,
            razorpay_order_id: a.p_subscription_id, razorpay_payment_id: a.p_payment_id,
            razorpay_signature: 'subscription', status: 'success', invoice_number: `INV-${a.p_payment_id}`,
            created_at: new Date().toISOString()
          });
          newPayment = true;
        }
      }

      let end = ms(user.subscription_current_end);
      if (a.p_current_end && (end == null || ms(a.p_current_end) > end)) end = ms(a.p_current_end);

      let expires = ms(user.subscription_expires_at);
      let plan = user.subscription_plan;
      const now = Date.now();
      if (newPayment && end != null) {
        plan = a.p_plan;
        expires = Math.max(expires ?? now, end + (a.p_grace_days ?? 3) * 86400000);
      }

      let outcome;
      const lastAt = ms(user.subscription_event_at);
      if (a.p_status != null && (lastAt == null || ms(a.p_event_at) >= lastAt)) {
        user.subscription_status = a.p_status;
        user.subscription_event_at = a.p_event_at;
        if (a.p_status === 'halted') expires = Math.min(expires ?? now, now);
        else if ((a.p_status === 'cancelled' || a.p_status === 'completed') && end != null) {
          expires = Math.min(expires ?? end, end);
        }
        outcome = newPayment ? 'charged' : 'status';
      } else {
        outcome = newPayment ? 'charged_stale_status' : 'stale';
      }

      user.subscription_current_end = end != null ? new Date(end).toISOString() : null;
      user.subscription_plan = plan;
      user.subscription_expires_at = expires != null ? new Date(expires).toISOString() : null;
      ev.outcome = outcome;
      return {
        data: [{ outcome, affected_user: user.id, new_plan: plan, new_expires_at: user.subscription_expires_at }],
        error: null
      };
    },

    /**
     * Mirrors migration 015's claim_daily_quota.
     *
     * The real one takes SELECT ... FOR UPDATE so concurrent callers serialise.
     * Nothing here is concurrent — the fake is synchronous — but the important
     * property is reproduced: the count is read from the stored row at call
     * time, never from a caller's stale copy. That is exactly what the old
     * inline read-then-write got wrong, so a test holding one stale userRow
     * across two calls sees the second refused.
     */
    claim_daily_quota({ p_user_id, p_kind, p_limit }) {
      if (p_kind !== 'question' && p_kind !== 'post') {
        return { data: null, error: { code: '23514', message: `unknown quota kind: ${p_kind}` } };
      }
      const countCol = p_kind === 'question' ? 'questions_today' : 'posts_today';
      const dateCol = p_kind === 'question' ? 'last_question_date' : 'last_post_date';

      const row = tables.users.find(u => u.id === p_user_id);
      if (!row) return { data: null, error: { code: 'P0002', message: 'user not found' } };

      const last = row[dateCol] ? new Date(row[dateCol]) : null;
      const now = new Date();
      const sameDay = last
        && last.getUTCFullYear() === now.getUTCFullYear()
        && last.getUTCMonth() === now.getUTCMonth()
        && last.getUTCDate() === now.getUTCDate();

      let used = sameDay ? (row[countCol] || 0) : 0;

      if (p_limit !== null && p_limit !== undefined && used >= p_limit) {
        return { data: [{ allowed: false, used }], error: null };
      }

      used += 1;
      row[countCol] = used;
      row[dateCol] = now.toISOString();
      return { data: [{ allowed: true, used }], error: null };
    },

    /** Mirrors migration 005's transfer_points, including the balance floor. */
    transfer_points({ p_from_user, p_to_user, p_points }) {
      const from = tables.users.find(u => u.id === p_from_user);
      const to = tables.users.find(u => u.id === p_to_user);
      if (!from || !to) return { data: null, error: { message: 'sender not found' } };
      if (p_from_user === p_to_user) return { data: null, error: { message: 'cannot transfer to self' } };
      if ((from.points || 0) - p_points < 10) {
        return { data: null, error: { message: 'insufficient points' } };
      }
      from.points -= p_points;
      to.points = (to.points || 0) + p_points;
      const id = `tr_${Math.random().toString(36).slice(2, 8)}`;
      tables.point_transfers.push({ id, from_user_id: from.id, to_user_id: to.id, points: p_points });
      return {
        data: [{ sender_points: from.points, recipient_points: to.points, transfer_id: id }],
        error: null
      };
    },
    /**
     * Mirrors migration 021's cast_answer_vote: the vote row, points_applied,
     * the one-shot 5-upvote bonus and the author's points in one step. The
     * real function runs it in one transaction under a lock on the answer;
     * sqlFunctions.contract.test.mjs exercises that against Postgres.
     */
    cast_answer_vote({ p_answer_id, p_voter_id, p_type }) {
      if (p_type !== 'up' && p_type !== 'down') {
        return { data: null, error: { code: '23514', message: 'vote type must be up or down' } };
      }
      const answers = tables.answers || [];
      const votes = (tables.answer_votes ||= []);
      const answer = answers.find(a => a.id === p_answer_id);
      if (!answer) return { data: null, error: { code: 'P0002', message: 'answer not found' } };
      if (answer.author_id === p_voter_id) {
        return { data: null, error: { code: '23514', message: 'cannot vote on own answer' } };
      }
      const author = tables.users.find(u => u.id === answer.author_id);
      const authorPoints = author?.points || 0;
      const idx = votes.findIndex(v => v.answer_id === p_answer_id && v.user_id === p_voter_id);
      const existing = idx >= 0 ? votes[idx] : null;

      let pointsDelta = 0;
      let upvotesDelta = 0;
      const upsert = (row) => {
        if (idx >= 0) votes[idx] = { ...votes[idx], ...row };
        else votes.push({ answer_id: p_answer_id, user_id: p_voter_id, ...row });
      };

      if (p_type === 'up') {
        if (existing?.vote_type === 'up') {
          votes.splice(idx, 1);
          upvotesDelta = -1;
        } else {
          if (existing?.vote_type === 'down' && existing.points_applied !== false) pointsDelta += 1;
          upvotesDelta = 1;
          upsert({ vote_type: 'up', points_applied: false });
        }
      } else if (existing?.vote_type === 'down') {
        votes.splice(idx, 1);
        if (existing.points_applied !== false) pointsDelta = 1;
      } else {
        if (existing?.vote_type === 'up') upvotesDelta = -1;
        const applied = authorPoints > 0;
        if (applied) pointsDelta = -1;
        upsert({ vote_type: 'down', points_applied: applied });
      }

      if (p_type === 'up' && existing?.vote_type !== 'up' && !answer.bonus_points_awarded) {
        const ups = votes.filter(v => v.answer_id === p_answer_id && v.vote_type === 'up').length;
        if (ups >= 5) {
          answer.bonus_points_awarded = true;
          pointsDelta += 5;
        }
      }

      const applied = rpcHandlers.apply_vote_points({
        p_user_id: answer.author_id, p_points_delta: pointsDelta, p_upvotes_delta: upvotesDelta
      });
      if (applied.error) return applied;

      const mine = votes.filter(v => v.answer_id === p_answer_id);
      return {
        data: [{
          up_count: mine.filter(v => v.vote_type === 'up').length,
          down_count: mine.filter(v => v.vote_type === 'down').length
        }],
        error: null
      };
    },

    /** Mirrors migration 021's create_answer: insert plus the +5, together. */
    create_answer({ p_question_id, p_author_id, p_body }) {
      if (!p_body || !String(p_body).trim()) {
        return { data: null, error: { code: '23514', message: 'answer body is required' } };
      }
      if (!(tables.questions || []).some(q => q.id === p_question_id)) {
        return { data: null, error: { code: 'P0002', message: 'question not found' } };
      }
      const user = tables.users.find(u => u.id === p_author_id);
      if (!user) return { data: null, error: { code: 'P0002', message: 'user not found' } };

      const id = `ans_${Math.random().toString(36).slice(2, 10)}`;
      (tables.answers ||= []).push({
        id, question_id: p_question_id, author_id: p_author_id, body: p_body,
        points_awarded: true, bonus_points_awarded: false, is_accepted: false,
        created_at: new Date().toISOString()
      });
      user.points = (user.points || 0) + 5;
      user.total_answers = (user.total_answers || 0) + 1;
      user.badges = fakeBadges(user.points, user.total_answers);
      return { data: [{ new_answer_id: id, author_points: user.points }], error: null };
    },

    /** Mirrors migration 021's delete_answer. */
    delete_answer({ p_answer_id, p_author_id }) {
      const answers = tables.answers || [];
      const i = answers.findIndex(a => a.id === p_answer_id);
      if (i < 0) return { data: null, error: { code: 'P0002', message: 'answer not found' } };
      const answer = answers[i];
      if (answer.author_id !== p_author_id) {
        return { data: null, error: { code: '42501', message: 'not authorized' } };
      }
      const user = tables.users.find(u => u.id === answer.author_id);
      let points = user?.points || 0;
      if (answer.points_awarded === true) points = Math.max(0, points - 5);
      if (answer.bonus_points_awarded === true) points = Math.max(0, points - 5);
      const totalAnswers = Math.max(0, (user?.total_answers || 0) - 1);
      if (user) {
        user.points = points;
        user.total_answers = totalAnswers;
        user.badges = fakeBadges(points, totalAnswers);
      }
      for (const q of tables.questions || []) {
        if (q.accepted_answer_id === p_answer_id) {
          q.accepted_answer_id = null;
          q.is_resolved = false;
        }
      }
      answers.splice(i, 1);
      tables.answer_votes = (tables.answer_votes || []).filter(v => v.answer_id !== p_answer_id);
      return { data: [{ author_points: points }], error: null };
    },

    rate_limit_hit() {
      return { data: [{ hits: 1, expires_at: new Date(Date.now() + 60000).toISOString() }], error: null };
    },
    rate_limit_reset() { return { data: null, error: null }; }
  };

  /**
   * In-memory object storage.
   *
   * Keyed `bucket/key` → { buffer, contentType }. Enough to exercise the
   * signed-URL mint, the stat, the ranged magic-byte read and the delete
   * without ever reaching Supabase — CI must never touch a real bucket.
   */
  const objects = new Map(seed.storage instanceof Map ? seed.storage : []);
  const objectId = (bucket, key) => `${bucket}/${key}`;
  const storageCalls = [];

  function storageFrom(bucket) {
    return {
      createSignedUploadUrl(key) {
        storageCalls.push({ op: 'createSignedUploadUrl', bucket, key });
        return Promise.resolve({
          data: { signedUrl: `https://fake.storage/${bucket}/${key}?token=t`, token: 't', path: key },
          error: null
        });
      },
      info(key) {
        storageCalls.push({ op: 'info', bucket, key });
        const obj = objects.get(objectId(bucket, key));
        if (!obj) return Promise.resolve({ data: null, error: { message: 'Object not found' } });
        return Promise.resolve({
          data: { size: obj.buffer.length, contentType: obj.contentType },
          error: null
        });
      },
      createSignedUrl(key, expiresIn) {
        const obj = objects.get(objectId(bucket, key));
        if (!obj) return Promise.resolve({ data: null, error: { message: 'Object not found' } });
        /*
         * Shaped like the real thing: /storage/v1/object/sign/<bucket>/<key>
         * with a token. routes/media.js redirects to whatever comes back, and a
         * test asserting it is a *signed* URL rather than a public one can only
         * mean something if the fake distinguishes the two.
         */
        return Promise.resolve({
          data: {
            signedUrl: `https://fake.storage/storage/v1/object/sign/${bucket}/${key}` +
              `?token=fake-signature&expiresIn=${expiresIn || 60}`
          },
          error: null
        });
      },
      download(key) {
        const obj = objects.get(objectId(bucket, key));
        if (!obj) return Promise.resolve({ data: null, error: { message: 'Object not found' } });
        return Promise.resolve({
          data: { arrayBuffer: async () => obj.buffer },
          error: null
        });
      },
      upload(key, buffer, opts = {}) {
        storageCalls.push({ op: 'upload', bucket, key });
        objects.set(objectId(bucket, key), {
          buffer: Buffer.from(buffer),
          contentType: opts.contentType || 'application/octet-stream'
        });
        return Promise.resolve({ data: { path: key }, error: null });
      },
      remove(keys) {
        for (const key of keys) {
          storageCalls.push({ op: 'remove', bucket, key });
          objects.delete(objectId(bucket, key));
        }
        return Promise.resolve({ data: keys.map(k => ({ name: k })), error: null });
      },
      list(prefix) {
        storageCalls.push({ op: 'list', bucket, prefix });
        const out = [];
        for (const id of objects.keys()) {
          if (!id.startsWith(`${bucket}/${prefix}/`)) continue;
          const obj = objects.get(id);
          // Honour a seeded created_at so the sweep's grace window is testable;
          // epoch means "old" for anything that did not set one.
          out.push({
            name: id.slice(`${bucket}/${prefix}/`.length),
            created_at: obj?.created_at || new Date(0).toISOString()
          });
        }
        return Promise.resolve({ data: out, error: null });
      }
    };
  }

  return {
    _tables: tables,
    _objects: objects,
    _storageCalls: storageCalls,
    /** Put an object in the fake bucket without going through the upload path. */
    _seedObject(bucket, key, buffer, contentType) {
      objects.set(objectId(bucket, key), { buffer: Buffer.from(buffer), contentType });
    },
    from(table) {
      tables[table] ||= [];
      return {
        // Options have to be forwarded: `select('*', { count: 'exact' })` is
        // how routes ask for a count, and dropping them here made every count
        // come back undefined.
        select: (fields, opts) => new Query(table, tables[table], 'select').select(fields, opts),
        insert: (payload) => new Query(table, tables[table], 'insert', payload),
        update: (payload) => new Query(table, tables[table], 'update', payload),
        delete: () => new Query(table, tables[table], 'delete'),
        upsert: (payload) => new Query(table, tables[table], 'insert', payload)
      };
    },
    storage: { from: storageFrom },
    // Exposed so a test can delete a handler to simulate an unapplied migration,
    // or replace one to simulate a database error.
    _rpc: rpcHandlers,
    rpc(name, args) {
      const handler = rpcHandlers[name];
      if (!handler) {
        // PGRST202 is what PostgREST actually returns for a function that does
        // not exist, and routes branch on that code to fall back when a
        // migration has not been applied yet. Without the code here the fake
        // reported a generic error and those fallbacks could not be exercised —
        // callers that correctly refuse to swallow unknown errors would throw.
        return Promise.resolve({
          data: null,
          error: { code: 'PGRST202', message: `Could not find the function public.${name}` }
        });
      }
      assertRpcSignature(name, args);
      return Promise.resolve(handler(args));
    }
  };
}

module.exports = { createFakeSupabase };
