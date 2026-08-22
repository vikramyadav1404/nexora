# 0002 — A linter is only worth what it is configured to catch

Date: 2026-08-22
Status: accepted

## Decision

`client/.oxlintrc.json` declares `env: { browser: true, es2024: true }` and
enables `no-undef` as an error.

The client also has a route-mount smoke suite
(`client/src/test/routes.smoke.test.jsx`) that renders every route against
fixtures and asserts the page mounts.

## Why

`/leaderboard` threw `ReferenceError: loading is not defined` on every render,
for every visitor, in production. `Leaderboard.jsx:83` read a bare `loading`
left behind when the page moved to `useResource`, which exposes `isLoading`.

It was found by a person opening the page in a browser.

`npm run lint` had been reporting clean throughout. It was telling the truth:
`.oxlintrc.json` enabled two React rules and nothing else, so `no-undef` never
ran. "Lint clean" was technically accurate and meant almost nothing — a
guaranteed `ReferenceError` sat in a shipped bundle and passed every check the
project had.

## The calibration, which is the transferable part

Enabling `no-undef` alone was useless. With no environment declared it flagged
`window`, `document`, `navigator`, `setTimeout`, `clearTimeout`, `console`,
`URL`, `Blob`, `FormData`, `confirm`, `prompt` — dozens of hits across six
files, every one of them a browser global that is obviously fine.

That version of the rule would have been switched off within a day, and
reasonably so.

With `env: { browser: true }` declared, the same rule flagged **exactly one
thing in the entire client**, and that one thing was the bug.

The lesson is not "turn on more rules". A rule that is noisy gets disabled; a
rule that is silent gets trusted. Both fail the same way — nobody looks at the
output. The useful question about a linter is not *is it enabled* but **what did
it last catch**. If the answer is "nothing, ever", that is a finding about the
configuration rather than a clean bill of health.

## Why a linter was not enough on its own

`no-undef` closes exactly one class: a name that does not exist. It would not
have caught the same page rendering an empty panel, or a crash from data shaped
differently than expected — both of which also happened this month.

So the smoke suite exists alongside it, and the two were validated the same way:
re-introduce the exact production bug and confirm each goes red. Both do.

Building it surfaced a third thing worth recording. The first version of the
smoke test asserted its route marker against the whole document, and
`/leaderboard` passed **with the page component returning `null`** — because the
navbar contains the word "Leaderboard". Caught by deliberately neutering three
pages to `return null` and checking that all three failed; only two did.

The assertion is now scoped to `.page-container`, which every routed page wraps
itself in and the navbar sits outside of. A test that cannot fail is worth
nothing, and the only reliable way to find out is to break the thing on purpose
and watch.

## Consequences

`no-undef` runs on every `npm run lint` and blocks on error. New browser globals
that are not in the `browser` env will need adding to `globals` rather than
being worked around.

The smoke suite adds roughly nine seconds to `npm test` and needs a fixture for
any new endpoint a page calls — `resolveFixture` throws on an unknown URL rather
than returning `{}`, so that is a loud failure by design.

See [0001](0001-user-serialisation-is-an-allowlist.md) for the other half of the
same week.
