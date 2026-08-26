# 0004 — A fake may not be the only thing that runs the logic

Date: 2026-08-27
Status: accepted

## Decision

When a test fake reimplements logic that also exists in a real system — an SQL
function, a remote API, a stored procedure — that real implementation must have
a test that **executes it**. If the fake is the only thing that ever runs the
logic, the fake is a permanent blind spot, and its correctness is measuring the
wrong thing.

Concretely, for this repo:

- `test/helpers/fakeSupabase.js` reimplements five Postgres functions in
  JavaScript: `apply_vote_points`, `claim_daily_quota`, `transfer_points`,
  `rate_limit_hit`, `rate_limit_reset`. Each is a stand-in for SQL that ships in
  `db/migrations/`.
- The three race-guard functions (`apply_vote_points`, `claim_daily_quota`,
  `transfer_points`) now have a real-database contract test,
  `test/sqlFunctions.contract.test.mjs`, which loads the **actual migration
  function bodies** into a Postgres and calls them. It is gated on
  `CONTRACT_DB_URL` and skips cleanly offline; CI provides the database.
- The fake now also **asserts the caller used the real parameter names**
  (`RPC_SIGNATURES` in `fakeSupabase.js`). A drift like `p_sender` for
  `p_from_user` throws instead of quietly reading `undefined`.

## Why

`apply_vote_points` (migration 016) was written with a latent SQL bug: its
`RETURNS TABLE (points INT, …)` output column collided with `users.points`, so
every call raised `42702 column reference "points" is ambiguous`. The function
was **never callable**. Yet every vote test passed for months.

The reason is this decision, inverted. The fake reimplemented the function in
JavaScript, correctly. So the suite exercised the fake — which worked — and
never the SQL — which did not. The fake was *more correct than the thing it
stood for*, and that gap was invisible precisely because the tests were green.

It compounded with a second gap: the function was missing entirely from
production (migration 016 was never applied there), so production silently ran a
racy fallback, while staging — which had the function — 500'd on every vote. A
JavaScript fake can reproduce neither "absent in one environment" nor "present
but broken in another." Only running the real thing can.

The parameter-name half is the same shape a size smaller: a fake that
destructures `{ p_from_user }` reads `undefined` when a caller passes
`p_sender`, computes a wrong-but-plausible answer, and passes. PostgREST would
have refused the call outright. The fake was, again, more forgiving than
reality.

## The rule, stated for the next case

A fake is allowed to *return canned data*. It is not allowed to be the *only*
executor of logic that has a real implementation. When those two coincide —
the fake computes something the real system also computes — one of these must
be true, or the fake is a blind spot:

1. a contract test runs the real implementation and asserts the same behaviour, or
2. the fake is demonstrably a thin pass-through with no logic of its own.

And a fake standing in for a system with a strict interface (named SQL
parameters, a typed API) should enforce that interface, so that drift fails a
test rather than degrading into a plausible wrong answer.

## Consequences

`pg` is a dev dependency, used only by the contract test. CI must provide a
throwaway Postgres (a service container) and set `CONTRACT_DB_URL`; without it
the contract suite skips, which keeps the offline unit run fast but means CI is
now the place the SQL is actually verified. That is the intended trade: the SQL
is verified *somewhere that runs it*, not nowhere.

See [`../retrospective-2026-08.md`](../retrospective-2026-08.md) — this is the
"green result that verified nothing" family, in its most expensive instance.
