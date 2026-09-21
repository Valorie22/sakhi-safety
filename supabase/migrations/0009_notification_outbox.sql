-- 0009_notification_outbox.sql
-- The notifications table doubles as a delivery outbox.
--
-- State changes write their notification rows inside the same transaction that
-- changed the emergency. A worker drains them afterwards. If the process that
-- caused the change dies mid-flight, the rows survive and the next drain picks
-- them up - a dropped push never means a lost alert record.

alter table public.notifications
  add column if not exists pushed_at     timestamptz,
  add column if not exists push_attempts integer not null default 0,
  add column if not exists push_error    text;

create index if not exists notifications_outbox_idx
  on public.notifications (created_at)
  where pushed_at is null and push_attempts < 5;

-- SKIP LOCKED lets several API instances drain concurrently without ever
-- pushing the same row twice.
create or replace function public.claim_unpushed_notifications(p_limit integer default 50)
returns table (
  id uuid, recipient_id uuid, recipient_station_id uuid, emergency_id uuid,
  type public.notification_type, title text, body text, payload jsonb
)
language plpgsql security definer set search_path = public, extensions
as $$
begin
  return query
  with picked as (
    select n.id
      from public.notifications n
     where n.pushed_at is null
       and n.push_attempts < 5
     order by n.created_at
     limit p_limit
     for update skip locked
  )
  update public.notifications n
     set push_attempts = n.push_attempts + 1
    from picked
   where n.id = picked.id
  returning n.id, n.recipient_id, n.recipient_station_id, n.emergency_id,
            n.type, n.title, n.body, n.payload;
end;
$$;

-- Expands a station-addressed notification into the devices of every active
-- officer at that station.
create or replace function public.push_targets_for_notification(p_notification_id uuid)
returns table (profile_id uuid, push_token text)
language sql stable security definer set search_path = public, extensions
as $$
  select p.id, p.push_token
    from public.notifications n
    join public.profiles p
      on (n.recipient_id is not null and p.id = n.recipient_id)
      or (n.recipient_station_id is not null
          and p.id in (select o.id from public.police_officers o
                        where o.station_id = n.recipient_station_id and o.is_active))
   where n.id = p_notification_id
     and p.push_token is not null;
$$;

create or replace function public.mark_notification_pushed(p_id uuid, p_error text default null)
returns void language sql security definer set search_path = public, extensions
as $$
  update public.notifications
     set pushed_at  = case when p_error is null then now() else pushed_at end,
         push_error = p_error
   where id = p_id;
$$;

revoke all on function public.claim_unpushed_notifications(integer) from public, anon, authenticated;
revoke all on function public.push_targets_for_notification(uuid) from public, anon, authenticated;
revoke all on function public.mark_notification_pushed(uuid, text) from public, anon, authenticated;
