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
      createSignedUrl(key) {
        const obj = objects.get(objectId(bucket, key));
        if (!obj) return Promise.resolve({ data: null, error: { message: 'Object not found' } });
        return Promise.resolve({
          data: { signedUrl: `https://fake.storage/read/${bucket}/${key}` },
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
          out.push({ name: id.slice(`${bucket}/${prefix}/`.length), created_at: new Date(0).toISOString() });
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
        select: () => new Query(table, tables[table], 'select'),
        insert: (payload) => new Query(table, tables[table], 'insert', payload),
        update: (payload) => new Query(table, tables[table], 'update', payload),
        delete: () => new Query(table, tables[table], 'delete'),
        upsert: (payload) => new Query(table, tables[table], 'insert', payload)
      };
    },
    storage: { from: storageFrom },
    rpc(name, args) {
      const handler = rpcHandlers[name];
      if (!handler) return Promise.resolve({ data: null, error: { message: `no rpc ${name}` } });
      return Promise.resolve(handler(args));
    }
  };
}

module.exports = { createFakeSupabase };
