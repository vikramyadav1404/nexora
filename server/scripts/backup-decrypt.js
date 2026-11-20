#!/usr/bin/env node
/**
 * Decrypt a backup written by `npm run backup` with BACKUP_PASSPHRASE set.
 *
 *   BACKUP_PASSPHRASE=... npm run backup:decrypt -- backups/nexora-<stamp>.json.enc
 *
 * Writes the JSON next to the input (without .enc). The passphrase comes from
 * the environment, never the command line, so it does not land in shell
 * history.
 */
require('dotenv').config();
const fs = require('fs');
const { decryptBackup } = require('../utils/backupCrypto');

const input = process.argv[2];
if (!input || !input.endsWith('.enc')) {
  console.error('Usage: BACKUP_PASSPHRASE=... npm run backup:decrypt -- <file>.json.enc');
  process.exit(1);
}
if (!process.env.BACKUP_PASSPHRASE) {
  console.error('Set BACKUP_PASSPHRASE to the passphrase the backup was written with.');
  process.exit(1);
}

try {
  const json = decryptBackup(fs.readFileSync(input), process.env.BACKUP_PASSPHRASE);
  const out = input.replace(/\.enc$/, '');
  fs.writeFileSync(out, json);
  const tables = Object.keys(JSON.parse(json).tables || {}).length;
  console.log(`decrypted -> ${out} (${tables} tables). It is plaintext again: keep it off shared machines.`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
