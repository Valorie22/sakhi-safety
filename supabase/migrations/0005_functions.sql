-- 0005_functions.sql
-- Business logic that must be transactional, atomic, or trusted:
-- radius dispatch, emergency creation, the atomic case claim, status
-- progression, escalation, and the predicates RLS is built on.

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

create or replace function public.config_int(p_key text, p_default integer default 0)
returns integer
language sql stable
security definer
set search_path = public, extensions
as $$
  select coalesce((select (value #>> '{}')::integer from public.system_config where key = p_key), p_default);
$$;

create or replace function public.validate_coords(p_lat double precision, p_lng double precision)
returns void
language plpgsql immutable
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

-- ---------------------------------------------------------------------------
-- RLS predicates. All SECURITY DEFINER + STABLE so policies can call them
-- without recursing back through the policies on the tables they read.
-- ---------------------------------------------------------------------------

create or replace function public.current_role_name()
returns public.user_role
language sql stable security definer
set search_path = public, extensions
as $$ select role from public.profiles where id = auth.uid(); $$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public, extensions
as $$ select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'); $$;

create or replace function public.my_station_id()
returns uuid
language sql stable security definer
set search_path = public, extensions
as $$
  select o.station_id
    from public.police_officers o
   where o.id = auth.uid() and o.is_active;
$$;

-- Is the signed-in user an accepted emergency contact of p_owner?
create or replace function public.is_accepted_contact_of(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.emergency_contacts c
     where c.owner_id = p_owner
       and c.contact_id = auth.uid()
       and c.status = 'accepted'
  );
$$;

-- The single gate every emergency-scoped table reuses.
create or replace function public.can_view_emergency(p_emergency_id uuid)
returns boolean
language sql stable security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from public.emergencies e
     where e.id = p_emergency_id
       and (
            -- the person who triggered it
            e.user_id = auth.uid()
            -- an accepted trusted contact of that person
            or public.is_accepted_contact_of(e.user_id)
            -- an active officer at a station this emergency was routed to
            or exists (
                 select 1
                   from public.emergency_stations es
                  where es.emergency_id = e.id
                    and es.station_id = public.my_station_id()
               )
           )
  );
$$;

-- ---------------------------------------------------------------------------
-- Radius dispatch. Returns EVERY active station whose coverage circle contains
-- the point, not just the nearest one - coverage areas are expected to overlap.
-- ---------------------------------------------------------------------------

create or replace function public.stations_covering(
  p_lat double precision,
  p_lng double precision
)
returns table (
  station_id   uuid,
  station_code text,
  name         text,
  distance_m   double precision
)
language sql stable
security definer
set search_path = public, extensions
as $$
  select s.id,
         s.station_code,
         s.name,
         extensions.ST_Distance(s.location, extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography) as distance_m
    from public.police_stations s
   where s.is_active
     -- ST_DWithin on geography uses the GiST index on s.location.
     and extensions.ST_DWithin(
           s.location,
           extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography,
           s.coverage_radius_meters
         )
   order by distance_m asc;
$$;

-- ---------------------------------------------------------------------------
-- trigger_emergency: the whole SOS fan-out in one transaction.
--
-- Idempotent on p_client_request_id: a retried request (flaky network, app
-- resumed from background) returns the original emergency instead of creating
-- a second one.
-- ---------------------------------------------------------------------------

create or replace function public.trigger_emergency(
  p_user_id           uuid,
  p_client_request_id uuid,
  p_trigger_type      public.trigger_type,
  p_level             integer,
  p_lat               double precision,
  p_lng               double precision,
  p_accuracy          numeric default null,
  p_address_hint      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_emergency   public.emergencies;
  v_point       extensions.geography(Point, 4326);
  v_level       integer := greatest(1, least(3, coalesce(p_level, 1)));
  v_station     record;
  v_contact     record;
  v_station_ids uuid[] := '{}';
  v_codes       text[] := '{}';
  v_family      integer := 0;
begin
  perform public.validate_coords(p_lat, p_lng);

  if p_client_request_id is null then
    raise exception 'client_request_id is required for idempotency' using errcode = '22023';
  end if;

  v_point := extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography;

  insert into public.emergencies (
    client_request_id, user_id, trigger_type, level,
    created_location, created_accuracy_m, address_hint
  )
  values (
    p_client_request_id, p_user_id, p_trigger_type, v_level,
    v_point, p_accuracy, p_address_hint
  )
  on conflict (client_request_id) do nothing
  returning * into v_emergency;

  -- Lost the insert => this is a retry of a request we already handled.
  if v_emergency.id is null then
    select * into v_emergency
      from public.emergencies
     where client_request_id = p_client_request_id;

    return jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'emergency_id', v_emergency.id,
      'emergency_code', v_emergency.emergency_code,
      'level', v_emergency.level,
      'status', v_emergency.status
    );
  end if;

  -- 1. The trigger itself.
  insert into public.emergency_timeline (emergency_id, event_type, event_data, actor_id)
  values (
    v_emergency.id, 'sos_triggered',
    jsonb_build_object(
      'trigger_type', p_trigger_type,
      'level', v_level,
      'accuracy_m', p_accuracy
    ),
    p_user_id
  );

  -- 2. First location ping, so the track is never empty.
  insert into public.emergency_locations (emergency_id, location, accuracy_meters)
  values (v_emergency.id, v_point, p_accuracy);

  -- 3. Radius dispatch to every covering station.
  for v_station in select * from public.stations_covering(p_lat, p_lng) loop
    insert into public.emergency_stations (emergency_id, station_id, distance_m)
    values (v_emergency.id, v_station.station_id, v_station.distance_m)
    on conflict do nothing;

    v_station_ids := v_station_ids || v_station.station_id;
    v_codes       := v_codes || v_station.station_code;

    insert into public.emergency_timeline (emergency_id, event_type, event_data)
    values (
      v_emergency.id, 'station_notified',
      jsonb_build_object(
        'station_id', v_station.station_id,
        'station_code', v_station.station_code,
        'distance_m', round(v_station.distance_m::numeric)
      )
    );

    -- Deliberately generic: this may land on a lock screen.
    insert into public.notifications (
      recipient_station_id, emergency_id, type, title, body, payload, dedupe_key
    )
    values (
      v_station.station_id, v_emergency.id, 'station_notified',
      'New Level ' || v_level || ' emergency',
      v_emergency.emergency_code || ' - ' || v_station.station_code,
      jsonb_build_object(
        'emergency_id', v_emergency.id,
        'emergency_code', v_emergency.emergency_code,
        'level', v_level
      ),
      'station_notified:' || v_emergency.id
    )
    on conflict do nothing;
  end loop;

  if array_length(v_station_ids, 1) is null then
    -- Honest record: nobody covers this point. The app surfaces this too.
    insert into public.emergency_timeline (emergency_id, event_type, event_data)
    values (v_emergency.id, 'station_notified',
            jsonb_build_object('matched', 0, 'note', 'no active station covers this location'));
  end if;

  -- 4. Accepted trusted contacts only.
  for v_contact in
    select c.contact_id
      from public.emergency_contacts c
     where c.owner_id = p_user_id and c.status = 'accepted'
  loop
    insert into public.notifications (
      recipient_id, emergency_id, type, title, body, payload, dedupe_key
    )
    values (
      v_contact.contact_id, v_emergency.id, 'emergency_triggered',
      'Emergency alert',
      'Someone on your safety circle triggered a Level ' || v_level || ' alert.',
      jsonb_build_object(
        'emergency_id', v_emergency.id,
        'emergency_code', v_emergency.emergency_code,
        'level', v_level
      ),
      'emergency_triggered:' || v_emergency.id
    )
    on conflict do nothing;
    v_family := v_family + 1;
  end loop;

  insert into public.emergency_timeline (emergency_id, event_type, event_data)
  values (v_emergency.id, 'family_notified', jsonb_build_object('count', v_family));

  -- 5. Confirm back to the person in danger.
  insert into public.notifications (
    recipient_id, emergency_id, type, title, body, payload, dedupe_key
  )
  values (
    p_user_id, v_emergency.id, 'station_notified',
    'Help is being dispatched',
    coalesce(array_length(v_station_ids, 1), 0) || ' station(s) and ' || v_family || ' contact(s) notified.',
    jsonb_build_object(
      'emergency_id', v_emergency.id,
      'stations', coalesce(array_length(v_station_ids, 1), 0),
      'contacts', v_family
    ),
    'user_dispatch_confirm:' || v_emergency.id
  )
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'emergency_id', v_emergency.id,
    'emergency_code', v_emergency.emergency_code,
    'level', v_emergency.level,
    'status', v_emergency.status,
    'created_at', v_emergency.created_at,
    'stations_notified', coalesce(array_length(v_station_ids, 1), 0),
    'station_codes', to_jsonb(v_codes),
    'contacts_notified', v_family
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_emergency: THE correctness requirement.
--
-- The claim is one conditional UPDATE guarded by `claimed_by_officer_id is
-- null`. Two officers racing on the same row serialise on the row lock; the
-- loser re-evaluates the predicate against the winner's committed version,
-- matches zero rows, and is told who won. There is no check-then-write window
-- for the race to live in.
-- ---------------------------------------------------------------------------

create or replace function public.claim_emergency(
  p_emergency_id uuid,
  p_officer_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_officer  public.police_officers;
  v_claimed  public.emergencies;
  v_current  record;
begin
  select * into v_officer
    from public.police_officers
   where id = p_officer_id and is_active;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_an_active_officer');
  end if;

  -- An officer may only claim work routed to their own station.
  if not exists (
    select 1 from public.emergency_stations
     where emergency_id = p_emergency_id and station_id = v_officer.station_id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_routed_to_your_station');
  end if;

  update public.emergencies
     set claimed_by_officer_id = p_officer_id,
         status                = 'claimed',
         claimed_at            = now()
   where id                    = p_emergency_id
     and claimed_by_officer_id is null
     and status                = 'active'
  returning * into v_claimed;

  if v_claimed.id is null then
    select e.status,
           e.claimed_by_officer_id,
           p.full_name as officer_name,
           o.badge_number,
           s.station_code
      into v_current
      from public.emergencies e
      left join public.police_officers o on o.id = e.claimed_by_officer_id
      left join public.profiles        p on p.id = e.claimed_by_officer_id
      left join public.police_stations s on s.id = o.station_id
     where e.id = p_emergency_id;

    if v_current is null then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;

    if v_current.claimed_by_officer_id is not null then
      return jsonb_build_object(
        'ok', false,
        'reason', 'already_claimed',
        'claimed_by_officer_id', v_current.claimed_by_officer_id,
        'officer_name', v_current.officer_name,
        'badge_number', v_current.badge_number,
        'station_code', v_current.station_code
      );
    end if;

    -- Unclaimed but not 'active' => already resolved or cancelled.
    return jsonb_build_object('ok', false, 'reason', 'not_claimable',
                              'status', v_current.status);
  end if;

  insert into public.emergency_timeline (emergency_id, event_type, event_data, actor_id)
  values (
    p_emergency_id, 'case_claimed',
    jsonb_build_object(
      'officer_id', p_officer_id,
      'badge_number', v_officer.badge_number,
      'station_id', v_officer.station_id
    ),
    p_officer_id
  );

  insert into public.notifications (recipient_id, emergency_id, type, title, body, payload, dedupe_key)
  select target, p_emergency_id, 'officer_assigned',
         'An officer is assigned',
         'Case ' || v_claimed.emergency_code || ' has been picked up.',
         jsonb_build_object('emergency_id', p_emergency_id, 'officer_id', p_officer_id),
         'officer_assigned:' || p_emergency_id
    from (
      select v_claimed.user_id as target
      union
      select c.contact_id from public.emergency_contacts c
       where c.owner_id = v_claimed.user_id and c.status = 'accepted'
    ) recipients
  on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'emergency_id', p_emergency_id,
    'emergency_code', v_claimed.emergency_code,
    'status', v_claimed.status,
    'claimed_at', v_claimed.claimed_at,
    'officer_id', p_officer_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- advance_emergency_status: claimed -> responding -> on_scene -> resolved.
-- Only the owning officer may move a claimed case.
-- ---------------------------------------------------------------------------

create or replace function public.advance_emergency_status(
  p_emergency_id uuid,
  p_officer_id   uuid,
  p_new_status   public.emergency_status,
  p_note         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_e       public.emergencies;
  v_allowed public.emergency_status[];
begin
  select * into v_e from public.emergencies where id = p_emergency_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_e.claimed_by_officer_id is distinct from p_officer_id then
    return jsonb_build_object('ok', false, 'reason', 'not_your_case');
  end if;

  v_allowed := case v_e.status
    when 'claimed'    then array['responding', 'on_scene', 'resolved']::public.emergency_status[]
    when 'responding' then array['on_scene', 'resolved']::public.emergency_status[]
    when 'on_scene'   then array['resolved']::public.emergency_status[]
    else array[]::public.emergency_status[]
  end;

  if not (p_new_status = any (v_allowed)) then
    return jsonb_build_object('ok', false, 'reason', 'illegal_transition',
                              'from', v_e.status, 'to', p_new_status);
  end if;

  update public.emergencies
     set status          = p_new_status,
         responding_at   = case when p_new_status = 'responding' then now() else responding_at end,
         on_scene_at     = case when p_new_status = 'on_scene'   then now() else on_scene_at end,
         resolved_at     = case when p_new_status = 'resolved'   then now() else resolved_at end,
         resolution_note = case when p_new_status = 'resolved'   then p_note else resolution_note end
   where id = p_emergency_id
   returning * into v_e;

  insert into public.emergency_timeline (emergency_id, event_type, event_data, actor_id)
  values (
    p_emergency_id,
    case when p_new_status = 'resolved' then 'resolved'::public.timeline_event_type
         else 'status_changed'::public.timeline_event_type end,
    jsonb_build_object('to', p_new_status, 'officer_id', p_officer_id, 'note', p_note),
    p_officer_id
  );

  -- Recording stops when the incident closes.
  if p_new_status = 'resolved' then
    update public.emergency_audio
       set status = 'uploaded', ended_at = coalesce(ended_at, now())
     where emergency_id = p_emergency_id and status = 'recording';
  end if;

  insert into public.notifications (recipient_id, emergency_id, type, title, body, payload, dedupe_key)
  select target, p_emergency_id,
         case p_new_status
           when 'responding' then 'officer_responding'::public.notification_type
           when 'on_scene'   then 'officer_on_scene'::public.notification_type
           else 'emergency_resolved'::public.notification_type
         end,
         case p_new_status
           when 'responding' then 'Officer responding'
           when 'on_scene'   then 'Officer on scene'
           else 'Emergency resolved'
         end,
         'Case ' || v_e.emergency_code || ' is now ' || replace(p_new_status::text, '_', ' ') || '.',
         jsonb_build_object('emergency_id', p_emergency_id, 'status', p_new_status),
         'status_changed:' || p_new_status || ':' || p_emergency_id
    from (
      select v_e.user_id as target
      union
      select c.contact_id from public.emergency_contacts c
       where c.owner_id = v_e.user_id and c.status = 'accepted'
    ) recipients
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'emergency_id', p_emergency_id, 'status', p_new_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- cancel_emergency: the person who triggered it stands down.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_emergency(
  p_emergency_id uuid,
  p_user_id      uuid,
  p_reason       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_e public.emergencies;
begin
  update public.emergencies
     set status        = 'cancelled',
         cancelled_at  = now(),
         cancel_reason = p_reason
   where id = p_emergency_id
     and user_id = p_user_id
     and status in ('active', 'claimed', 'responding', 'on_scene')
  returning * into v_e;

  if v_e.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_cancellable');
  end if;

  update public.emergency_audio
     set status = 'uploaded', ended_at = coalesce(ended_at, now())
   where emergency_id = p_emergency_id and status = 'recording';

  insert into public.emergency_timeline (emergency_id, event_type, event_data, actor_id)
  values (p_emergency_id, 'cancelled', jsonb_build_object('reason', p_reason), p_user_id);

  -- Tell the stations that were dispatched, and the family that was alarmed.
  insert into public.notifications (recipient_station_id, emergency_id, type, title, body, payload, dedupe_key)
  select es.station_id, p_emergency_id, 'emergency_cancelled',
         'Emergency cancelled',
         'Case ' || v_e.emergency_code || ' was cancelled by the reporter.',
         jsonb_build_object('emergency_id', p_emergency_id),
         'emergency_cancelled:' || p_emergency_id
    from public.emergency_stations es
   where es.emergency_id = p_emergency_id
  on conflict do nothing;

  insert into public.notifications (recipient_id, emergency_id, type, title, body, payload, dedupe_key)
  select c.contact_id, p_emergency_id, 'emergency_cancelled',
         'Emergency cancelled',
         'The alert you were notified about was cancelled.',
         jsonb_build_object('emergency_id', p_emergency_id),
         'emergency_cancelled:' || p_emergency_id
    from public.emergency_contacts c
   where c.owner_id = v_e.user_id and c.status = 'accepted'
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'emergency_id', p_emergency_id, 'status', 'cancelled');
end;
$$;

-- ---------------------------------------------------------------------------
-- escalate_emergency: raises level in place. Never creates a second incident.
-- ---------------------------------------------------------------------------

create or replace function public.escalate_emergency(
  p_emergency_id uuid,
  p_new_level    integer,
  p_actor_id     uuid default null,
  p_automatic    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_e   public.emergencies;
  v_old integer;
begin
  select * into v_e from public.emergencies where id = p_emergency_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_e.status in ('resolved', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'emergency_closed');
  end if;

  if p_new_level <= v_e.level then
    return jsonb_build_object('ok', false, 'reason', 'not_an_escalation',
                              'current_level', v_e.level);
  end if;

  v_old := v_e.level;

  update public.emergencies
     set level = least(3, p_new_level), escalated_at = now()
   where id = p_emergency_id
  returning * into v_e;

  insert into public.emergency_timeline (emergency_id, event_type, event_data, actor_id)
  values (p_emergency_id, 'level_escalated',
          jsonb_build_object('from', v_old, 'to', v_e.level, 'automatic', p_automatic),
          p_actor_id);

  -- Re-notify the dispatched stations at the new level.
  insert into public.notifications (recipient_station_id, emergency_id, type, title, body, payload, dedupe_key)
  select es.station_id, p_emergency_id, 'level_escalated',
         'Escalated to Level ' || v_e.level,
         'Case ' || v_e.emergency_code || ' is now Level ' || v_e.level || '.',
         jsonb_build_object('emergency_id', p_emergency_id, 'level', v_e.level),
         'level_escalated:' || v_e.level || ':' || p_emergency_id
    from public.emergency_stations es
   where es.emergency_id = p_emergency_id
  on conflict do nothing;

  insert into public.notifications (recipient_id, emergency_id, type, title, body, payload, dedupe_key)
  select target, p_emergency_id, 'level_escalated',
         'Alert escalated to Level ' || v_e.level,
         'The situation was raised to Level ' || v_e.level || '.',
         jsonb_build_object('emergency_id', p_emergency_id, 'level', v_e.level),
         'level_escalated:' || v_e.level || ':' || p_emergency_id
    from (
      select v_e.user_id as target
      union
      select c.contact_id from public.emergency_contacts c
       where c.owner_id = v_e.user_id and c.status = 'accepted'
    ) recipients
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'emergency_id', p_emergency_id,
                            'from', v_old, 'to', v_e.level);
end;
$$;

-- ---------------------------------------------------------------------------
-- record_location: refuses pings once the incident is closed.
-- ---------------------------------------------------------------------------

create or replace function public.record_location(
  p_emergency_id uuid,
  p_user_id      uuid,
  p_lat          double precision,
  p_lng          double precision,
  p_accuracy     numeric default null,
  p_speed        numeric default null,
  p_heading      numeric default null,
  p_recorded_at  timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status public.emergency_status;
begin
  perform public.validate_coords(p_lat, p_lng);

  select status into v_status
    from public.emergencies
   where id = p_emergency_id and user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_status in ('resolved', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'emergency_closed', 'status', v_status);
  end if;

  insert into public.emergency_locations (
    emergency_id, location, accuracy_meters, speed, heading, recorded_at
  )
  values (
    p_emergency_id,
    extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography,
    p_accuracy, p_speed, p_heading, coalesce(p_recorded_at, now())
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- auto_escalate_stale_emergencies: time-based escalation for incidents nobody
-- has picked up. Windows come from system_config, not from constants here.
-- Run from pg_cron (see 0008) or the API's scheduler.
-- ---------------------------------------------------------------------------

create or replace function public.auto_escalate_stale_emergencies()
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row   record;
  v_count integer := 0;
  v_w1    integer := public.config_int('auto_escalate_level_1_seconds', 180);
  v_w2    integer := public.config_int('auto_escalate_level_2_seconds', 300);
begin
  for v_row in
    select id, level
      from public.emergencies
     where status = 'active'
       and claimed_by_officer_id is null
       and (
            (level = 1 and created_at < now() - make_interval(secs => v_w1))
         or (level = 2 and coalesce(escalated_at, created_at) < now() - make_interval(secs => v_w2))
       )
  loop
    perform public.escalate_emergency(v_row.id, v_row.level + 1, null, true);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
