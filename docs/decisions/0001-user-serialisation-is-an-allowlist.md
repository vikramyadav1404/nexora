# 0001 — User serialisation is an allowlist, and a privacy change is a data-shape change

Date: 2026-08-22
Status: accepted

## Decision

`server/db/serialize.js` is the only place a user row becomes an API response.
It names every public field by hand. It contains no spread — no `...rest`, no
`...safe`, no `Object.assign` over a row — so a column added by a later
migration is absent from the API until somebody adds it here deliberately.

`shapeUser` remains for owner-only responses. `shapePerson` is deprecated and
delegates here.

## Why

Every user shape in this codebase used to be a denylist. `shapeUser`
destructured four secrets out of the row and named the rest, so it did not leak
a password and did leak everything nobody thought to remove: email, phone, role,
`is_active`, the Razorpay subscription id, the daily quota counters. Any
logged-in account could read all of it for any other account.

The denylist is not the interesting part. This is: `shapePerson` existed
*specifically* to be the safe shape for other people. It was used in four places
whose comments said it withheld contact details. It withheld the phone number
and kept the email. And a test in a `describe` block named *"a stranger never
receives contact details"* pinned its keys to a list containing `email`, with a
note explaining that Settings.jsx rendered it under friend requests.

So a privacy boundary had been traded for a subtitle, and CI then held the trade
in place — removing the field failed the suite and read as the regression.

## The part that cost something to learn

**A privacy change is a data-shape change, and every consumer of that shape
needs sweeping — not just the endpoint.**

The fix removed `friends` from the public shape, correctly: a full social graph
should not be readable by anyone who opens a profile. `Profile.jsx` was left
reading `profile.friends`. The result, in production:

- every user with friends looked friendless to everyone else — `Friends (0)`,
  and a Total Friends stat of zero
- and because `undefined === 0` is **false**, the friends tab skipped its empty
  state entirely, mapped over `undefined`, and rendered a blank panel

A privacy boundary rendering as an empty life.

This is the same collapsed distinction the project keeps hitting — empty states
hiding failed requests, a media 401 rendering as a missing file, an error
boundary presenting a permanent failure as a transient one. A real state and an
absent state made indistinguishable. What makes this one worth an entry is that
it was introduced **by** a fix rather than found by one, and no amount of care
at the endpoint would have caught it.

## What follows from it

When a serialiser stops returning a field:

1. Grep every consumer of that field before shipping — client and server.
2. **Array-shaped fields are the sharp edge.** `?.length || 0` reads a missing
   array as zero rather than failing, so the page renders a confident wrong
   number instead of an error. Prefer an explicit count from the server
   (`friendCount`) over deriving one from a list the caller may not receive.
3. Decide what the absence should *say*. "We are not showing you this" and
   "there is nothing here" are different facts and must not render the same.
   The friends tab now says only that person can see who they are connected
   with.
4. Check `=== 0` comparisons against fields that may now be `undefined`. They
   silently stop matching, which usually skips an empty state rather than
   throwing — a failure that leaves no trace.

## Consequences

Adding a column now takes a deliberate line in `serialize.js` to become public.
That is the intended cost.

`GET /api/admin/users/search` still returns contact details, deliberately and
with a comment saying so: moderation matches reports to accounts by email, and
the route is behind `requireAdmin`.

See [0002](0002-lint-must-be-configured-to-look.md) for the other half of the
same week.
