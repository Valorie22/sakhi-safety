-- 0007_realtime_and_storage.sql
-- Realtime publication and the private evidence bucket.

-- ---------------------------------------------------------------------------
-- Realtime
--
-- Supabase Realtime evaluates the subscriber's own JWT against the table's RLS
-- policies before delivering a postgres_changes payload, so adding a table here
-- does not widen access: an officer at STN-1001 simply never receives rows for
-- an emergency that was not routed to their station.
--
-- REPLICA IDENTITY FULL is needed so DELETE/UPDATE payloads carry the columns
-- the policies filter on.
-- ---------------------------------------------------------------------------

alter table public.emergencies         replica identity full;
alter table public.emergency_stations  replica identity full;
alter table public.emergency_locations replica identity full;
alter table public.emergency_timeline  replica identity full;
alter table public.emergency_audio     replica identity full;
alter table public.notifications       replica identity full;
alter table public.emergency_contacts  replica identity full;

alter publication supabase_realtime add table public.emergencies;
alter publication supabase_realtime add table public.emergency_stations;
alter publication supabase_realtime add table public.emergency_locations;
alter publication supabase_realtime add table public.emergency_timeline;
alter publication supabase_realtime add table public.emergency_audio;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.emergency_contacts;

-- ---------------------------------------------------------------------------
-- Storage: private audio evidence bucket.
--
-- public = false, so there is no URL that reads an object without a signature.
-- Signed URLs are minted by the API only after it has verified the requester is
-- the reporter or an officer at a station this emergency was dispatched to, and
-- every issue is written to evidence_access_log.
--
-- Object key layout: <emergency_id>/<segment_index>-<uuid>.m4a
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'emergency-audio',
  'emergency-audio',
  false,
  52428800, -- 50 MB per segment
  array['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/webm']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- The reporter may upload segments for their own still-open emergency. The
-- first path segment is the emergency id.
drop policy if exists "emergency audio upload by reporter" on storage.objects;
create policy "emergency audio upload by reporter" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'emergency-audio'
    and exists (
      select 1 from public.emergencies e
       where e.id::text = (storage.foldername(name))[1]
         and e.user_id = auth.uid()
         and e.status in ('active', 'claimed', 'responding', 'on_scene')
    )
  );

-- Direct reads are limited to the reporter. Officers do NOT get a blanket read
-- policy: they go through the API, which authorises and logs each access and
-- hands back a short-lived signed URL.
drop policy if exists "emergency audio read by reporter" on storage.objects;
create policy "emergency audio read by reporter" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'emergency-audio'
    and exists (
      select 1 from public.emergencies e
       where e.id::text = (storage.foldername(name))[1]
         and e.user_id = auth.uid()
    )
  );

-- Nobody deletes evidence through the client.
