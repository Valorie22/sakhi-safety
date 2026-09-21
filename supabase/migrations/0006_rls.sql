-- 0006_rls.sql
-- Row Level Security. This is the enforced boundary; the API's role checks are
-- defence in depth on top of it, not a substitute for it.
--
-- Rule of thumb applied throughout: clients may READ what they are authorised
-- to see, and may WRITE almost nothing directly. Mutations that carry business
-- rules (dispatch, claiming, escalation) go through the API's service role,
-- which bypasses RLS and re-checks authorisation itself.

alter table public.profiles            enable row level security;
alter table public.user_settings       enable row level security;
alter table public.emergency_contacts  enable row level security;
alter table public.police_stations     enable row level security;
alter table public.police_officers     enable row level security;
alter table public.emergencies         enable row level security;
alter table public.emergency_stations  enable row level security;
alter table public.emergency_locations enable row level security;
alter table public.emergency_audio     enable row level security;
alter table public.emergency_timeline  enable row level security;
alter table public.notifications       enable row level security;
alter table public.admin_audit_log     enable row level security;
alter table public.evidence_access_log enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
--
-- There is deliberately NO "any authenticated user may read any profile"
-- policy: that is an email-enumeration oracle. Contact search by exact email
-- runs through the API, which rate limits it and returns one row at most.
-- ---------------------------------------------------------------------------

create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

-- People you already have a contact edge with, in either direction, so that
-- pending requests and accepted circles can render names.
create policy profiles_select_contacts on public.profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.emergency_contacts c
       where (c.owner_id = auth.uid()   and c.contact_id = profiles.id)
          or (c.contact_id = auth.uid() and c.owner_id   = profiles.id)
    )
  );

-- Officers may read the profile of anyone who triggered an emergency routed to
-- their station.
create policy profiles_select_for_officer on public.profiles
  for select to authenticated
  using (
    public.my_station_id() is not null
    and exists (
      select 1
        from public.emergencies e
        join public.emergency_stations es on es.emergency_id = e.id
       where e.user_id = profiles.id
         and es.station_id = public.my_station_id()
    )
  );

-- The reverse: a user and their family may read the profile of the officer who
-- took the case, so the app can show "Assigned: <name>".
create policy profiles_select_assigned_officer on public.profiles
  for select to authenticated
  using (
    exists (
      select 1 from public.emergencies e
       where e.claimed_by_officer_id = profiles.id
         and public.can_view_emergency(e.id)
    )
  );

create policy profiles_select_admin on public.profiles
  for select to authenticated using (public.is_admin());

-- A user edits their own profile, but may never change their own role.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_role_name());

-- ---------------------------------------------------------------------------
-- user_settings
-- ---------------------------------------------------------------------------

create policy user_settings_all_self on public.user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- emergency_contacts
-- ---------------------------------------------------------------------------

create policy contacts_select_either_side on public.emergency_contacts
  for select to authenticated
  using (owner_id = auth.uid() or contact_id = auth.uid());

-- You may only ever create a request in your own name.
create policy contacts_insert_as_owner on public.emergency_contacts
  for insert to authenticated
  with check (owner_id = auth.uid() and status = 'pending');

-- The owner may withdraw/remove; the contact may accept or decline.
create policy contacts_update_owner on public.emergency_contacts
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and status in ('removed', 'pending'));

create policy contacts_update_contact on public.emergency_contacts
  for update to authenticated
  using (contact_id = auth.uid())
  with check (contact_id = auth.uid() and status in ('accepted', 'declined', 'removed'));

create policy contacts_delete_owner on public.emergency_contacts
  for delete to authenticated
  using (owner_id = auth.uid());

-- ---------------------------------------------------------------------------
-- police_stations / police_officers - admin writes only.
-- ---------------------------------------------------------------------------

-- Station directory is not sensitive; the app shows which station was
-- dispatched. Coverage radius is included, which is fine - it is public safety
-- infrastructure, not a secret.
create policy stations_select_authenticated on public.police_stations
  for select to authenticated using (true);

create policy stations_admin_write on public.police_stations
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy officers_select_same_station on public.police_officers
  for select to authenticated
  using (station_id = public.my_station_id());

