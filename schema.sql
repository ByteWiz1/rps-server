-- rps-server/schema.sql
--
-- RPS Arena — Supabase schema (Chat 4, roadmap item #1).
--
-- Run this ONCE in the Supabase SQL editor for a fresh project.
-- Idempotent: safe to re-run (uses IF NOT EXISTS everywhere).
--
-- Persistent state (survives Render redeploys):
--   users          — one row per account
--   auth_tokens    — one row per issued token (many per user allowed,
--                    only one active at a time in practice)
--   player_stats   — one row per user, mirrors createEmptyStats()
--   match_history  — append-only, capped at 20 rows per user in app code
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