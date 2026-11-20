/**
 * Encrypted backups (utils/backupCrypto.js, scripts/backup.js).
 *
 * The scheduled backup is a public repository's workflow artifact, so the
 * property that matters is that it is unreadable without the passphrase and
 * that any alteration is detected rather than restored.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { encryptBackup, decryptBackup } = require('../utils/backupCrypto.js');

const PASS = 'correct horse battery staple, but longer';
const SAMPLE = JSON.stringify({ takenAt: '2026-11-20', tables: { users: [{ email: 'secret@nexora.test' }] } });

describe('backup encryption', () => {
  it('round-trips, and the email is not visible in the encrypted file', () => {
    const blob = encryptBackup(SAMPLE, PASS);
    expect(blob.includes(Buffer.from('secret@nexora.test'))).toBe(false);
    expect(decryptBackup(blob, PASS)).toBe(SAMPLE);
  });

  it('uses a fresh salt and nonce every time', () => {
    expect(encryptBackup(SAMPLE, PASS).equals(encryptBackup(SAMPLE, PASS))).toBe(false);
  });

  it('REGRESSION: a wrong passphrase fails instead of returning garbage', () => {
    const blob = encryptBackup(SAMPLE, PASS);
    expect(() => decryptBackup(blob, PASS + '!')).toThrow(/wrong passphrase|altered/);
  });

  it('REGRESSION: a single flipped byte is detected', () => {
    const blob = encryptBackup(SAMPLE, PASS);
    blob[blob.length - 1] ^= 0x01;
    expect(() => decryptBackup(blob, PASS)).toThrow(/wrong passphrase|altered/);
  });

  it('refuses a file that is not an encrypted backup', () => {
    expect(() => decryptBackup(Buffer.from(SAMPLE), PASS)).toThrow(/bad header/);
  });

  it('refuses a short passphrase', () => {
    expect(() => encryptBackup(SAMPLE, 'short')).toThrow(/at least/);
  });
});

describe('scripts/backup.js', () => {
  it('REGRESSION: with encryption required and no passphrase, it writes nothing and fails', () => {
    const dir = path.join(process.cwd(), 'backups');
    const before = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const r = spawnSync(process.execPath, ['scripts/backup.js'], {
      env: { PATH: process.env.PATH, BACKUP_REQUIRE_ENCRYPTION: '1' },
      encoding: 'utf8'
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to write a plaintext backup/);
    const after = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(after).toEqual(before);
  });
});
