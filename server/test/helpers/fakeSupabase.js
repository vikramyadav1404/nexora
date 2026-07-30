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

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === 'eq') return row[col] === val;
    if (op === 'neq') return row[col] !== val;
    if (op === 'in') return val.includes(row[col]);
    return true;
  });
}

class Query {
  constructor(table, rows, op = 'select', payload = null) {
    this.table = table;
    this.rows = rows;
    this.op = op;
    this.payload = payload;
    this.filters = [];
    this._limit = null;
  }

  select() { return this; }
  order() { return this; }
  eq(col, val) { this.filters.push(['eq', col, val]); return this; }
  neq(col, val) { this.filters.push(['neq', col, val]); return this; }
  in(col, val) { this.filters.push(['in', col, val]); return this; }
  or() { return this; }
  ilike() { return this; }
  limit(n) { this._limit = n; return this; }

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
      return Promise.resolve({ data: this._run(), error: null }).then(resolve, reject);
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

  const rpcHandlers = {
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

  return {
    _tables: tables,
    from(table) {
      tables[table] ||= [];
      return {
        select: () => new Query(table, tables[table], 'select'),
        insert: (payload) => new Query(table, tables[table], 'insert', payload),
        update: (payload) => new Query(table, tables[table], 'update', payload),
        delete: () => new Query(table, tables[table], 'delete'),
        upsert: (payload) => new Query(table, tables[table], 'insert', payload)
      };
    },
    rpc(name, args) {
      const handler = rpcHandlers[name];
      if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc ${name}` } });
      return Promise.resolve(handler(args));
    }
  };
}

module.exports = { createFakeSupabase };
