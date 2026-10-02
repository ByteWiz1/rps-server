-- rps-server/schema.sql
--
-- RPS Arena — Supabase schema.
--
-- Chat 4: initial schema (users, auth_tokens, player_stats, match_history).
-- Chat 7: achievements + three player_stats tracking columns.
-- Chat 9: Supabase Auth migration (Option A-lite).
-- Chat 9b: avatars table.
-- Chat 9b (revised):
--   - avatars table now includes xp, titles, win_streak to fully mirror
--     the client Avatar interface. image_url remains nullable and
--     currently unused (custom images deferred).
-- Chat 11: tournaments + tournament_rounds.
--   - Two new tables appended at the bottom. Idempotent, safe to re-run.
--   - Identity columns (hostId, players[], colorMap keys, matches.p1/p2)
--     are text userIds, matching users."userId" / avatars."userId" /
--     player_stats."userId". NOT uuid, NOT usernames.
--   - No RLS on the new tables — service-role only, same as player_stats,
--     match_history, achievements. The server is the sole writer.
--   - tournament_rounds.tournamentId cascades on delete of tournaments.
--   - tournaments.hostId has NO FK to users."userId" — intentional loose
--     coupling so host promotion on disconnect and legacy migration do
--     not accidentally cascade or block.
--
-- Chat 12a: onboarding + identity model.
--   - profiles gains `email` (text, nullable) and `is_guest`
--     (boolean, not null, default true).
--   - handle_new_user now assigns 'Guest_XXXX' when the new auth user
--     is anonymous (no email, or raw_user_meta_data.is_anonymous =
--     true). Registered signups get their chosen username.
--   - Backfill: existing profiles with a non-null email are marked
--     is_guest = false.
--
-- Run this ONCE in the Supabase SQL editor for a fresh project.
-- Idempotent: safe to re-run.

-- ──────────────────────────────────────────────────────────────
-- users
-- ──────────────────────────────────────────────────────────────
create table if not exists public.users (
  "userId"    text        primary key,
  username    text        not null,
  avatar      text        not null default '🤖',
  "createdAt" bigint      not null,
  "updatedAt" bigint      not null
);

create unique index if not exists users_username_lower_key
  on public.users (lower(username));

-- ──────────────────────────────────────────────────────────────
-- auth_tokens (LEGACY)
-- ──────────────────────────────────────────────────────────────
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
  result       text    not null,
  "myScore"    integer not null default 0,
  "theirScore" integer not null default 0,
  rounds       integer not null default 0,
  "timestamp"  bigint  not null
);

create index if not exists match_history_user_ts_idx
  on public.match_history ("userId", "timestamp" desc);

-- ──────────────────────────────────────────────────────────────
-- achievements
-- ──────────────────────────────────────────────────────────────
create table if not exists public.achievements (
  "userId"        text   not null references public.users("userId") on delete cascade,
  "achievementId" text   not null,
  "unlockedAt"    bigint not null,

  primary key ("userId", "achievementId")
);

create index if not exists player_stats_leaderboard_idx
  on public.player_stats (wins desc, "bestStreak" desc);

-- ══════════════════════════════════════════════════════════════
-- Chat 9 — Supabase Auth
-- ══════════════════════════════════════════════════════════════

