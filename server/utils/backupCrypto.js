/**
 * Encryption for database backups.
 *
 * A backup holds every user's email address and password hash. The scheduled
 * backup runs in GitHub Actions and is kept as a workflow artifact -- and on a
 * public repository, artifacts can be downloaded by any signed-in GitHub user.
 * So a backup only ever leaves the machine encrypted.
 *
 * Format (all binary, concatenated):
 *   "NXBK1"            5-byte magic, so a wrong file is refused rather than
 *                      mis-decrypted into garbage
 *   salt   16 bytes    scrypt salt, random per file
 *   iv     12 bytes    AES-GCM nonce, random per file
 *   tag    16 bytes    GCM authentication tag
 *   body   rest        AES-256-GCM(gzip(json))
 *
 * GCM authenticates as well as encrypts: a flipped byte or a wrong passphrase
 * fails loudly at decryption instead of producing a plausible corrupt restore.
 * The key is derived with scrypt, so a short passphrase is slow to guess --
 * but use a long random one anyway; the file may be public.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const MAGIC = Buffer.from('NXBK1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSPHRASE = 20;

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function assertPassphrase(passphrase) {
  if (!passphrase || String(passphrase).length < MIN_PASSPHRASE) {
    throw new Error(`BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters.`);
  }
}

/** @param {string} json  @returns {Buffer} */
function encryptBackup(json, passphrase) {
  assertPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(json, 'utf8'))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/** @param {Buffer} blob  @returns {string} the original JSON */
function decryptBackup(blob, passphrase) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + 44 || !blob.subarray(0, 5).equals(MAGIC)) {
    throw new Error('Not a Nexora encrypted backup (bad header).');
  }
  const salt = blob.subarray(5, 21);
  const iv = blob.subarray(21, 33);
  const tag = blob.subarray(33, 49);
  const body = blob.subarray(49);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  let gz;
  try {
    gz = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt: wrong passphrase, or the file was altered.');
  }
  return zlib.gunzipSync(gz).toString('utf8');
}

module.exports = { encryptBackup, decryptBackup, MIN_PASSPHRASE };
