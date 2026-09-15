-- Rollback for 20260915200000_kuntras_builder.sql.
--
-- WHAT IS LOST: every kuntras any reader has built, sections and entries
-- included. Nothing here is ever public in this slice, so there is no
-- public copy anywhere else to recover from; export anything worth keeping
-- (there is no export feature yet either -- that is its own later slice)
-- before running this.
--
-- Order matters: triggers and their functions go before the tables they're
-- attached to; entries and sections (which reference kuntrasim) go before
-- kuntrasim itself, though CASCADE on kuntrasim would take them anyway --
-- dropped explicitly so the order stays correct even if a later migration
-- changes that cascade.
--
-- Safe to run more than once.

drop trigger if exists kuntras_entries_validate_section on public.kuntras_entries;
drop function if exists public.kuntras_validate_entry_section();

drop trigger if exists kuntras_sections_validate_parentage on public.kuntras_sections;
drop function if exists public.kuntras_validate_section_parentage();

drop table if exists public.kuntras_entries;
drop table if exists public.kuntras_sections;
drop table if exists public.kuntrasim;
