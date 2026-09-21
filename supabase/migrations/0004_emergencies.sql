-- 0004_emergencies.sql
-- The incident record and everything hanging off it.

create table public.emergencies (
  id                    uuid primary key default extensions.gen_random_uuid(),
  emergency_code        text not null unique
                          default 'EMG-' || nextval('public.emergency_code_seq'),
  -- Client-generated idempotency key. A retried "create emergency" request
  -- carrying the same key returns the original row instead of a duplicate.
  client_request_id     uuid not null unique,
  user_id               uuid not null references public.profiles (id) on delete cascade,
  trigger_type          public.trigger_type not null,
  level                 integer not null default 1 check (level between 1 and 3),
  status                public.emergency_status not null default 'active',
  created_location      extensions.geography(Point, 4326) not null,
  created_accuracy_m    numeric,
  address_hint          text,
  claimed_by_officer_id uuid references public.police_officers (id) on delete set null,
  claimed_at            timestamptz,
  responding_at         timestamptz,
  on_scene_at           timestamptz,
  resolved_at           timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,
  escalated_at          timestamptz,
  resolution_note       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- An emergency is claimed-or-later exactly when it has an owning officer.
  constraint emergencies_claim_consistent check (
    (claimed_by_officer_id is null and claimed_at is null)
    or (claimed_by_officer_id is not null and claimed_at is not null)
  ),
  constraint emergencies_open_has_no_owner check (
    status <> 'active' or claimed_by_officer_id is null
  )
);

create index emergencies_user_idx    on public.emergencies (user_id, created_at desc);
create index emergencies_status_idx  on public.emergencies (status, level desc, created_at desc);
create index emergencies_officer_idx on public.emergencies (claimed_by_officer_id);
-- Partial index for the "still running" set the dashboards and cron care about.
create index emergencies_open_idx on public.emergencies (created_at)
  where status in ('active', 'claimed', 'responding', 'on_scene');

create trigger emergencies_touch before update on public.emergencies
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- emergency_stations: fan-out of one incident to every covering station.
-- ---------------------------------------------------------------------------

create table public.emergency_stations (
  id            uuid primary key default extensions.gen_random_uuid(),
  emergency_id  uuid not null references public.emergencies (id) on delete cascade,
  station_id    uuid not null references public.police_stations (id) on delete cascade,
  distance_m    numeric,
  notified_at   timestamptz not null default now(),
  constraint emergency_stations_unique unique (emergency_id, station_id)
);

create index emergency_stations_station_idx on public.emergency_stations (station_id, notified_at desc);

-- ---------------------------------------------------------------------------
-- emergency_locations: the live track.
-- ---------------------------------------------------------------------------

create table public.emergency_locations (
  id             uuid primary key default extensions.gen_random_uuid(),
  emergency_id   uuid not null references public.emergencies (id) on delete cascade,
  location       extensions.geography(Point, 4326) not null,
  accuracy_meters numeric,
  speed          numeric,
  heading        numeric,
  recorded_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index emergency_locations_feed_idx
  on public.emergency_locations (emergency_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- emergency_audio: metadata only. The bytes live in a private Storage bucket
-- and are only ever reachable through a short-lived signed URL.
-- ---------------------------------------------------------------------------

create table public.emergency_audio (
  id               uuid primary key default extensions.gen_random_uuid(),
  emergency_id     uuid not null references public.emergencies (id) on delete cascade,
  storage_path     text not null unique,
  segment_index    integer not null default 0,
  duration_seconds numeric,
  size_bytes       bigint,
  mime_type        text default 'audio/m4a',
  status           public.audio_status not null default 'recording',
  error_message    text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz
);

create index emergency_audio_emergency_idx
  on public.emergency_audio (emergency_id, segment_index);

-- ---------------------------------------------------------------------------
-- emergency_timeline: append-only narrative. No update/delete policy is ever
-- granted on this table - see 0006_rls.sql.
-- ---------------------------------------------------------------------------

create table public.emergency_timeline (
  id           uuid primary key default extensions.gen_random_uuid(),
  emergency_id uuid not null references public.emergencies (id) on delete cascade,
  event_type   public.timeline_event_type not null,
  event_data   jsonb not null default '{}'::jsonb,
  actor_id     uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create index emergency_timeline_feed_idx
  on public.emergency_timeline (emergency_id, created_at);

-- Belt and braces: even the service role cannot rewrite history through SQL
-- issued by the app, because the trigger refuses the statement outright.
create or replace function public.forbid_timeline_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'emergency_timeline is append-only (attempted %)', tg_op;
end;
$$;

create trigger emergency_timeline_immutable
  before update or delete on public.emergency_timeline
  for each row execute function public.forbid_timeline_mutation();

-- ---------------------------------------------------------------------------
-- notifications: durable record of every send, independent of push delivery.
-- ---------------------------------------------------------------------------

create table public.notifications (
  id                   uuid primary key default extensions.gen_random_uuid(),
  recipient_id         uuid references public.profiles (id) on delete cascade,
  recipient_station_id uuid references public.police_stations (id) on delete cascade,
  emergency_id         uuid references public.emergencies (id) on delete cascade,
  type                 public.notification_type not null,
  title                text not null,
  body                 text not null,
  -- Intentionally minimal: ids and codes only, never names/addresses/audio.
  payload              jsonb not null default '{}'::jsonb,
  -- Caller-composed idempotency key for this notification, e.g.
  -- 'level_escalated:3' or 'status_changed:responding'. Escalating 1->2->3
  -- must produce two notifications, so the level is part of the key rather
  -- than the type alone. Null means "never deduplicate".
  dedupe_key           text,
  read_at              timestamptz,
  created_at           timestamptz not null default now(),
  constraint notifications_has_recipient check (
    recipient_id is not null or recipient_station_id is not null
  )
);

create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_station_idx   on public.notifications (recipient_station_id, created_at desc);
create index notifications_unread_idx    on public.notifications (recipient_id)
  where read_at is null;
-- Stops a retry or a re-notify pass from writing the same row twice.
create unique index notifications_dedupe_user
  on public.notifications (recipient_id, emergency_id, dedupe_key)
  where recipient_id is not null and emergency_id is not null and dedupe_key is not null;
create unique index notifications_dedupe_station
  on public.notifications (recipient_station_id, emergency_id, dedupe_key)
  where recipient_station_id is not null and emergency_id is not null and dedupe_key is not null;

alter table public.evidence_access_log
  add constraint evidence_access_log_emergency_fk
  foreign key (emergency_id) references public.emergencies (id) on delete cascade;

alter table public.evidence_access_log
  add constraint evidence_access_log_audio_fk
  foreign key (audio_id) references public.emergency_audio (id) on delete set null;
