-- 0013_timeline_actor_is_historical.sql
--
-- emergency_timeline.actor_id was `on delete set null`. Deleting a profile
-- therefore issued an UPDATE against a table whose trigger refuses UPDATE, so
-- the delete failed: any account that had ever appeared in a timeline could not
-- be removed. That is a data-deletion problem, not just an inconvenience.
--
-- The two rules were in genuine conflict, and the append-only rule is the one
-- worth keeping: an audit log that rewrites itself when someone is deleted is
-- not an audit log. So actor_id becomes a plain historical uuid with no foreign
-- key - it records who acted at the time, and stays true afterwards.
--
-- Trade-off accepted: actor_id may point at a profile that no longer exists.
-- Readers must treat it as "who this was", not as a live join - which is how
-- the app already renders it.

alter table public.emergency_timeline
  drop constraint emergency_timeline_actor_id_fkey;

comment on column public.emergency_timeline.actor_id is
  'Who performed this action, recorded at the time. Intentionally NOT a foreign key: this log is append-only, so it must not be rewritten when a profile is later deleted. May reference a profile that no longer exists.';

alter table public.evidence_access_log
  drop constraint evidence_access_log_actor_id_fkey;

comment on column public.evidence_access_log.actor_id is
  'Who opened the evidence, recorded at the time. Not a foreign key, so the audit trail survives account deletion.';
