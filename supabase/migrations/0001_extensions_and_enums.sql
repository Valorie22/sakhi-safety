-- 0001_extensions_and_enums.sql
-- Foundations: PostGIS, shared enums, human-readable code sequences, system config.

create extension if not exists postgis with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext   with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- "family" is deliberately NOT a role. It is a relationship expressed by an
-- accepted row in emergency_contacts. Any user can be both at once.
create type public.user_role as enum ('user', 'police', 'admin');

create type public.contact_status as enum ('pending', 'accepted', 'declined', 'removed');

create type public.trigger_type as enum ('button', 'shake', 'timer');

create type public.emergency_status as enum (
  'active',      -- created, nobody has picked it up
  'claimed',     -- an officer owns it
  'responding',  -- officer en route
  'on_scene',    -- officer arrived
  'resolved',
  'cancelled'
);

create type public.audio_status as enum ('recording', 'uploaded', 'failed');

create type public.timeline_event_type as enum (
  'sos_triggered',
  'station_notified',
  'family_notified',
  'case_claimed',
  'status_changed',
  'level_escalated',
  'audio_started',
  'audio_available',
  'audio_failed',
  'location_stale',
  'resolved',
  'cancelled'
);

create type public.notification_type as enum (
  'emergency_triggered',
  'station_notified',
  'officer_assigned',
  'officer_responding',
  'officer_on_scene',
  'emergency_resolved',
  'emergency_cancelled',
  'audio_available',
  'contact_request',
  'contact_accepted',
  'contact_declined',
  'level_escalated'
);

-- ---------------------------------------------------------------------------
-- Human-readable code sequences (EMG-10291, STN-1001)
-- ---------------------------------------------------------------------------

create sequence if not exists public.emergency_code_seq start with 10001;
create sequence if not exists public.station_code_seq   start with 1001;

-- ---------------------------------------------------------------------------
-- System config: every "configurable" number in the spec lives here so nothing
-- important is hardcoded in application code.
-- ---------------------------------------------------------------------------

create table public.system_config (
  key         text primary key,
  value       jsonb       not null,
  description text,
  updated_at  timestamptz not null default now()
);

insert into public.system_config (key, value, description) values
  ('auto_escalate_level_1_seconds', '180'::jsonb,
   'Seconds a level-1 emergency may sit unclaimed before auto-escalating to level 2.'),
  ('auto_escalate_level_2_seconds', '300'::jsonb,
   'Seconds a level-2 emergency may sit unclaimed before auto-escalating to level 3.'),
  ('location_stale_seconds', '60'::jsonb,
   'No location ping for this long => viewers see a STALE badge.'),
  ('location_ping_interval_seconds', '15'::jsonb,
   'How often the mobile app should push a location ping during an emergency.'),
  ('max_audio_segment_seconds', '120'::jsonb,
   'Audio is recorded in segments of at most this length, then rotated and uploaded.'),
  ('max_audio_total_seconds', '1800'::jsonb,
   'Hard cap on total ambient recording per emergency. Never record indefinitely.'),
  ('sos_rate_limit_per_hour', '10'::jsonb,
   'Max emergencies a single user may create per hour.')
on conflict (key) do nothing;

alter table public.system_config enable row level security;

-- Readable by any signed-in client (the mobile app needs the intervals);
-- writable by nobody except the service role, which bypasses RLS.
create policy system_config_read on public.system_config
  for select to authenticated using (true);
