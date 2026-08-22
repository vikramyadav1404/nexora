# What a month of audits found, and the two shapes underneath

August 2026. Written for someone who was not here.

Roughly forty defects were found in Nexora over about three weeks — a security
audit, a line-by-line debugging pass, and then a run of production incidents.
This is not a changelog. The individual bugs matter less than the fact that
almost all of them were one of **two shapes**, and that most had already
survived a review by someone paying attention.

> **A green result that verified nothing, or a distinction that collapsed.**

That framing is the whole document. If you read one section, read
[The two shapes](#the-two-shapes).

Scope: this covers one codebase — a React + Express + Postgres app of roughly
24k lines plus 8k of tests, one maintainer, no staging environment. The patterns
generalise; the specifics are all from here, and nothing below is reconstructed
or illustrative. Every example is a real commit.

---

## The two shapes

### Shape one: false green

A check that passed while proving nothing. Not a missing test — a **present**
test, running, green, and empty.

This is worse than no test, because no test is honest about the gap. A green
test is an active claim that something was verified, and everyone downstream
reasons from that claim.

### Shape two: the collapsed distinction

Two different facts rendered identically. "There is nothing here" and "I could
not find out" become the same empty list. "You may not see this" and "this does
not exist" become the same blank panel. "I cannot read the data" becomes "there
is no data".

The failure is always the same: somewhere, code took a state it did not
understand and mapped it onto one it did.

The two shapes are related. A collapsed distinction is often what a false green
is hiding — the test compares two things that have already been flattened into
each other, so of course it passes.

---

## False green, by example

### The test that enforced the leak

`shapePerson` existed to be the safe shape for rendering *other people*. It was
used in four places whose comments said it withheld contact details. It withheld
the phone number and kept the email address.

A test asserted this. Inside a `describe` block named **"a stranger never
receives contact details"**, an equality assertion pinned the function's keys to
a list containing `email`, with a comment explaining that a settings screen
rendered it under friend requests.

So a privacy boundary had been traded for a subtitle under a name, and CI then
held the trade in place. Removing the field failed the suite and read as the
regression. Six endpoints leaked every user's email address to any logged-in
account; one of them rendered a stranger's address on screen as a search result
subtitle.

**Why it survived:** the test was specific, well-named, and wrong. The name
described an intention nobody re-checked against the assertion underneath it.

### The assertion that was testing the mock

A test asserted that a storage URL was correctly signed. The test double
returned `fake.storage/read/...` — a string it had invented — and the assertion
matched against that string. It was verifying that the fake behaved like the
fake.

**Why it survived:** it was green, it named a real security property, and
nothing about reading it suggested the shape being asserted came from the test
rather than from production.

**What fixed it:** making the double mirror the real URL format
(`/object/sign/<bucket>/<key>?token=…`), which immediately broke two other
tests that had been asserting against the same invention.

### The traversal guard that could be deleted

A path-traversal test passed with the guard removed. Both Express and supertest
normalise `../` before anything under test sees it, so the malicious input never
arrived. What actually rejected the request was an unrelated segment-count
check.

**Why it survived:** it passed, and it tested a real risk. The mutation — delete
the guard, confirm the test goes red — is the only thing that could have found
it, and it was only run because of a habit, not a suspicion.

### The harness that matched the navigation bar

Late in the month a smoke suite was added: render every route, assert the page
mounts. It was built specifically because a page-level `ReferenceError` had
reached production.

Its first version asserted a route marker against the whole document.
`/leaderboard` **passed with the page component returning `null`** — because the
navigation bar contains the word "Leaderboard".

Found by deliberately neutering three pages to `return null` and checking that
all three failed. Two did. The fix was structural rather than better wording:
scope the assertion to the container every routed page wraps itself in, which
the navigation sits outside of.

**Worth dwelling on:** this is a test written *in direct response to* this exact
class of failure, which then exhibited it. Knowing about the trap is not
protection from it.

### The empty result that proved nothing

A privacy test asserted that a search response contained no email addresses. It
did not, because the response contained nothing at all — the fixture had the
searching user *blocking* the person being searched for, and the search route
filters blocked users.

`{"people":[]}` contains no email addresses. It also contains no people.

**What fixed it:** every route in that suite now asserts the person it expects
is actually present, before asserting what is absent.

### The route that was never mounted

In the same suite, one test mounted its router at the wrong path. The request
404'd, and every "response contains no email" assertion passed vacuously.

Caught only because a guard asserting `status === 200` had been added
first — for exactly this reason, one test earlier.

### The script whose every test was an import error

A build guard was written to fail the build if a secret-shaped variable was
exposed to the client bundle. It was written in CommonJS, in a package declared
`"type": "module"`.

Every "test run" of it produced a module-loading error, which was read as the
script correctly rejecting bad input. The script had never executed.

**Why it survived:** the observable outcome of "it works" and "it cannot even
load" were both *a non-zero exit*, which is the collapsed distinction hiding
inside the false green.

### The linter reporting clean for weeks

`npm run lint` was green throughout. It was telling the truth: the configuration
enabled two React rules and nothing else. `no-undef` never ran.

A page shipped reading a variable that did not exist — a guaranteed
`ReferenceError` on every render, for every visitor, on a page in the main
navigation. It was found by a person opening the page in a browser.

The calibration is the transferable part, and it is why "just turn on more
rules" is not the lesson:

| Configuration | `no-undef` output |
|---|---|
| rule off (the status quo) | nothing, forever |
| rule on, no `env` declared | dozens of hits — `window`, `document`, `setTimeout`, `console` |
| rule on, `env: { browser: true }` | **exactly one hit, and it was the bug** |

The middle row is important. That version would have been switched off within a
day, reasonably. A noisy rule gets disabled; a silent rule gets trusted. Both
fail identically — nobody reads the output.

**The useful question about a linter is not "is it enabled" but "what did it
last catch". If the answer is "nothing, ever", that is a finding about the
configuration, not a clean bill of health.**

### The environment the tests never simulated

Avatars 401'd in production for four rounds of investigation. Every check
passed — the database held the right values, the route authorised correctly,
the cookie was minted with the right attributes.

The serialiser was prepending an absolute host to media paths, derived from a
per-deployment environment variable. Cross-origin means a host-scoped cookie is
not sent, and an `<img>` cannot send an `Authorization` header instead.

The tests ran with a clean environment, so the branch that did the prepending
**never executed in a single test**. The production condition was not simulated
anywhere.

Every check read the database value and requested it directly. Nothing asserted
on what the serialiser actually emits, which is the only URL a browser ever
sees. The database was right, the route was right, the cookie was right, and the
seam between them was wrong.

**Probing components individually cannot find a fault that lives between
them.** Three rounds of green results against a failing browser meant the tests
were structurally blind, not that the browser was odd.

---

## Collapsed distinctions, by example

### Eight empty states hiding failed requests

Eight screens rendered "nothing here yet" when their fetch had failed. A network
error, a 500, an expired session — all rendered as an empty list with cheerful
copy inviting the user to create the first one.

The fix was not eight fixes. The fetch layer was changed so that **an empty
state cannot be rendered without knowing whether the request succeeded**: a
three-state resource (`loading | error | ready`), and a shared component that
checks error before empty.

The pattern is worth stating generally: when the same bug appears in eight
places, the eight are a symptom. The cause is that the API made the wrong thing
easy.

### The image that could not say why it failed

When media moved behind an authorising proxy, an image request became something
that could fail for authorisation reasons. But an `<img>` cannot send an auth
header, cannot retry, and cannot report why it failed. A 401 rendered as the
same broken-image glyph as a deleted file.

A missing credential and a missing file are different facts. One is
recoverable — ask for the credential again — and the other is not.

### "Reloading usually clears it"

The error boundary made one distinction: chunk-load failure, or everything else.
Everything else got *"That page hit an unexpected error. Reloading usually
clears it."*

For the page that threw on every render, that was false every single time. A
permanent failure presented as a transient one, telling the user to try
something that could not work while the real problem stayed invisible — the
stack trace went to the affected user's console and nowhere else.

It now records the error's signature before reloading, and if the same signature
returns, says that reloading did not fix it. **It finds out rather than
guessing.**

### `undefined === 0`, and a privacy boundary that looked like an empty life

This one was introduced *by* a fix, which is what makes it worth the most.

A serialiser was correctly changed to stop exposing every user's friend list to
strangers. One consumer was left reading the removed field. The result:

- every user with friends showed **"Friends (0)"** to everyone else
- and because `undefined === 0` is **false**, the empty-state branch never
  fired: the tab mapped over `undefined` and rendered a blank panel

So "we are not showing you this" rendered as "this person has nobody".

**`?.length || 0` is the sharp edge.** A missing array reads as zero rather than
failing, so the page renders a confident wrong number instead of an error. There
is no stack trace, no log line, and nothing to notice.

The rule that came out of it: **a privacy change is a data-shape change, and
every consumer of that shape needs sweeping — not just the endpoint.**

### The ternary that absorbed a third case

A nightly job resolved which database column held live keys with:

```js
kind === 'avatar' ? 'avatar_key' : 'cover_key'
```

Correct for exactly as long as there were two kinds. A third was added later,
and the ternary silently answered `cover_key` for it — so those objects were
compared against a set they could never appear in, matched nothing *by
construction*, and were judged orphaned. The job deleted them an hour after
upload.

**A binary conditional is a claim that there are exactly two cases.** It does
not fail when a third arrives; it absorbs it into whichever branch is last. The
replacement is an explicit map, so an unmapped kind causes the job to *skip*
that bucket rather than guess a column.

### "I could not read the data" as "there is no data"

In the same job, the query loading live keys discarded its error. A statement
timeout produced an empty set — and an empty live set means everything looks
orphaned. One slow query would have deleted every avatar and cover on the
platform.

The asymmetry hid it: the *other* query in the same loop fails safe, because no
users means nothing is scanned. One failure mode was harmless and its neighbour
was catastrophic, and they looked identical in the code.

This is the same collapse as the empty states, one layer down. An absent result
and a failed lookup are different facts.

### The allowlist with a denylist escape hatch

A user serialiser was a careful, explicit allowlist — and ended with
`_raw: safe`, attaching the entire database row minus four fields.

So encrypted TOTP secrets, brute-force lockout state, and password-reset token
expiry rode along on every user object the API returned, on an endpoint that
accepted any user id. Encrypting the MFA secret at rest defends against someone
holding a database dump; this handed it over without one.

Nothing consumed `_raw`. It was referenced exactly once — on the line that
created it.

**An allowlist with one unrestricted field is a denylist.** The four exclusions
made it look considered.

### Loud where it did not matter, silent where it did

A JWT helper returned the string `'dev_insecure_jwt'` when the signing secret
was unset. The verification middleware failed closed, so a misconfigured deploy
returned 500s on protected routes — visibly broken.

Meanwhile login kept issuing sessions, signed with a string published in the
repository, forgeable for any user id.

The loud failure was in the harmless direction. The silent one was in the
direction that mattered. A development convenience survives to production
precisely because it never fails — nothing ever tells you the real value is
missing.

---

## What actually found things

Three questions, in rough order of how much they returned.

### 1. "Would this test fail if the behaviour were removed?"

Mutation testing, done by hand: delete the guard, run the test, confirm it goes
red, put it back. This is the single highest-yield practice in this document.

It found the traversal guard that could be deleted, the assertion testing its
own mock, and eight or more tests that were verifying nothing. It is also what
validated every fix in the month — roughly forty mutations, each with the
expected number of failures recorded in the commit.

It costs about a minute per guard. It is the only way to distinguish a test that
verifies something from a test that merely runs.

### 2. "What is this check actually comparing?"

Not what it is named, not what its comment claims — what the two sides of the
comparison actually contain at runtime.

This found the mock-shaped assertion, the empty `people: []`, the un-mounted
route, and the smoke test matching the navigation bar. In every case the check
was comparing two things that were both wrong, or both empty, or both invented
by the test.

A corollary: **a comment on a security boundary that says what it protects is a
liability if nobody re-derives it.** Three separate comments in this codebase
asserted that a function withheld contact details. It withheld one of the two.

### 3. "Do these two states render the same?"

Applied to any place where an absence, a failure, and a refusal could arrive at
the same code path. Empty vs failed. Missing credential vs missing file. Not
permitted vs not present. Cannot read vs nothing to read.

Every collapsed distinction in this document would have been caught by asking
this at the point the states meet.

### And one meta-lesson

**When repeated verification passes and the reported symptom persists, the
verification is wrong.** It took three rounds of "every check passes" against
"my avatar is still broken" to stop re-running the checks and start asking what
the checks structurally could not see. The answer was that all of them read the
database and none read the API response.

A green suite against a failing user is not a puzzle about the user.

---

## What is still not true about this codebase

So this does not read as a victory lap.

- **There is no staging environment.** Every incident here was found by audit or
  in production. Nothing was caught before deploy, because there is nowhere to
  catch it. This is the single largest gap and it is the reason several of the
  above were found by a person rather than a machine.
- **The client is tested at mount level only.** Every route is smoke-tested;
  almost no behaviour is. Anything that breaks after an interaction is uncovered.
- **Demo mode is a second implementation** of 59 endpoints, hand-maintained, and
  it has already drifted.
- **Search cannot page past 50 results**, and a query that is only a typo finds
  nothing.
- **Subscriptions do not recur**, which is currently a product decision being
  made by omission rather than on purpose.
- **`audit_logs` does not exist** and nothing writes to it.

And the honest one: the two shapes in this document are a lens, not a checklist.
They were derived after the fact from bugs that were each found some other way.
The smoke harness exhibiting the exact failure it was written to prevent is the
best evidence available that knowing the pattern is not the same as being immune
to it.

---

## Related

- [`docs/decisions/0001`](decisions/0001-user-serialisation-is-an-allowlist.md)
  — allowlist serialisation, and why a privacy change is a data-shape change
- [`docs/decisions/0002`](decisions/0002-lint-must-be-configured-to-look.md)
  — the linter calibration
