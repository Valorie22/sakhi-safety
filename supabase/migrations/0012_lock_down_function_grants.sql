-- 0012_lock_down_function_grants.sql
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and `anon`
-- inherits it. Granting to `authenticated` afterwards therefore did NOT take
-- the capability away from callers who are not signed in at all.
--
-- The one that actually mattered: stations_covering() let an unauthenticated
-- caller probe police station positions and coverage radii through
-- /rest/v1/rpc/. The rest leak nothing (auth.uid() is null for anon, so they
-- return false or null), but an unauthenticated SECURITY DEFINER entry point is
-- not something to leave lying around.

revoke execute on function public.stations_covering(double precision, double precision) from public, anon;
revoke execute on function public.can_view_emergency(uuid)        from public, anon;
revoke execute on function public.my_station_id()                 from public, anon;
revoke execute on function public.is_admin()                      from public, anon;
revoke execute on function public.is_accepted_contact_of(uuid)    from public, anon;
revoke execute on function public.current_role_name()             from public, anon;
revoke execute on function public.config_int(text, integer)       from public, anon;
revoke execute on function public.latest_location(uuid)           from public, anon;

-- A trigger function is invoked by the trigger, never by a caller.
revoke execute on function public.handle_new_user()          from public, anon, authenticated;
revoke execute on function public.touch_updated_at()         from public, anon, authenticated;
revoke execute on function public.forbid_timeline_mutation() from public, anon, authenticated;

-- Re-assert the intended grants after the blanket revokes above.
grant execute on function public.stations_covering(double precision, double precision) to authenticated;
grant execute on function public.can_view_emergency(uuid)     to authenticated;
grant execute on function public.my_station_id()              to authenticated;
grant execute on function public.is_admin()                   to authenticated;
grant execute on function public.is_accepted_contact_of(uuid) to authenticated;
grant execute on function public.current_role_name()          to authenticated;
grant execute on function public.config_int(text, integer)    to authenticated;
grant execute on function public.latest_location(uuid)        to authenticated;

-- Pin search_path on the three functions that were missing it, so a caller
-- cannot shadow an unqualified name with their own schema.
create or replace function public.touch_updated_at()
returns trigger language plpgsql
set search_path = public, extensions
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.forbid_timeline_mutation()
returns trigger language plpgsql
set search_path = public, extensions
as $$
begin
  raise exception 'emergency_timeline is append-only (attempted %)', tg_op;
end;
$$;

create or replace function public.validate_coords(p_lat double precision, p_lng double precision)
returns void language plpgsql immutable
set search_path = public, extensions
as $$
begin
  if p_lat is null or p_lng is null then
    raise exception 'coordinates are required' using errcode = '22023';
  end if;
  if p_lat < -90 or p_lat > 90 then
    raise exception 'latitude % out of range', p_lat using errcode = '22023';
  end if;
  if p_lng < -180 or p_lng > 180 then
    raise exception 'longitude % out of range', p_lng using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.validate_coords(double precision, double precision) from public, anon, authenticated;
