-- 0008_auto_escalation_cron.sql
-- Time-based escalation for incidents nobody has picked up.

create extension if not exists pg_cron;

-- One minute is the finest granularity pg_cron offers, comfortably under the
-- 180s / 300s windows held in system_config.
select cron.schedule(
  'auto-escalate-stale-emergencies',
  '* * * * *',
  $$select public.auto_escalate_stale_emergencies();$$
);
