# Sakhi — women's safety emergency response platform

*सखी — "a woman's trusted friend."*

When a woman triggers an alert, Sakhi works out which police stations actually
cover where she is standing, notifies every one of them plus the people she
trusts, starts sharing her live location, and — from Level 2 upwards — records
ambient audio as evidence into private storage. Exactly one officer can ever own
a case, and the database guarantees it.

```
apps/mobile      Expo (React Native) + TypeScript + Expo Router
services/api     Node + Express + TypeScript  (owns dispatch, claiming, evidence access)
supabase/        SQL migrations: schema, PostGIS, RLS, functions
```

---

## 1. What is already running

A Supabase project is provisioned, migrated and seeded:

| | |
|---|---|
| Project URL | see `LOCAL-SETUP.md` (not committed) |
| Region | `ap-south-1` (Mumbai) |
| Extensions | PostGIS 3.3.7, pg_cron, pgcrypto, citext |
| Storage | private bucket `emergency-audio` |

All twelve migrations in `supabase/migrations/` are applied.

### Demo accounts

Password for all of them: `Demo!pass1`

| Email | Role | Notes |
|---|---|---|
| `alice@example.com` | user | Has `bob` as an accepted contact |
| `bob@example.com` | user | Receives Alice's alerts |
| `off1@example.com` | police | STN-1001, badge B-101 |
| `off2@example.com` | police | STN-1001, badge B-102 — same queue as off1 |
| `admin@example.com` | admin | Creates stations and officers |

Three seeded stations around Mumbai, two with **deliberately overlapping**
coverage so multi-station dispatch is visible immediately.

> **Delete these before this project touches anything real.**
> `delete from auth.users where email like '%@example.com';`

---

## 2. Setup

You need **one secret** that cannot be committed or fetched for you: the
Supabase **service-role key**. It bypasses RLS entirely, so it lives only on the
server.

Supabase dashboard → Project Settings → API → `service_role` → reveal & copy.

```bash
cp services/api/.env.example services/api/.env
# paste the service_role key into SUPABASE_SERVICE_ROLE_KEY
# SUPABASE_ANON_KEY is already filled in below
```

The anon key is safe to ship in an app bundle — RLS decides what it can reach —
but it is kept out of this public repo so the live project is not advertised.
Both values are in `LOCAL-SETUP.md`, which `.gitignore` excludes, and in the
Supabase dashboard under Project Settings → API.

```bash
cp apps/mobile/.env.example apps/mobile/.env   # anon key + API url

npm install                      # workspaces: installs both packages
npm run api                      # http://localhost:4000
npm run mobile                   # Expo dev server
```

On a physical phone, set `EXPO_PUBLIC_API_URL` to your machine's LAN address
(`http://192.168.x.x:4000`) — `localhost` on the phone means the phone.

---

## 3. The two things that had to actually work

### Atomic case claiming

Two officers at STN-1001 tap **Take Case** at the same instant. Exactly one wins.

The whole race lives inside a single conditional `UPDATE`:

```sql
update public.emergencies
   set claimed_by_officer_id = p_officer_id,
       status = 'claimed', claimed_at = now()
 where id = p_emergency_id
   and claimed_by_officer_id is null     -- the guard
   and status = 'active'
returning * into v_claimed;
```

Concurrent transactions serialise on the row lock. The loser re-evaluates that
predicate against the winner's committed row, matches zero rows, and is told who
won. There is **no check-then-write window** for the race to live in.

```bash
npm run test:concurrency
```

Eight officers, five rounds, each claim a separate HTTP request to PostgREST —
so genuinely eight connections, eight backends, eight transactions on one row.
Asserts one winner, seven `already_claimed` all naming the same officer, one
`case_claimed` timeline event. The same file also fires six simultaneous
identical SOS submissions and asserts they collapse to one emergency.

### RLS as the real boundary

```bash
npm run test --workspace @sakhi/api      # includes tests/rls.test.ts
```

Signs in as five real accounts with the public anon key and tries to read what
it shouldn't. Verified directly against the database:

| Persona | Emergencies visible |
|---|---|
| reporter | 1 |
| accepted contact | 1 |
| officer at a dispatched station | 1 |
| officer at a **different** station | **0** |
| unrelated signed-in user | **0** |

It also asserts a user cannot promote their own `role`, cannot create a station,
cannot call `trigger_emergency` or `claim_emergency` directly, and that
`emergency_timeline` rejects UPDATE and DELETE *even from the service role*.

---

## 4. How the pieces fit

**Dispatch is one transaction.** `trigger_emergency()` inserts the emergency,
runs the PostGIS radius query, writes one `emergency_stations` row per covering
station, notifies stations and accepted contacts, records the first location
ping and opens the timeline — all atomically. A half-dispatched emergency cannot
exist.

**Radius, not nearest.** `ST_DWithin` against a GiST-indexed `geography` column
returns *every* active station whose circle contains the point. Overlap is
expected and correct.

**Idempotency.** The client generates a UUID before it touches the network.
`emergencies.client_request_id` is unique, and a retry returns the original row
with `idempotent_replay: true`. A flaky connection cannot produce two
emergencies.

**Notifications are an outbox.** State changes write notification rows inside
the same transaction. A worker drains them to Expo push afterwards using
`FOR UPDATE SKIP LOCKED`. If the process dies mid-push, the record survives and
the in-app notification centre still shows it.

