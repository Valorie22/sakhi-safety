-- 0003_stations_and_officers.sql
-- Police stations (one shared identity per station, used for dispatch) and the
-- individually attributable officer logins that belong to them.

create table public.police_stations (
  id                     uuid primary key default extensions.gen_random_uuid(),
  station_code           text not null unique
                           default 'STN-' || nextval('public.station_code_seq'),
  name                   text not null,
  address                text,
  phone                  text,
  location               extensions.geography(Point, 4326) not null,
  coverage_radius_meters numeric not null check (coverage_radius_meters > 0
                                                 and coverage_radius_meters <= 200000),
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- The index that makes "which stations cover this point" cheap.
create index police_stations_location_gix on public.police_stations
  using gist (location);
create index police_stations_active_idx on public.police_stations (is_active)
  where is_active;

create trigger police_stations_touch before update on public.police_stations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- police_officers: one row per officer login, tied to exactly one station.
-- Officers are NEVER collapsed into a shared account - case ownership has to
-- stay attributable to a named person.
-- ---------------------------------------------------------------------------

create table public.police_officers (
  id            uuid primary key references public.profiles (id) on delete cascade,
  station_id    uuid not null references public.police_stations (id) on delete restrict,
  badge_number  text not null,
  rank          text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint police_officers_badge_unique unique (station_id, badge_number)
);

create index police_officers_station_idx on public.police_officers (station_id)
  where is_active;

create trigger police_officers_touch before update on public.police_officers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- admin_audit_log: every station/officer mutation an admin performs.
-- ---------------------------------------------------------------------------

create table public.admin_audit_log (
  id           uuid primary key default extensions.gen_random_uuid(),
  admin_id     uuid references public.profiles (id) on delete set null,
  action       text not null,
  target_table text not null,
  target_id    uuid,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index admin_audit_log_created_idx on public.admin_audit_log (created_at desc);

-- ---------------------------------------------------------------------------
-- evidence_access_log: who opened which audio file, and when. Not demanded by
-- the spec, but this is safety-critical data and un-audited access to it is a
-- liability.
-- ---------------------------------------------------------------------------

create table public.evidence_access_log (
  id           uuid primary key default extensions.gen_random_uuid(),
  actor_id     uuid references public.profiles (id) on delete set null,
  emergency_id uuid not null,
  audio_id     uuid,
  action       text not null default 'signed_url_issued',
  created_at   timestamptz not null default now()
);

create index evidence_access_log_emergency_idx
  on public.evidence_access_log (emergency_id, created_at desc);
