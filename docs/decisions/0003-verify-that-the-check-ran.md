# 0003 — "The check passed" and "the check ran" are different claims

Date: 2026-08-22
Status: accepted

## Decision

A check is not trusted until its failure path has been observed. In practice:

- every guard ships with a demonstrated failure — run it against input that
  must fail, watch it fail, keep that as the self-test
- validity checks reject *shapes*, not the one bad value already seen
- `$?` is never read after a pipe
- non-determinism in a check is disqualifying, not a nuisance to tolerate
- a suite CI does not invoke does not exist

## Why

Six checks in this codebase reported success without verifying anything. All
six were written by someone paying attention, several of them by someone who
had just finished writing about this exact failure mode.

| What reported success | What it actually did |
|---|---|
| CI's client job | never ran the client tests — `npm ci`, `lint`, `build`, no `test` |
| a project-distinctness check | compared a real URL against the literal string `[SENSITIVE]`; any two different strings differ |
| a credential validity check | tested for `[SENSITIVE]` and let `""` through as "real value (0 chars)" |
| an exit-code measurement | read `sed`'s status through a pipe, so a refusal that set `exitCode = 1` reported **0** |
| a live credential probe | same key, same URL, 200 and 401 within one run — the verdict turned on request timing |
| a route smoke test | matched the navigation bar, so a route passed with its page component returning `null` |

The common shape is not "the test was wrong". It is that **the apparatus doing
the measuring failed silently, and silence reads as success.**

## The one that matters most

The `$?` case, because of *where* it fails.

A refusal that reports success is worse than no refusal at all. With no guard,
the damage happens and someone eventually notices. With a guard that exits 0,
the damage happens, CI proceeds, and everyone involved believes a check ran and
approved it. The false confidence is the cost, not the missing protection.

```sh
some-command | sed 's/^/  /'
echo $?          # sed's status. Always 0. Says nothing about some-command.
```

This was found while measuring whether a SQL executor correctly refused to
target production. It did refuse. The measurement said 0.

## The CI one is the purest

`.github/workflows/ci.yml` ran the client's linter and build but not its tests.
All 63 client tests — a route-mount smoke suite, an environment-banner matrix,
media-recovery guards — existed, passed locally, and had never executed in CI.

Every one of them was written during the month this entry summarises,
specifically to catch checks that verify nothing. None of them ran.

There is no clever lesson in it. The suite was added and nobody confirmed the
pipeline picked it up, because a green badge looks the same either way.

## What to do instead

**Demonstrate the failure.** `server/scripts/check-distinct-projects.js` is the
pattern: run it with the same environment file twice and it must report
SAME PROJECT and exit 1. The failure path is exercised on every use, so the
success verdict means something.

**Reject shapes, not values.** A check that refuses `[SENSITIVE]` and accepts
`""` was written by looking at the bad value in front of it. Refuse empty,
placeholder, wrong-type and malformed together — the next bad value will not be
the one you saw.

**Never read `$?` after a pipe.** Use `${PIPESTATUS[0]}`, or do not pipe while
measuring.

**Treat non-determinism as disqualifying.** A probe that answered 200 and 401
for the same key and URL in one run was doing so because the requests were
concurrent. A verdict that can be produced by something other than the thing
being checked is not a verdict.

**Confirm the wiring.** After adding a suite, look at the pipeline output and
find its name. If it is not there, it is not running.

## Consequences

Guards cost more to write: each needs a failure case that is executed, not just
imagined. That is the intended trade — five of the six above would have been
caught by their own self-test.

Some of this is not enforceable by tooling. "Confirm the pipeline picked it up"
is a habit, and habits decay. The mitigation is that this file exists and can be
pointed at.

## Related

- [`retrospective-2026-08.md`](../retrospective-2026-08.md) — the month this
  came out of, and the two shapes underneath it
- [0002](0002-lint-must-be-configured-to-look.md) — the same question asked of a
  linter: not "is it on" but "what did it last catch"