**Audio is never public.** The bucket is private. The phone uploads through a
signed upload URL; officers read through a 120-second signed download URL minted
only after the server re-derives authorisation, and every issue is written to
`evidence_access_log`. Accepted contacts can see location and timeline but
**not** audio — a recording of someone's worst moment is evidence, not a family
feed.

**Escalation never forks.** It raises `level` on the existing row and re-fires
that level's notifications. `pg_cron` runs `auto_escalate_stale_emergencies()`
every minute; the windows live in `system_config`, not in code.

---

## 5. What this does *not* do

**Sakhi cannot reach the police with no internet connection.** There is no
offline transport here and none is faked. A trigger with no signal is written to
disk, retried with backoff, and the screen says plainly that it has *not* been
sent and to call 112. The transport is isolated behind `flush()` in
`apps/mobile/src/lib/emergencyQueue.ts` so a mesh or SMS relay could be added
later without reshaping callers.

**Shake detection only runs while the app is foregrounded.** Expo cannot hold
the accelerometer in the background without a native background task. The
Safety Settings screen says so instead of implying round-the-clock cover.

**Maps need a dev build.** `react-native-maps` requires a Google Maps key on
Android. `MapPanel` loads it defensively and falls back to a live coordinate
readout that says what it is — a blank grey rectangle that a responder could
misread as "she isn't moving" is a worse failure than no map.

**There is no police sign-up.** Officer accounts exist only via the admin route,
which creates the auth user, the `police` profile and the `police_officers` row
together, and rolls all three back if any step fails.

---

## 6. Known gaps

- **Leaked-password protection is off.** Turn it on: Dashboard → Authentication →
  Policies → "Prevent use of leaked passwords". It is a dashboard toggle, not a
  migration.
- **No push credentials configured.** `getExpoPushTokenAsync()` needs an EAS
  project id to return a token outside Expo Go. Until then the outbox marks
  rows delivered and the in-app notification centre carries everything.
- **The API has route tests only via the DB-level suites** — no supertest layer
  over the Express routes yet.

---

## 7. API surface

```
GET    /health

GET    /api/v1/me                      profile + settings + officer record
PATCH  /api/v1/me                      name, phone  (role is not an accepted field)
PATCH  /api/v1/me/settings             safety settings
POST   /api/v1/me/push-token
GET    /api/v1/me/notifications
GET    /api/v1/me/config               ping interval, staleness, audio caps
GET    /api/v1/me/coverage?lat=&lng=   which stations cover a point

POST   /api/v1/contacts/search         exact email only, hard rate limited
GET    /api/v1/contacts                myCircle + protecting
POST   /api/v1/contacts/requests
POST   /api/v1/contacts/requests/:id/respond
DELETE /api/v1/contacts/:id

POST   /api/v1/emergencies             trigger  (idempotent, rate limited)
GET    /api/v1/emergencies/active
GET    /api/v1/emergencies/watching    the family feed
GET    /api/v1/emergencies/:id
GET    /api/v1/emergencies/:id/timeline
GET    /api/v1/emergencies/:id/locations
POST   /api/v1/emergencies/:id/locations
POST   /api/v1/emergencies/:id/cancel
POST   /api/v1/emergencies/:id/escalate
POST   /api/v1/emergencies/:id/audio           register segment + signed upload url
PATCH  /api/v1/emergencies/:id/audio/:audioId  mark uploaded / failed
GET    /api/v1/emergencies/:id/audio/:audioId/url   signed download, audited

GET    /api/v1/police/queue            shared station queue
GET    /api/v1/police/station
POST   /api/v1/police/emergencies/:id/claim     atomic
POST   /api/v1/police/emergencies/:id/status
POST   /api/v1/police/emergencies/:id/escalate

GET/POST/PATCH /api/v1/admin/stations
GET/POST/PATCH /api/v1/admin/officers
GET    /api/v1/admin/audit
GET    /api/v1/admin/evidence-access
```

---

## 8. Acceptance checklist

| | Status |
|---|---|
| Register, log in, manage profile | built |
| Exact-email contact search, accept/decline, accepted-only alerts | built |
| Admin creates stations + officers; no police self-registration | built |
| SOS finds **all** overlapping stations via PostGIS | **verified in DB** — 2 of 3 matched, far station excluded |
| Shake respects thresholds/cooldown, can be disabled | built |
| Timer fires at zero, cancels cleanly, survives backgrounding | built (absolute deadline, persisted) |
| Two officers claim at once — one wins | **verified in DB**; parallel test in `test:concurrency` |
| Losing officers see "already taken" in realtime | built |
| Status progression fires notifications + timeline | built |
| Level 2 audio → private storage → officer-only signed URL | built |
| Level 3 visually unmistakable, re-notifies | built |
| Family and police see only what they're authorised for | **verified in DB** against 5 personas |
| Timeline complete, ordered, immutable | **verified** — trigger rejects UPDATE/DELETE |
| Resolve/cancel stops location writes and recording | built |
| Retried SOS does not create a second emergency | **verified in DB** |

"Verified" means exercised against the live database in this build. "Built"
means implemented and type-checked, but not yet exercised end-to-end on a
device.

---

## 9. Commands

```bash
npm run typecheck        # both packages
npm run api
npm run mobile
npm run test             # API suites (needs service-role key in .env)
npm run test:concurrency # the claim race
```
