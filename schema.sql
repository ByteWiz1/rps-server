-- rps-server/schema.sql
--
-- RPS Arena — Supabase schema.
--
-- Chat 4: initial schema (users, auth_tokens, player_stats, match_history).
-- Chat 7: achievements (roadmap item #4) — new table + three new
--         player_stats tracking columns used by the achievement rules.
-- Chat 9: Supabase Auth migration (Option A-lite).
--   - New public.profiles table (uuid PK → auth.users.id).
--     Holds username, avatar, is_premium, premium_since. This is the
--     Supabase-side identity record; public.users remains the join
--     target for player_stats / match_history / achievements.
--   - handle_new_user() trigger: auto-creates a profiles row whenever
--     Supabase creates an auth.users row (anonymous or email).
--   - bump_updated_at() trigger: keeps profiles.updated_at fresh.
--   - public.migration_log: audit table for legacy → Supabase UID
--     rewrites so a bad migration is reversible.
--   - RLS policies on profiles: users can read/update their own row.
--     Server uses SERVICE_KEY and bypasses RLS.
--
-- Run this ONCE in the Supabase SQL editor for a fresh project.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere; CREATE OR
-- REPLACE for functions; DROP TRIGGER IF EXISTS before CREATE TRIGGER).
--
-- Persistent state (survives Render redeploys):
--   users          — one row per account (game-data join target).
--                    "userId" is text; for post-Chat-9 users it holds
--                    the Supabase UID as a string. Legacy rows keep
--                    their old 'user_xxx' values until they migrate.
--   auth_tokens    — kept for one release to allow legacy migration.
--                    Do NOT drop yet (see server.js migrateLegacyToken).
--   player_stats   — one row per user, mirrors createEmptyStats().
--   match_history  — append-only, capped at 20 rows per user in app code.
--   achievements   — one row per (user, achievement) unlocked pair.
--   profiles       — Supabase Auth identity: username, avatar, premium.
--   migration_log  — audit trail of legacy → Supabase UID rewrites.
--
-- Ephemeral state (rooms, players, onlinePlayers, activeInvites,
-- recentOpponents) stays in server memory and is NOT in this schema.

-- ──────────────────────────────────────────────────────────────
-- users
-- ──────────────────────────────────────────────────────────────
-- userId is text. Pre-Chat-9 rows hold 'user_' + 24 hex chars.
-- Post-Chat-9 rows hold a Supabase UID (uuid string). Same column,
-- same FKs, same db.js helpers — only the value format changed.
create table if not exists public.users (
  "userId"    text        primary key,
  username    text        not null,
  avatar      text        not null default '🤖',
  "createdAt" bigint      not null,
  "updatedAt" bigint      not null
);

-- Username uniqueness. Usernames are normalized to lowercase in the
-- server before insert/update, so a plain unique index is sufficient.
create unique index if not exists users_username_lower_key
  on public.users (lower(username));

-- ──────────────────────────────────────────────────────────────
-- auth_tokens
-- ──────────────────────────────────────────────────────────────
-- LEGACY. Kept for one release so old clients can migrate via the
-- server's migrateLegacyToken socket event. Once telemetry shows no
-- more lookups, this table can be dropped in a follow-up chat.
create table if not exists public.auth_tokens (
  token         text   primary key,
  "userId"      text   not null references public.users("userId") on delete cascade,
  "createdAt"   bigint not null,
  "lastUsedAt"  bigint not null
);

create index if not exists auth_tokens_user_id_idx
  on public.auth_tokens ("userId");

-- ──────────────────────────────────────────────────────────────
-- player_stats
-- ──────────────────────────────────────────────────────────────
-- 1:1 with users. Column names match createEmptyStats() exactly.
-- ON DELETE CASCADE: deleting a user removes their stats row.
create table if not exists public.player_stats (
  "userId"        text    primary key references public.users("userId") on delete cascade,

  wins            integer not null default 0,
  losses          integer not null default 0,
  ties            integer not null default 0,
  total           integer not null default 0,

  "humanWins"     integer not null default 0,
  "humanLosses"   integer not null default 0,
  "humanTies"     integer not null default 0,

  "avatarWins"    integer not null default 0,
  "avatarLosses"  integer not null default 0,
  "avatarTies"    integer not null default 0,

  "dojoWins"      integer not null default 0,
  "dojoLosses"    integer not null default 0,
  "dojoTies"      integer not null default 0,

  "currentStreak" integer not null default 0,
  "bestStreak"    integer not null default 0
);

