const fs = require('fs');
const path = require('path');

/**
 * What is running, and how confident we are about it.
 *
 * This used to be a static `{ name, version: '1.0.0', api: '1.0.0' }`, which
 * meant /api/version answered identically for every deploy ever made. Working
 * out which commit was in production therefore took a behavioural probe --
 * send a request only the new code answers differently -- and that guessing
 * went wrong twice.
 *
 * Two identifiers, because they fail in different directions:
 *
 *   commit       stamped at deploy time by scripts/stamp-version.js. Directly
 *                readable, but only present if the stamping ran.
 *   deploymentId injected by Vercel at runtime. Opaque, but cannot be stale or
 *                wrong, and maps to a build via `vercel inspect`.
 *
 * When the stamp is missing, this reports `commit: null, stamped: false` rather
 * than a placeholder. An unknown commit and a known one must not look alike --
 * the same distinction the empty-vs-failed work in the client turned on. A
 * fabricated default here would be worse than nothing, because it would look
 * like an answer.
 */

function readStamp() {
  // Written next to this file by scripts/stamp-version.js. Gitignored.
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'version.generated.json'), 'utf8');
    const stamp = JSON.parse(raw);
    if (stamp && typeof stamp.commit === 'string' && stamp.commit.length >= 7) {
      return { ...stamp, stamped: true };
    }
  } catch {
    // Absent or unreadable: fall through. Not an error -- a local `npm run dev`
    // has no stamp and does not need one.
  }
  return null;
}

/**
 * Local development convenience only.
 *
 * Serverless has no git binary and a read-only filesystem, so this is wrapped
 * and never attempted where it cannot work. It is not a substitute for the
 * stamp: it reports the working tree of whoever is running the process, which
 * is meaningful on a laptop and meaningless anywhere else.
 */
function readLocalGit() {
  if (process.env.VERCEL) return null;
  try {
    const { execSync } = require('child_process');
    const run = (args) => execSync(`git ${args}`, {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();

    const commit = run('rev-parse HEAD');
    return {
      commit,
      commitShort: commit.slice(0, 7),
      branch: run('rev-parse --abbrev-ref HEAD'),
      dirty: run('status --porcelain') !== '',
      stamped: false,
      source: 'local-git'
    };
  } catch {
    return null;
  }
}

const build = readStamp() || readLocalGit() || { stamped: false };

module.exports = {
  name: 'Nexora',
  version: '1.0.0',
  api: '1.0.0',

  // Null, not a placeholder, when genuinely unknown.
  commit: build.commit ?? null,
  commitShort: build.commitShort ?? null,
  branch: build.branch ?? null,
  committedAt: build.committedAt ?? null,
  builtAt: build.builtAt ?? null,

  /** True only when a deploy-time stamp was found — i.e. the commit is trustworthy. */
  stamped: build.stamped === true,

  /** True when the stamped tree had uncommitted changes; null when unknown. */
  dirty: typeof build.dirty === 'boolean' ? build.dirty : null,

  /** Platform-injected, always correct on Vercel, absent locally. */
  deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,

  source: build.source || (build.stamped ? 'stamp' : 'none')
};
