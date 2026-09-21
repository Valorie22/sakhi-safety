-- 0014_timeline_allows_cascade_delete_only.sql
--
-- The append-only trigger blocked DELETE unconditionally, including the cascade
-- that fires when the parent emergency is removed. Deleting an emergency - or a
-- user, which cascades to their emergencies - therefore failed. An audit log
-- nobody can ever erase sounds right until it means a person cannot exercise a
-- deletion request.
--
-- The distinction that matters is not "delete vs not", it is "rewriting history
-- vs removing the whole incident":
--
--   UPDATE            always refused. History is never edited, by anyone.
--   DELETE, bare      refused. You cannot quietly drop one inconvenient event
--                     from an incident that still exists.
--   DELETE, cascade   allowed. The parent emergency is already gone, so the
--                     whole incident is being removed together, not edited.
--
-- Postgres deletes the parent row before the referential-action trigger fires
-- the child delete, so "does the parent still exist?" cleanly separates them.

create or replace function public.forbid_timeline_mutation()
returns trigger language plpgsql
set search_path = public, extensions
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'emergency_timeline is append-only (attempted UPDATE)'
      using errcode = 'P0001';
  end if;

  -- tg_op = 'DELETE'
  if exists (select 1 from public.emergencies e where e.id = old.emergency_id) then
    raise exception 'emergency_timeline is append-only (attempted DELETE while the emergency still exists)'
      using errcode = 'P0001';
  end if;

  -- Parent is already gone: this is the cascade. Let the incident go as a whole.
  return old;
end;
$$;