-- ──────────────────────────────────────────────────────────────
-- player_stats — Chat 7 tracking columns (roadmap item #4)
-- ──────────────────────────────────────────────────────────────
-- These three feed the achievement rules:
--   opponentsPlayed — unique opponent userIds, for social_5 / social_25
--                     and rematch_king (count of repeated opponents).
--   dailyWinDates   — 'YYYY-MM-DD' strings for each day the player won
--                     at least one match; powers perfect_week.
--   masterWins      — { rookie, tactician, hunter, grandmaster } counters
--                     for the dojo-special achievements.
alter table public.player_stats
  add column if not exists "opponentsPlayed" text[] not null default '{}';

alter table public.player_stats
  add column if not exists "dailyWinDates" text[] not null default '{}';

alter table public.player_stats
  add column if not exists "masterWins" jsonb not null
    default '{"rookie":0,"tactician":0,"hunter":0,"grandmaster":0}'::jsonb;

-- ──────────────────────────────────────────────────────────────
-- match_history
-- ──────────────────────────────────────────────────────────────
create table if not exists public.match_history (
  id           uuid    primary key default gen_random_uuid(),
  "userId"     text    not null references public.users("userId") on delete cascade,

  mode         text    not null,
  opponent     text    not null,
  "opponentId" text,
  result       text    not null,   -- 'win' | 'loss'
  "myScore"    integer not null default 0,
  "theirScore" integer not null default 0,
  rounds       integer not null default 0,
  "timestamp"  bigint  not null
);

create index if not exists match_history_user_ts_idx
  on public.match_history ("userId", "timestamp" desc);

-- ──────────────────────────────────────────────────────────────
-- achievements  (Chat 7 — roadmap item #4)
-- ──────────────────────────────────────────────────────────────
create table if not exists public.achievements (
  "userId"        text   not null references public.users("userId") on delete cascade,
  "achievementId" text   not null,
  "unlockedAt"    bigint not null,

  primary key ("userId", "achievementId")
);

-- ──────────────────────────────────────────────────────────────
-- Leaderboard support index
-- ──────────────────────────────────────────────────────────────
create index if not exists player_stats_leaderboard_idx
  on public.player_stats (wins desc, "bestStreak" desc);

-- ══════════════════════════════════════════════════════════════
-- Chat 9 — Supabase Auth migration
-- ══════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
-- profiles
-- ──────────────────────────────────────────────────────────────
-- One row per Supabase Auth user. id is auth.users.id (uuid).
-- ON DELETE CASCADE: deleting the auth user removes the profile.
--
-- This table is the Supabase-side identity. It is intentionally
-- parallel to public.users (which remains the game-data join
-- target). username is duplicated in both tables and kept in sync
-- by server.js (changeUsername handler + ensureUserRow). Drift is
-- a known "fix later" item.
create table if not exists public.profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  username       text,
  avatar         text,
  is_premium     boolean     not null default false,
  premium_since  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Username uniqueness on the profiles side too. Nullable — a fresh
-- anonymous user may land here before ensureUserRow() assigns one.
create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

-- ──────────────────────────────────────────────────────────────
-- profiles — updated_at trigger
-- ──────────────────────────────────────────────────────────────
create or replace function public.bump_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists profiles_bump_updated_at on public.profiles;
create trigger profiles_bump_updated_at
  before update on public.profiles
  for each row execute procedure public.bump_updated_at();

-- ──────────────────────────────────────────────────────────────
-- handle_new_user — auto-create a profiles row on auth.users insert
-- ──────────────────────────────────────────────────────────────
-- Runs for BOTH anonymous sign-ins and email/password sign-ups.
-- Pulls username/avatar out of raw_user_meta_data if present.
-- SECURITY DEFINER so the trigger can write to public.profiles
-- regardless of the inserting role.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, avatar)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', null),
    coalesce(new.raw_user_meta_data->>'avatar', '🤖')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ──────────────────────────────────────────────────────────────
-- RLS policies on profiles
-- ──────────────────────────────────────────────────────────────
-- The server uses SERVICE_KEY and bypasses RLS entirely. These
-- policies exist so the CLIENT can read + update its own profile
-- via the anon key (used by userStore.bootstrapAuth / refreshPremium).
--
-- Read: a user can select only their own row.
-- Update: a user can update only their own row, and cannot escalate
--   is_premium or premium_since (those must be set by the server).
alter table public.profiles enable row level security;

drop policy if exists "profiles select own" on public.profiles;
create policy "profiles select own"
  on public.profiles
  for select
  using (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and is_premium = (select is_premium from public.profiles where id = auth.uid())
    and premium_since is not distinct from
      (select premium_since from public.profiles where id = auth.uid())
  );

-- Insert policy: normally the trigger creates the row, but if a
-- client races ahead (or the trigger is temporarily disabled) allow
-- a user to insert their own row.
drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
  on public.profiles
  for insert
  with check (auth.uid() = id and is_premium = false and premium_since is null);

-- ──────────────────────────────────────────────────────────────
-- migration_log
-- ──────────────────────────────────────────────────────────────
-- Audit trail for Chat 9 legacy migration. When an old client
-- presents a custom token, the server:
--   1. Looks up oldUserId via auth_tokens.
--   2. Creates a Supabase user → newUid.
--   3. Rewrites userId in users/player_stats/match_history/achievements.
--   4. Writes one row here: (oldUserId, newUid, migratedAt).
-- If a migration needs to be reversed, this table has everything
-- needed to run the UPDATE in the other direction.
create table if not exists public.migration_log (
  id           uuid        primary key default gen_random_uuid(),
  old_user_id  text        not null,
  new_uid      uuid        not null,
  legacy_token text,
  migrated_at  timestamptz not null default now()
);

create index if not exists migration_log_old_user_id_idx
  on public.migration_log (old_user_id);

-- ──────────────────────────────────────────────────────────────
-- Notes
-- ──────────────────────────────────────────────────────────────
-- * gen_random_uuid() is available by default on Supabase (pgcrypto
--   is enabled). No extension needed.
-- * All game timestamps are stored as bigint (Date.now() ms), matching
--   the existing in-memory code exactly. profiles.created_at /
--   updated_at are timestamptz because they come from Postgres defaults
--   and are only consumed by the client for display / premium_since.
-- * public.users.username and public.profiles.username are duplicated
--   and must be kept in sync by server.js. Known drift risk.
-- * auth_tokens is legacy. Do NOT drop until migrateLegacyToken has
--   been confirmed unused in production.