-- 0011_admin_station_rpcs.sql
-- PostgREST cannot write a geography literal through an ordinary insert, so
-- station writes go through these helpers. Both are revoked from every client
-- role: only the API's service role can reach them, and it checks for an admin
-- profile first.

create or replace function public.admin_create_station(
  p_name text, p_lat double precision, p_lng double precision, p_radius numeric,
  p_address text default null, p_phone text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_row public.police_stations;
begin
  perform public.validate_coords(p_lat, p_lng);
  if p_radius is null or p_radius <= 0 then
    raise exception 'coverage radius must be positive' using errcode = '22023';
  end if;

  insert into public.police_stations (name, location, coverage_radius_meters, address, phone)
  values (p_name, extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography, p_radius, p_address, p_phone)
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'station_code', v_row.station_code, 'name', v_row.name,
    'lat', v_row.lat, 'lng', v_row.lng, 'coverage_radius_meters', v_row.coverage_radius_meters,
    'is_active', v_row.is_active);
end;
$$;

create or replace function public.admin_update_station(
  p_id uuid, p_name text default null, p_lat double precision default null,
  p_lng double precision default null, p_radius numeric default null,
  p_address text default null, p_phone text default null, p_is_active boolean default null)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_row public.police_stations;
begin
  -- Moving a station means moving its whole coverage circle, so a half-supplied
  -- coordinate is always a mistake.
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'latitude and longitude must be supplied together' using errcode = '22023';
  end if;
  if p_lat is not null then perform public.validate_coords(p_lat, p_lng); end if;

  update public.police_stations
     set name = coalesce(p_name, name),
         location = case when p_lat is null then location
                         else extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography end,
         coverage_radius_meters = coalesce(p_radius, coverage_radius_meters),
         address = coalesce(p_address, address),
         phone = coalesce(p_phone, phone),
         is_active = coalesce(p_is_active, is_active)
   where id = p_id
  returning * into v_row;

  if v_row.id is null then raise exception 'no such station' using errcode = 'P0002'; end if;

  return jsonb_build_object('id', v_row.id, 'station_code', v_row.station_code, 'name', v_row.name,
    'lat', v_row.lat, 'lng', v_row.lng, 'coverage_radius_meters', v_row.coverage_radius_meters,
    'is_active', v_row.is_active);
end;
$$;

revoke all on function public.admin_create_station(text, double precision, double precision, numeric, text, text) from public, anon, authenticated;
revoke all on function public.admin_update_station(uuid, text, double precision, double precision, numeric, text, text, boolean) from public, anon, authenticated;
