/**
 * Admin routes and the audit log (migration 023).
 *
 * The triggers that write audit_logs are tested against Postgres in
 * sqlFunctions.contract.test.mjs. What is tested here is the route side: admin
 * writes go through the attributed SQL functions (so the entry names the
 * admin), refusals change nothing, and GET /api/admin/audit is admin-only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

process.env.JWT_SECRET = 'test_jwt_secret';

const require = createRequire(import.meta.url);
const { __setTestClient } = require('../db/supabase.js');
const jwt = require('jsonwebtoken');

const ADMIN = '00000000-0000-4000-8000-0000000000d1';
const USER = '00000000-0000-4000-8000-0000000000d2';
const REPORT = '00000000-0000-4000-8000-0000000000d3';

let db;
const token = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', require('../routes/admin.js'));
  return a;
}

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  db = createFakeSupabase({
    users: [
      { id: ADMIN, name: 'Admin', email: 'a@n.test', role: 'admin', is_active: true },
      { id: USER, name: 'User', email: 'u@n.test', role: 'user', is_active: true }
    ],
    reports: [{ id: REPORT, reporter_id: USER, status: 'open', admin_note: 'keep me' }],
    audit_logs: []
  });
  __setTestClient(db);
});

describe('admin actions are attributed', () => {
  it('a ban goes through admin_set_user_active and names the admin', async () => {
    const res = await request(app()).post(`/api/admin/users/${USER}/ban`)
      .set('Authorization', `Bearer ${token(ADMIN)}`);

    expect(res.status).toBe(200);
    expect(db._tables.users.find(u => u.id === USER).is_active).toBe(false);
    expect(db._tables.audit_logs).toEqual([
      expect.objectContaining({ actor_id: ADMIN, subject_id: USER, action: 'account.deactivated' })
    ]);
  });

  it('a report update keeps the note when none is sent, and names the admin', async () => {
    const res = await request(app()).patch(`/api/admin/reports/${REPORT}`)
      .set('Authorization', `Bearer ${token(ADMIN)}`)
      .send({ status: 'resolved' });

    expect(res.status).toBe(200);
    expect(res.body.report.admin_note).toBe('keep me');
    expect(db._tables.audit_logs[0]).toMatchObject({ actor_id: ADMIN, action: 'report.updated' });
  });

  it('unknown or malformed ids are 404s, and nothing is logged', async () => {
    const other = '00000000-0000-4000-8000-0000000000ff';
    for (const [method, url] of [
      ['post', `/api/admin/users/${other}/ban`],
      ['post', '/api/admin/users/not-a-uuid/unban'],
      ['patch', `/api/admin/reports/${other}`],
      ['patch', '/api/admin/reports/r1']
    ]) {
      const res = await request(app())[method](url)
        .set('Authorization', `Bearer ${token(ADMIN)}`)
        .send({ status: 'resolved' });
      expect(res.status, url).toBe(404);
    }
    expect(db._tables.audit_logs).toHaveLength(0);
  });

  it('a non-admin is refused before anything changes', async () => {
    const res = await request(app()).post(`/api/admin/users/${ADMIN}/ban`)
      .set('Authorization', `Bearer ${token(USER)}`);
    expect(res.status).toBe(403);
    expect(db._tables.users.find(u => u.id === ADMIN).is_active).toBe(true);
    expect(db._tables.audit_logs).toHaveLength(0);
  });

  it('before migration 023, an admin write is a 503 naming it, and changes nothing', async () => {
    delete db._rpc.admin_set_user_active;
    const res = await request(app()).post(`/api/admin/users/${USER}/ban`)
      .set('Authorization', `Bearer ${token(ADMIN)}`);
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/023_audit_logs\.sql/);
    expect(db._tables.users.find(u => u.id === USER).is_active).toBe(true);
  });
});

describe('GET /api/admin/audit', () => {
  it('returns entries, optionally for one subject', async () => {
    // Newest-first is Postgres's ORDER BY; the fake's order() is a no-op, so
    // ordering is not asserted here.
    db._tables.audit_logs.push(
      { id: 'a1', actor_id: null, subject_id: USER, action: 'password.changed', meta: {}, created_at: '2026-11-01T00:00:00Z' },
      { id: 'a2', actor_id: ADMIN, subject_id: ADMIN, action: 'mfa.enabled', meta: {}, created_at: '2026-11-02T00:00:00Z' }
    );

    const all = await request(app()).get('/api/admin/audit').set('Authorization', `Bearer ${token(ADMIN)}`);
    expect(all.status).toBe(200);
    expect(all.body.entries.map(e => e.id).sort()).toEqual(['a1', 'a2']);

    const one = await request(app()).get('/api/admin/audit').query({ subject: USER })
      .set('Authorization', `Bearer ${token(ADMIN)}`);
    expect(one.body.entries.map(e => e.id)).toEqual(['a1']);
  });

  it('is admin-only, and rejects a malformed subject', async () => {
    const res = await request(app()).get('/api/admin/audit').set('Authorization', `Bearer ${token(USER)}`);
    expect(res.status).toBe(403);
    const bad = await request(app()).get('/api/admin/audit').query({ subject: 'x' })
      .set('Authorization', `Bearer ${token(ADMIN)}`);
    expect(bad.status).toBe(400);
  });
});