create policy officers_select_assigned on public.police_officers
  for select to authenticated
  using (
    exists (
      select 1 from public.emergencies e
       where e.claimed_by_officer_id = police_officers.id
         and public.can_view_emergency(e.id)
    )
  );

create policy officers_admin_write on public.police_officers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- emergencies and everything scoped to one
-- ---------------------------------------------------------------------------

create policy emergencies_select_authorised on public.emergencies
  for select to authenticated
  using (public.can_view_emergency(id));

-- Creation goes through the API (radius dispatch + notification fan-out are
-- not the client's business). No client INSERT/UPDATE policy exists.

create policy emergency_stations_select on public.emergency_stations
  for select to authenticated
  using (public.can_view_emergency(emergency_id));

create policy emergency_locations_select on public.emergency_locations
  for select to authenticated
  using (public.can_view_emergency(emergency_id));

-- The person in danger may push their own pings straight to Postgres, so the
-- live track keeps flowing even if the API tier is having a bad day. The
-- database still refuses pings for a closed incident.
create policy emergency_locations_insert_own on public.emergency_locations
  for insert to authenticated
  with check (
    exists (
      select 1 from public.emergencies e
       where e.id = emergency_locations.emergency_id
         and e.user_id = auth.uid()
         and e.status in ('active', 'claimed', 'responding', 'on_scene')
    )
  );

create policy emergency_audio_select on public.emergency_audio
  for select to authenticated
  using (
    exists (
      select 1 from public.emergencies e
       where e.id = emergency_audio.emergency_id
         and (
           e.user_id = auth.uid()
           or exists (
                select 1 from public.emergency_stations es
                 where es.emergency_id = e.id
                   and es.station_id = public.my_station_id()
              )
         )
    )
  );

-- Note: audio metadata is visible to the owner and to officers at a notified
-- station, but NOT to family. Ambient recordings of someone's worst moment are
-- evidence, not a family feed.

create policy emergency_timeline_select on public.emergency_timeline
  for select to authenticated
  using (public.can_view_emergency(emergency_id));

-- No insert/update/delete policy on emergency_timeline for any client role.
-- It is written by SECURITY DEFINER functions only, and the immutability
-- trigger rejects UPDATE/DELETE regardless of who issues it.

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------

create policy notifications_select_own on public.notifications
  for select to authenticated
  using (
    recipient_id = auth.uid()
    or (recipient_station_id is not null and recipient_station_id = public.my_station_id())
  );

-- Marking as read is the only client write.
create policy notifications_update_read on public.notifications
  for update to authenticated
  using (
    recipient_id = auth.uid()
    or (recipient_station_id is not null and recipient_station_id = public.my_station_id())
  )
  with check (
    recipient_id = auth.uid()
    or (recipient_station_id is not null and recipient_station_id = public.my_station_id())
  );

-- ---------------------------------------------------------------------------
-- Audit tables - admin reads, service-role writes.
-- ---------------------------------------------------------------------------

create policy admin_audit_select on public.admin_audit_log
  for select to authenticated using (public.is_admin());

create policy evidence_access_select on public.evidence_access_log
  for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Function grants. RPCs the client is allowed to call directly; everything
-- else is reachable only through the API's service role.
-- ---------------------------------------------------------------------------

revoke all on function public.trigger_emergency(uuid, uuid, public.trigger_type, integer, double precision, double precision, numeric, text) from public, anon, authenticated;
revoke all on function public.claim_emergency(uuid, uuid) from public, anon, authenticated;
revoke all on function public.advance_emergency_status(uuid, uuid, public.emergency_status, text) from public, anon, authenticated;
revoke all on function public.escalate_emergency(uuid, integer, uuid, boolean) from public, anon, authenticated;
revoke all on function public.cancel_emergency(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_location(uuid, uuid, double precision, double precision, numeric, numeric, numeric, timestamptz) from public, anon, authenticated;
revoke all on function public.auto_escalate_stale_emergencies() from public, anon, authenticated;

-- Safe for clients: read-only, and useful for showing coverage on a map.
grant execute on function public.stations_covering(double precision, double precision) to authenticated;
grant execute on function public.can_view_emergency(uuid) to authenticated;
grant execute on function public.my_station_id() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_accepted_contact_of(uuid) to authenticated;
grant execute on function public.current_role_name() to authenticated;
grant execute on function public.config_int(text, integer) to authenticated;
