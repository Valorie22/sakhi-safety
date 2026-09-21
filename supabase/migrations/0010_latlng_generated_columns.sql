-- 0010_latlng_generated_columns.sql
-- PostgREST serialises a geography column as WKB hex, which no client wants to
-- parse. Generated columns expose plain numbers instead, and they travel in
-- Realtime payloads too.
--
-- Deliberately NOT a view: a Postgres view runs with its owner's rights unless
-- security_invoker is set, which would quietly bypass the RLS policies on the
-- underlying tables. Columns on the table itself inherit the table's policies.

alter table public.emergency_locations
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(location::extensions.geometry)) stored;

alter table public.emergencies
  add column if not exists created_lat double precision
    generated always as (extensions.ST_Y(created_location::extensions.geometry)) stored,
  add column if not exists created_lng double precision
    generated always as (extensions.ST_X(created_location::extensions.geometry)) stored;

alter table public.police_stations
  add column if not exists lat double precision
    generated always as (extensions.ST_Y(location::extensions.geometry)) stored,
  add column if not exists lng double precision
    generated always as (extensions.ST_X(location::extensions.geometry)) stored;

create or replace function public.latest_location(p_emergency_id uuid)
returns table (lat double precision, lng double precision, accuracy_meters numeric, recorded_at timestamptz)
language sql stable security definer set search_path = public, extensions
as $$
  select l.lat, l.lng, l.accuracy_meters, l.recorded_at
    from public.emergency_locations l
   where l.emergency_id = p_emergency_id
     and public.can_view_emergency(p_emergency_id)
   order by l.recorded_at desc
   limit 1;
$$;
grant execute on function public.latest_location(uuid) to authenticated;
