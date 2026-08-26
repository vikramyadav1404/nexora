/**
 * A minimal in-memory stand-in for the Supabase JS client.
 *
 * Demo mode can't be used for these tests: `DEMO_MODE=true` mounts
 * routes/demo.js, which shadows the entire real API surface — so a test run
 * against it would exercise none of the code we actually hardened.
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
    apply_vote_points: { required: ['p_user_id', 'p_points_delta', 'p_upvotes_delta'] },
    claim_daily_quota: { required: ['p_user_id', 'p_kind', 'p_limit'] },
    transfer_points: { required: ['p_from_user', 'p_to_user', 'p_points'], optional: ['p_message'] },
    rate_limit_hit: { required: ['p_key', 'p_window_ms'] },
    rate_limit_reset: { required: ['p_key'] }
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
