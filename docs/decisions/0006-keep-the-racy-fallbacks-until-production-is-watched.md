# 0006 — Keep the racy fallbacks for now, on purpose

Date: 2026-08-27
Status: closed 2026-11-19 — fallbacks removed (see "Closed" at the end)

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

## Closed — 2026-11-19

The review date (~2026-09-10) passed without this file being revisited, which
is the loose end it was written to prevent. Closed now, on this evidence:

- **The running production deployment passes the boot check.**
  `GET /api/ready` on the production API returned `{"ready":true}` on
  2026-11-19. In production a missing or broken race-guard function makes
  every `/api` route answer 503, `/api/ready` included, so a ready answer
  means all three functions were present and ran when that instance booted.
- **About twelve weeks** have passed since the boot check shipped, against the
  two weeks this decision asked for.
- **Not checked:** Vercel's logs were not reviewed for a boot refusal in
  between, and the maintainer has no record of one. That is weaker than "watched
  and clean", and it is written down here rather than rounded up.

What changed:

- `legacyApply` (`votePoints.js`), `legacyClaim` (`quota.js`) and
  `legacyTransfer` (`rewards.js`) are deleted.
- PGRST202 now throws `missingFunctionError` (`utils/raceFunctions.js`). The
  client gets a 503 naming the migration to run, the error goes to error
  reporting as a 5xx, and **nothing is written**: the quota claim and the
  transfer fail before any update, and the vote-points call moves no points.
  Tests in `securityHardening.test.mjs` and `security.test.mjs` assert all
  three, and each goes red with the old fallback restored.

The trade this accepts is the one described above: if a function were dropped
on an already-booted instance, those three actions would fail until the
migration is re-applied, instead of quietly running the racy path. A loud,
recoverable outage of three actions is preferred to silent lost updates.

One residual, unchanged by this and recorded so it is not mistaken for new:
the answer-vote route writes the vote row *before* calling
`applyVotePoints`. Any error at that call — a timeout before today, and now
also a missing function — leaves the vote recorded without its points. The
fix for that is one SQL function that writes the vote and the points in the
same transaction, not a racy fallback.

*Update:* fixed by migration 021 (`cast_answer_vote`), which also moved
answer creation and deletion onto the same pattern.

Migrations 005, 015 and 016 still describe the fallback in their comments.
They are left as written: applied migrations are a record, not documentation
to keep current.
