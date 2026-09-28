-- rps-server/schema.sql
--
-- RPS Arena — Supabase schema.
--
-- Chat 4: initial schema (users, auth_tokens, player_stats, match_history).
-- Chat 7: achievements (roadmap item #4) — new table + three new
--         player_stats tracking columns used by the achievement rules.
--
-- Run this ONCE in the Supabase SQL editor for a fresh project.
-- Idempotent: safe to re-run (IF NOT EXISTS everywhere; new columns use
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS).
--
-- Persistent state (survives Render redeploys):
--   users          — one row per account
--   auth_tokens    — one row per issued token (many per user allowed,
--                    only one active at a time in practice)
--   player_stats   — one row per user, mirrors createEmptyStats()
--   match_history  — append-only, capped at 20 rows per user in app code
--   achievements   — one row per (user, achievement) unlocked pair
--
-- Ephemeral state (rooms, players, onlinePlayers, activeInvites,
-- recentOpponents) stays in server memory and is NOT in this schema.

-- ──────────────────────────────────────────────────────────────
-- users
-- ──────────────────────────────────────────────────────────────
-- userId is generated server-side as 'user_' + 24 hex chars, matching
-- the existing in-memory generateUserId(). Stored as text (not uuid)
-- so the client never sees a format change.
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
-- token is a 64-char hex string (crypto.randomBytes(32).toString('hex')).
-- ON DELETE CASCADE: deleting a user removes all their tokens.
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
--
-- ADD COLUMN IF NOT EXISTS is a no-op on re-run, and NOT NULL DEFAULT
-- with an immutable-ish default does not rewrite existing rows in
-- modern Postgres — it's a metadata-only change.
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
-- Append-only. App keeps only the latest 20 per user by deleting
-- older rows after insert (see db.appendMatch). id is a real uuid so
-- ordering is stable even if two matches share a timestamp.
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

-- Leaderboard + per-user history lookups both hit this index.
create index if not exists match_history_user_ts_idx
  on public.match_history ("userId", "timestamp" desc);

-- ──────────────────────────────────────────────────────────────
-- achievements  (Chat 7 — roadmap item #4)
-- ──────────────────────────────────────────────────────────────
-- One row per (user, achievement) pair. The composite primary key is
-- the idempotency guard: insert with ON CONFLICT DO NOTHING, and a
-- re-evaluation that finds the same rule satisfied writes nothing.
--
-- achievementId is a stable string id from the 25-item catalog in db.js
-- (e.g. 'first_win', 'streak_10'). We do NOT store the name/icon/desc
-- here — those live in the catalog constant so a copy tweak doesn't
-- require a migration.
--
-- ON DELETE CASCADE: deleting a user removes all their unlocks.
create table if not exists public.achievements (
  "userId"        text   not null references public.users("userId") on delete cascade,
  "achievementId" text   not null,
  "unlockedAt"    bigint not null,

  primary key ("userId", "achievementId")
);

-- ──────────────────────────────────────────────────────────────
-- Leaderboard support index
-- ──────────────────────────────────────────────────────────────
-- Used by the pull-based leaderboard (top by wins / win rate / streak).
create index if not exists player_stats_leaderboard_idx
  on public.player_stats (wins desc, "bestStreak" desc);

-- ──────────────────────────────────────────────────────────────
-- Notes
-- ──────────────────────────────────────────────────────────────
-- * gen_random_uuid() is available by default on Supabase (pgcrypto
--   is enabled). No extension needed.
-- * All timestamps are stored as bigint (Date.now() ms), matching
--   the current in-memory code exactly. No TZ conversions anywhere.
-- * No RLS policies are defined because the server uses the
--   SERVICE_KEY (bypasses RLS). If you ever add a client-side
--   Supabase SDK call, add RLS policies at that time.
-- * The achievements PK (userId, achievementId) already covers the
--   "list my unlocks" query — its leading column is userId — so no
--   extra index is needed.