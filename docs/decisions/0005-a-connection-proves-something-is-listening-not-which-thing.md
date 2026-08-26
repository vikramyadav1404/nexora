# 0005 — A connection proves something is listening, not which thing

Date: 2026-08-27
Status: accepted

## Decision

A tool that spins up or targets a database must **verify the identity of the
thing it reached** before writing to it. A successful connection is not proof of
identity — it proves only that *something* accepted the connection on that
address. Confirm which server it is: check `data_directory` and port together,
or write a sentinel row and read it back, before running anything destructive.

## What happened

Proving the race-guard SQL fix called for a throwaway Postgres. The sequence:

1. `initdb` created a scratch cluster in a temp directory.
2. `pg_ctl -o "-p 5433" start` printed **`pg_ctl: could not start server`** —
   because port 5433 was already taken by a real `postgresql-x64-17` service on
   the machine.
3. `psql -p 5433` connected successfully.
4. I read "psql connected" as "my cluster started", and proceeded to run
   `DROP SCHEMA public CASCADE` and create tables — **against the real
   instance's `postgres` database**, not the throwaway, for the rest of the
   session.

No data was lost: that instance held only a stock, empty `postgres` maintenance
database, and the real application data lives in Supabase. But that was luck, not
control. The scratch objects were dropped afterward and the schema restored to
stock.

## Why this is the sharpest instance of the pattern

The whole month has been one shape: **two different facts rendered
identically.** This is that shape at its most acute, because the tool said the
two facts apart *in the same breath* and I collapsed them anyway:

> `pg_ctl: could not start server` — the cluster I asked for did **not** start.
> `psql` connected — **a** server answered.

"My server started" and "some server answered on that port" are different facts.
`pg_ctl` reported the first was false at the exact moment `psql` made the second
look true, and I let the successful connection overwrite the failed start.

It is also the same lesson the seed guard already encodes, one layer down. That
guard exists because **config describes intent, and intent is what is wrong when
someone runs the wrong command** — so it asks the target database what it
*contains* rather than trusting a flag. A successful connection is another kind
of intent-signal: it says "I reached a database", not "I reached *the* database
I meant". The identity has to be read from the target, never inferred from the
fact that the reach succeeded.

## The rule, for the next cluster

Before any destructive statement against a database a script provisioned or was
pointed at:

1. **Do not treat a successful connection as identity.** It is liveness, not
   identity.
2. **Read identity from the server**: `SHOW data_directory` and the port must
   match the throwaway you created, or —
3. **Write a sentinel and read it back**: create a uniquely named marker in the
   cluster you intended, and refuse to proceed if the connection you hold does
   not return it.
4. **A failed `start`/`initdb`/provision step is a hard stop.** If the thing you
   tried to create did not report success, you are not connected to it, whatever
   answers next.

This is the read-side twin of decision 0003 ("verify that the check ran"): there
the failure was a refusal that reported success; here it is a start that failed
while the next call reported success. Both are the same instruction — **verify
the thing you assumed, against the system itself, not against a proxy for it.**

## Consequences

Diagnostic scripts that stand up a scratch database (the SQL contract-test setup,
any future throwaway) must assert target identity before writing. Cheap: one
`SHOW data_directory` comparison, or one sentinel round-trip.

See [`../retrospective-2026-08.md`](../retrospective-2026-08.md) and
[`0003-verify-that-the-check-ran.md`](0003-verify-that-the-check-ran.md).
