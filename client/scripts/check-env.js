#!/usr/bin/env node
/**
 * Refuse to build if a secret is about to be shipped to browsers.
 *
 * Vite inlines every `VITE_`-prefixed variable into the bundle as a literal.
 * That is the intended behaviour and it is why the prefix exists — but it also
 * means one rename turns a server secret into public data, silently, with a
 * green build.
 *
 * This is not hypothetical here. `client/.env` held SUPABASE_SERVICE_ROLE_KEY —
 * the key that bypasses RLS entirely — for some time. It never shipped, because
 * it lacked the prefix and Vite excluded it. `.env.example` had even said "use
 * the ANON key here, never the service_role key". The documentation was correct
 * and was not enough, which is the argument for a check that fails the build
 * rather than a comment that asks nicely.
 *
 * Run from `npm run build` and `npm run check`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The client is ESM ("type": "module" in package.json), so no __dirname.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

/** Decode a JWT payload without verifying — we only care what it claims to be. */
function jwtRole(value) {
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json).role || null;
  } catch {
    return null;
  }
}

/*
 * Anything that must never be inlined. `service_role` is the specific one that
 * prompted this; the others are here because they are the same category of
 * mistake and cost nothing to check.
 */
const FORBIDDEN_ROLES = ['service_role'];
const FORBIDDEN_NAME_PATTERNS = [
  /SERVICE_ROLE/i,
  /^VITE_.*SECRET/i,
  /^VITE_.*PRIVATE_KEY/i,
  /^VITE_JWT/i,
  /^VITE_.*PASSWORD/i
];

const problems = [];

for (const file of ENV_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;

  const lines = fs.readFileSync(full, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const eq = trimmed.indexOf('=');
    if (eq === -1) return;

    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');

    // Only VITE_ names reach the bundle. A non-prefixed secret is untidy but
    // not shipped, so it is not a build failure.
    if (!name.startsWith('VITE_')) return;
    if (!value) return;

    const role = jwtRole(value);
    if (role && FORBIDDEN_ROLES.includes(role)) {
      problems.push(`${file}:${i + 1} ${name} is a JWT with role "${role}" — this would be inlined into the bundle`);
      return;
    }

    for (const pattern of FORBIDDEN_NAME_PATTERNS) {
      if (pattern.test(name)) {
        problems.push(`${file}:${i + 1} ${name} looks like a secret and is VITE_-prefixed, so it would be inlined`);
        return;
      }
    }
  });
}

if (problems.length) {
  console.error('\nRefusing to build — a secret would be shipped to browsers:\n');
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\nAnything VITE_-prefixed becomes a string literal in the bundle and is public.\n' +
    'Server-only secrets belong in server/.env. For Supabase realtime the client\n' +
    'needs VITE_SUPABASE_ANON_KEY, never the service_role key.\n'
  );
  process.exit(1);
}

console.log('env check: no secrets would be inlined');
