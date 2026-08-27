# 0006 — Keep the racy fallbacks for now, on purpose

Date: 2026-08-27
Status: accepted (deferral, to revisit ~2026-09-10)

## Decision

`utils/votePoints.js`, `utils/quota.js`, and the transfer path in
`routes/rewards.js` each keep a non-atomic fallback that runs when their SQL
function is missing (`PGRST202`). Now that a **fatal boot check** exists
(`index.js`, using `utils/raceFunctions.js`), a production deployment whose
database is missing any of the three race-guard functions refuses to serve. So
the fallbacks should, from here on, be **unreachable in production**.

They are kept anyway, deliberately, for at least two weeks of clean production
observation. This is a deferral, not an oversight.

## Why not delete them now

The instinct after fixing this is to remove the racy paths entirely — they are
what let production run unsafe for weeks, and the boot check now guarantees the
functions are present before the app serves a single request. With that
guarantee, the fallbacks are dead code.

But "dead code" and "the safety net under a live system a week after a
migration" are the same lines viewed at different distances. The failure modes
differ by one crucial step:

- **With the fallback:** if a function is dropped at runtime on an
  already-booted instance, the per-request fallback still degrades to the racy
  path rather than 500-ing every vote. Degraded, not down.
- **Without the fallback:** a dropped function goes straight from "degraded" to
  "every vote and every question crashes." The blast radius is larger and the
  recovery is a redeploy, not a self-heal.

The boot check is new. It has never caught a real regression yet, because there
has not been one since it shipped. Removing the fallback trusts the boot check
completely on the strength of a fix that is days old. Trust it, but verify it
against production first — the entire month is a lesson in not trusting a guard
that has not yet been watched doing its job. (The same day this shipped, a
redeploy surfaced a dormant missing-`SUPABASE_URL` and took production down for
minutes; guards earn trust by being watched, not by being written.)

## The condition for removal

After roughly two weeks of production running with the boot check in place and
no race-guard incident — no boot refusal, no `verify:functions` surprise, the
ledger stable — delete the three fallbacks (`legacyApply` in `votePoints.js`,
the fallback in `quota.js`, `legacyTransfer` in `rewards.js`) and make the
non-`PGRST202` error the only path. At that point the boot check has earned the
trust that would let the fallback go, and a permanent racy path is a worse thing
to keep than a redeploy is to risk.

Until then, the fallbacks stay, the boot check is the real guarantee, and this
file is the record that their presence is a choice with a review date — not a
loose end someone forgot.

See [`0004`](0004-a-fake-may-not-be-the-only-thing-that-runs-the-logic.md),
[`../retrospective-2026-08.md`](../retrospective-2026-08.md).
