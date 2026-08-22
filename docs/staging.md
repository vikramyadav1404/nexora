# Standing up a staging environment

Nexora had no staging environment for its first month. Every defect found in
that month was found either by an audit or in production — the bucket flip, the
media proxy, a contact-detail leak, a page that crashed for every visitor. None
was caught before deploy, because there was nowhere to catch it.

This is how to build the place to catch them.

---

## Before anything else: every secret must be new

**Do not copy a single secret from production.** `JWT_SECRET` above all.

If staging and production share a signing secret, a token minted in staging is
valid in production. Staging is where anyone can register freely and where you
will make yourself an admin to test the moderation queue — so a shared secret
turns staging into an authentication bypass for production, reachable by anyone
who can sign up.

The same reasoning applies to:

| Secret | What sharing it would mean |
|---|---|
| `JWT_SECRET` | staging tokens authenticate against production |
| `MFA_SECRET_KEY` | staging can decrypt production TOTP secrets |
| `CRON_SECRET` | a staging cron call triggers production's media deletion |
| `SUPABASE_SERVICE_ROLE_KEY` | staging writes to the production database |

Generate fresh values:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

A staging environment sharing secrets with production is worse than having no
staging environment at all.

---

## 1. The Supabase project

Create a second project. Check your plan first — the free tier allows two active
projects.

Apply the schema:

```bash
cd server
npm run migration:runner          # generates the SQL to paste into the editor
npm run verify:schema             # confirms it landed
npm run check:buckets             # confirms staging's buckets are private too
```

`check:buckets` matters here. Public storage buckets were a real finding in
production; repeating the mistake in a second environment would put synthetic
media at a public URL and, worse, teach everyone that the check is noise.

---

## 2. Environment variables

Two Vercel projects, mirroring production. Every value fresh.

**API project** — same list as production (see `server/.env.example`), plus:

```
APP_ENV=staging
CLIENT_URL=https://<your-staging-client>.vercel.app
```

**Client project**:

```
VITE_ENVIRONMENT=staging
```

`VITE_API_URL` stays **empty**, exactly as in production. Setting it makes the
client talk cross-origin, and the refresh cookie is `SameSite=Strict` — it would
never be sent, so nobody would stay logged in.

### Production needs its markers too

```
APP_ENV=production            # nexora-api
VITE_ENVIRONMENT=production   # client
```

Without them, production reports `environment: "unknown"` and the app shows a
"Non-production environment" banner to real users. That is the fail-safe working
as designed — the banner appears unless something explicitly proves the
deployment is production — but it is still a visible regression, so set these
before deploying.

---

## 3. Seed it — synthetic only

```bash
cd server
APP_ENV=staging npm run seed:staging -- --confirm <staging-project-ref>
```

Creates 12 accounts on `@nexora.invalid` (RFC 2606 reserved, so those addresses
can never route anywhere real), with friendships, questions, answers and posts,
so every page has something to render. Password is printed at the end.

**Never copy production data here.** A staging database holding real contact
details is a second place to leak them, with weaker access control and more
people holding keys.

### What stops this running against production

Two layers, and only the second is load-bearing.

**Config checks** — `APP_ENV` must be exactly `staging`, and `--confirm` must
name a project reference that appears in `SUPABASE_URL`. Cheap, and they fail
early with a clear message.

**The database check** — before writing anything, the seeder counts accounts
whose email is not synthetic. If any exist, it refuses.

Config describes *intent*, and intent is exactly what is wrong when someone runs
the wrong command: a stale `.env`, a variable exported in a previous shell, a
copied deploy line. The rows cannot lie. A database containing real people is
not a staging database, whatever any variable says.

This has been tested against the live production database with every config
check deliberately passing. It refused:

```
Refusing to seed: this database contains 14 account(s) that are not
synthetic, out of 29.
  - ab***@gamil.com
  ...
A database with real people in it is not a staging database, whatever
APP_ENV says. Check SUPABASE_URL.
```

---

## 4. How you know which environment you are looking at

Two independent sources, because either alone misses the case that matters.

- **The build** knows what it was built as (`VITE_ENVIRONMENT`)
- **The API** knows what it is running as (`/api/version` → `environment`)

A banner driven by the build alone tells you which bundle loaded. It says
nothing about which database is behind it — and a staging bundle talking to the
production API is the specific way a destructive test lands on real data. The
page would look safe, be clearly labelled staging, and every write would hit
production.

So the banner compares them and escalates on disagreement:

| Build | API | Result |
|---|---|---|
| `production` | `production` | nothing |
| `staging` | `staging` | amber banner, "all data here is synthetic" |
| unset / misspelled | anything | amber banner — unconfigured is not production |
| `staging` | `production` | **red blocking warning naming both sides** |

The banner is not dismissible. The person most likely to close it is the one who
has been looking at staging all morning and has stopped noticing — which is
exactly who needs it when they open production in the next tab.

---

## 5. First thing to do with it

Run the media sweep wet. It is the only unattended job that destroys data, it
has twice been one bug away from deleting everything, and it has never been run
anywhere disposable.

```bash
# dry first — names what it would remove, removes nothing
curl -X POST https://<staging-api>/api/cron/sweep-media \
  -H "Authorization: Bearer $STAGING_CRON_SECRET" -d '{}'

# then for real
curl -X POST https://<staging-api>/api/cron/sweep-media \
  -H "Authorization: Bearer $STAGING_CRON_SECRET" \
  -H 'Content-Type: application/json' -d '{"confirm":"delete"}'
```

Then break it deliberately: empty `post_media` while the objects remain, and
confirm the circuit breaker **aborts** rather than deleting everything. That
path is currently proven only against a fake PostgREST client; staging is where
it can be proven against real storage, real pagination and real object metadata.

That rehearsal is the entire point of having this environment.

---

## Related

- [`retrospective-2026-08.md`](retrospective-2026-08.md) — why this exists
- [`decisions/0001`](decisions/0001-user-serialisation-is-an-allowlist.md)
- [`decisions/0002`](decisions/0002-lint-must-be-configured-to-look.md)
