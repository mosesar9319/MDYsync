-- Rollback for 20260913150000_scan_events_logging.sql.
--
-- Pure diagnostic log with no upstream data and nothing else referencing it
-- (no foreign keys point at it, no trigger touches another table) -- dropping
-- it just loses scan history, which was never anything more than a log.
--
-- Safe to run more than once.

drop table if exists public.scan_events;