create table if not exists public.profiles (
  id             uuid        primary key references auth.users(id) on delete cascade,
  username       text,
  avatar         text,
  is_premium     boolean     not null default false,
  premium_since  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Chat 12a — identity model additions.
--   email   : null for guests, filled for members.
--   is_guest: true for anonymous users (never linked); flips to false
--             the moment the account is upgraded (sign up or link).
alter table public.profiles
  add column if not exists email text;

alter table public.profiles
  add column if not exists is_guest boolean not null default true;

-- Backfill: any profile that already has an email is a member, not a
-- guest. Runs idempotently — re-running is a no-op once all rows
-- with email are marked.
update public.profiles
  set is_guest = false
  where email is not null
    and is_guest = true;

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

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

-- Chat 12a — handle_new_user now detects anonymous signups and
-- seeds a 'Guest_XXXX' placeholder username.
--
-- Detection:
--   * new.email IS NULL  → anonymous (signInAnonymously)
--   * new.raw_user_meta_data->>'is_anonymous' = 'true'  → anonymous
--
-- For anonymous users we ignore any username in the metadata and
-- generate 'Guest_' || 4 digits. For registered users we use the
-- metadata username if present, else fall back to null (the server
-- will fill it during identify).
--
-- is_guest mirrors the same detection.
create or replace function public.handle_new_user()
returns trigger as $$
declare
  is_anon boolean;
  meta_username text;
  meta_avatar text;
  final_username text;
  final_avatar text;
begin
  meta_username := new.raw_user_meta_data->>'username';
  meta_avatar   := coalesce(new.raw_user_meta_data->>'avatar', '🤖');

  is_anon := (new.email is null)
    or (coalesce(new.raw_user_meta_data->>'is_anonymous', 'false') = 'true');

  if is_anon then
    -- Placeholder guest name. Uniqueness handled by the username
    -- index; a rare collision would raise and the server's
    -- generateUniqueUsername path would resolve on next identify.
    final_username := 'Guest_' || lpad((floor(random() * 10000))::int::text, 4, '0');
    final_avatar   := meta_avatar;
  else
    final_username := nullif(meta_username, '');
    final_avatar   := meta_avatar;
  end if;

  insert into public.profiles (id, username, avatar, email, is_guest)
  values (
    new.id,
    final_username,
    final_avatar,
    new.email,
    is_anon
  )
  on conflict (id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

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

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
  on public.profiles
  for insert
  with check (auth.uid() = id and is_premium = false and premium_since is null);

create table if not exists public.migration_log (
  id           uuid        primary key default gen_random_uuid(),
  old_user_id  text        not null,
  new_uid      uuid        not null,
  legacy_token text,
  migrated_at  timestamptz not null default now()
);

create index if not exists migration_log_old_user_id_idx
  on public.migration_log (old_user_id);

-- ══════════════════════════════════════════════════════════════
-- Chat 9b — avatars
-- ══════════════════════════════════════════════════════════════
--
-- Server-side source of truth for a user's avatars. The client
-- useAvatarStore mirrors this table.
--
-- Shape notes:
--   * id is a client-generated UUID (client generates on create so
--     it can reference the avatar immediately).
--   * personality is jsonb: { aggression, memory, randomness, defense },
--     each 0..1.
--   * defeated_masters is text[] of master ids.
--   * titles is text[] of title strings.
--   * win_streak is the current streak. best_streak is the record.
--   * image_url is nullable and currently unused (custom images
--     deferred). When reintroduced, it will hold a Supabase Storage
--     public URL.
--   * xp drives level progression on the client.
--   * Exactly one selected per user, enforced by the partial unique
--     index below.
create table if not exists public.avatars (
  id                uuid        primary key,
  "userId"          text        not null references public.users("userId") on delete cascade,

  name              text        not null,
  emoji             text        not null default '🤖',
  personality       jsonb       not null
    default '{"aggression":0.5,"memory":0.5,"randomness":0.5,"defense":0.5}'::jsonb,

  rating            integer     not null default 1000,
  level             integer     not null default 1,
  xp                integer     not null default 0,
  wins              integer     not null default 0,
  losses            integer     not null default 0,
  ties              integer     not null default 0,
  "win_streak"      integer     not null default 0,
  "best_streak"     integer     not null default 0,

  titles            text[]      not null default '{}',
  "defeated_masters" text[]     not null default '{}',
  is_selected       boolean     not null default false,
  image_url         text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists avatars_user_id_idx
  on public.avatars ("userId");

create unique index if not exists avatars_one_selected_per_user
  on public.avatars ("userId") where is_selected = true;

drop trigger if exists avatars_bump_updated_at on public.avatars;
create trigger avatars_bump_updated_at
  before update on public.avatars
  for each row execute procedure public.bump_updated_at();

alter table public.avatars enable row level security;

drop policy if exists "avatars select own" on public.avatars;
create policy "avatars select own"
  on public.avatars
  for select
  using ("userId" = auth.uid()::text);

-- ══════════════════════════════════════════════════════════════
-- Chat 11 — tournaments
-- ══════════════════════════════════════════════════════════════
--
-- Server-authoritative tournament state. In-memory mirror lives in
-- server.js (`tournaments` Map + `tournamentCodes` Map). This table
-- is the durable record so a restart / redeploy does not lose a
-- tournament that is still in `lobby` status.
--
-- Identity columns use text userId (Supabase UID as text), matching
-- users."userId" / avatars."userId" / player_stats."userId". They are
-- NOT uuid and NOT usernames. This sidesteps the userId-vs-username
-- matching bugs logged in PROJECT_STATE.md (Known Issues #2, #3).
--
-- No FK on hostId or players[]. hostId is transferred at runtime on
-- host disconnect; players[] is a text[]. Loose coupling matches
-- match_history."opponentId" (also a bare text).
--
-- status:
--   'lobby'    — accepting joiners via code/link
--   'live'     — started, bracket locked, rounds in progress
--   'finished' — champion determined, rewards applied
--
-- type:
--   'human'    — Human vs Human matches
--   'avatar'   — Avatar vs Avatar matches
--
-- colorMap is jsonb keyed by userId: { "<userId>": "#RRGGBB", ... }.
-- 32-color palette defined in server.js. One unique color per player,
-- assigned randomly at tournament start.
create table if not exists public.tournaments (
  id             uuid        primary key default gen_random_uuid(),
  code           text        not null unique,

  "hostId"       text        not null,

  type           text        not null,
  "maxPlayers"   integer     not null,
  "winTarget"    integer     not null,
  "autoAdvance"  boolean     not null default true,
  name           text,
  "isPrivate"    boolean     not null default true,

  status         text        not null default 'lobby',
  "currentRound" integer     not null default 0,

  "colorMap"     jsonb       not null default '{}'::jsonb,
  players        text[]      not null default '{}',

  "winnerId"     text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint tournaments_code_len_chk
    check (char_length(code) = 6),
  constraint tournaments_type_chk
    check (type in ('human', 'avatar')),
  constraint tournaments_status_chk
    check (status in ('lobby', 'live', 'finished')),
  constraint tournaments_max_players_chk
    check ("maxPlayers" between 2 and 32),
  constraint tournaments_win_target_chk
    check ("winTarget" between 15 and 30)
);

create index if not exists tournaments_status_idx
  on public.tournaments (status);

create index if not exists tournaments_host_idx
  on public.tournaments ("hostId");

drop trigger if exists tournaments_bump_updated_at on public.tournaments;
create trigger tournaments_bump_updated_at
  before update on public.tournaments
  for each row execute procedure public.bump_updated_at();

-- ══════════════════════════════════════════════════════════════
-- Chat 11 — tournament_rounds
-- ══════════════════════════════════════════════════════════════
--
-- One row per round of a tournament. `matches` is a jsonb array of:
--   {
--     matchId:   string  (uuid),
--     p1:        userId  (text),
--     p2:        userId  (text),
--     roomCode:  string | null,
--     winner:    userId | null,
--     status:    'pending' | 'active' | 'complete',
--     scores:    { p1: number, p2: number, round: number }
--   }
--
-- `bye` is the userId of the player who auto-advanced this round
-- (or null if the round had an even number of players).
--
-- status:
--   'pending'  — created, not yet started (Active window not open)
--   'active'   — Active window open, matches running
--   'complete' — all matches resolved, winners determined
--
-- tournamentId cascades on delete of tournaments.
create table if not exists public.tournament_rounds (
  id             uuid        primary key default gen_random_uuid(),
  "tournamentId" uuid        not null
    references public.tournaments(id) on delete cascade,

  "roundNumber"  integer     not null,
  matches        jsonb       not null default '[]'::jsonb,
  bye            text,
  status         text        not null default 'pending',

  started_at     timestamptz,
  completed_at   timestamptz,

  constraint tournament_rounds_status_chk
    check (status in ('pending', 'active', 'complete')),
  constraint tournament_rounds_round_number_chk
    check ("roundNumber" >= 1)
);

create unique index if not exists tournament_rounds_unique_round
  on public.tournament_rounds ("tournamentId", "roundNumber");

create index if not exists tournament_rounds_tid_idx
  on public.tournament_rounds ("tournamentId", "roundNumber");

-- ──────────────────────────────────────────────────────────────
-- Notes
-- ──────────────────────────────────────────────────────────────
-- * gen_random_uuid() is available by default on Supabase.
-- * Game timestamps remain bigint (Date.now() ms). Chat 9/9b tables
--   (profiles, avatars, migration_log) use timestamptz defaults.
--   Chat 11 tables (tournaments, tournament_rounds) follow the
--   timestamptz convention.
-- * auth_tokens is legacy. Do NOT drop until migrateLegacyToken has
--   been confirmed unused in production.
-- * public.users.username and public.profiles.username are duplicated
--   and kept in sync by server.js. Known drift risk. Chat 12a adds
--   syncUsername() in db.js as the single atomic writer.
-- * tournaments.hostId and tournaments.players[] intentionally have
--   no FK. Host promotion on disconnect rewrites hostId at runtime;
--   players[] is a text[] and cannot be a FK target.