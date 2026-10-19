-- ============================================================================
-- Supabase schema for the extension's cloud sync — the generic "blob" model.
--
-- Identity model
-- --------------
-- The extension keeps its OWN Google sign-in (server/, see src/lib/cloud.js)
-- and reaches Supabase with the project's public anon key. There is no Supabase
-- Auth session on the extension side, so there is no `auth.uid()` to scope rows
-- by. Every row is therefore keyed on the signed-in user's EMAIL (lowercased),
-- and — because RLS cannot see that email — the policies below are permissive:
-- the anon key may read and write any row.
--
-- That is the deliberate, documented trade-off of this design: the anon key is
-- the sync credential, so treat it as a secret and do not share the project.
--
-- Data model
-- ----------
--   user_data     one JSON blob per (user, kind). Kinds:
--                 profile | settings | resume_pdf | resume_tex.
--   applications  one JSON blob per tracked job.
--
-- `data` holds the exact JSON the extension keeps in chrome.storage.local, so a
-- pull can write it back verbatim. `updated_at` is epoch milliseconds, the same
-- clock chrome.storage already uses.
--
-- This file REPLACES the earlier flat schema (profiles / resumes / emails /
-- user_settings and a differently-shaped applications). Those tables are
-- dropped below. Any data they held is discarded, and that flat schema's site
-- (autofill-web) and its /api/extension/* routes are no longer compatible.
--
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Drop the superseded flat schema.
--
-- `applications` collides by name with the blob table created below, so it has
-- to go either way. profiles / resumes / emails / user_settings go with it.
-- api_tokens is left alone: it belongs to the server's own access-token path,
-- not to this sync.
-- ---------------------------------------------------------------------------
drop table if exists public.applications cascade;
drop table if exists public.profiles cascade;
drop table if exists public.resumes cascade;
drop table if exists public.emails cascade;
drop table if exists public.user_settings cascade;
drop table if exists public.emails_imported cascade;

-- The flat bootstrap trigger inserts into profiles / resumes / user_settings,
-- so it must not fire once those are gone.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.sync_apply(uuid, jsonb, jsonb);

-- ---------------------------------------------------------------------------
-- user_data — one blob per (user, kind).
-- ---------------------------------------------------------------------------
create table public.user_data (
  user_id    text not null,                 -- lowercased sign-in email
  kind       text not null,                 -- profile | settings | resume_pdf | resume_tex
  data       jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0,     -- epoch ms
  primary key (user_id, kind)
);

create index user_data_user_idx on public.user_data (user_id);

-- ---------------------------------------------------------------------------
-- applications — one blob per tracked job.
-- ---------------------------------------------------------------------------
create table public.applications (
  user_id    text not null,                 -- lowercased sign-in email
  id         text not null,                 -- client-side id
  data       jsonb not null default '{}'::jsonb,   -- the camelCase tracker row
  updated_at bigint not null default 0,     -- epoch ms
  primary key (user_id, id)
);

create index applications_user_updated_idx on public.applications (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- See the header: with no Supabase Auth session there is nothing to key a
-- policy on, so these policies allow the anon (and authenticated) role full
-- access. The extension scopes its own reads and writes by user_id; the RLS
-- here only exists so the tables are not accidentally left wide open via a
-- missing-policy default.
-- ---------------------------------------------------------------------------
alter table public.user_data    enable row level security;
alter table public.applications enable row level security;

drop policy if exists "user_data anon all" on public.user_data;
create policy "user_data anon all" on public.user_data
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "applications anon all" on public.applications;
create policy "applications anon all" on public.applications
  for all to anon, authenticated using (true) with check (true);

-- Refresh PostgREST's schema cache so the new tables are visible at once.
notify pgrst, 'reload schema';
