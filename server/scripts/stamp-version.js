#!/usr/bin/env node
/**
 * Write the current commit into version.generated.json, for /api/version.
 *
 * Vercel CLI deploys carry no git metadata -- `vercel inspect` on a production
 * deployment shows an id and nothing else -- so VERCEL_GIT_COMMIT_SHA is empty
 * at runtime. server/vercel.json also uses the legacy `builds` schema with no
 * buildCommand, so no build step runs there either. The SHA therefore has to be
 * captured here, before the upload, or not at all.
 *
 * Run by `npm run deploy`. Running `vercel deploy` directly skips it, which is
 * why version.js reports `stamped: false` rather than guessing: a deploy whose
 * commit is unknown must say so, not present a stale one as current.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'version.generated.json');

function git(args) {
  return execSync(`git ${args}`, {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim();
}

try {
  const commit = git('rev-parse HEAD');

  /*
   * Whether the tree had uncommitted changes.
   *
   * A deploy stamped from a dirty tree is identifiable by SHA but not
   * reproducible from it -- the running code is not what that commit contains.
   * That is precisely the case where a plausible answer misleads, so it is
   * recorded rather than smoothed over.
   */
  const dirty = git('status --porcelain') !== '';

  const stamp = {
    commit,
    commitShort: commit.slice(0, 7),
    committedAt: git('log -1 --format=%cI'),
    branch: git('rev-parse --abbrev-ref HEAD'),
    dirty,
    builtAt: new Date().toISOString()
  };

  fs.writeFileSync(OUT, JSON.stringify(stamp, null, 2) + '\n');
  console.log(
    `stamped ${stamp.commitShort}${dirty ? ' (DIRTY TREE)' : ''} on ${stamp.branch}`
  );
  if (dirty) {
    console.warn(
      'warning: deploying uncommitted changes — /api/version will report dirty:true'
    );
  }
} catch (err) {
  /*
   * No git, or not a repository. Fail the deploy rather than shipping without a
   * stamp: the whole point is that production can be identified in one request,
   * and silently continuing would leave that broken exactly when nobody looks.
   */
  console.error('Could not stamp version:', err.message);
  process.exit(1);
}
