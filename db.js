// rps-server/db.js
//
// RPS Arena — Supabase persistence layer.
//
// Chat 4: replaces the four in-memory Maps that used to live in server.js:
//   userAccounts      → users + auth_tokens
//   accountsByUserId  → users + auth_tokens
//   playerStats       → player_stats
//   matchHistory      → match_history
//
// Chat 7: achievements (roadmap item #4).
//   - New table `achievements` (userId, achievementId, unlockedAt).
//   - New player_stats columns: opponentsPlayed text[], dailyWinDates
//     text[], masterWins jsonb.
//   - ACHIEVEMENT_CATALOG constant: the 25-item catalog (id, name,
//     description, icon, category, rule).
//   - checkAchievements(userId): evaluate all 25 rules against the
//     user's stats and insert any new unlocks. Returns the full catalog
//     entries for the achievements that were newly unlocked so the
//     caller can emit them to the client.
//   - resolveMasterId(name): map a dojo opponent display name to one of
//     the four master ids used by masterWins / the dojo achievements.
//
// Every helper returns the SAME shape the old in-memory code produced,
// so server.js reads almost identically. All helpers are async.
//
// Uses the SERVICE_ROLE key — the server is trusted. Never ship this
// key to the client.

'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    '[DB] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. ' +
    'Set both env vars on Render before starting the server.'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MAX_HISTORY = 20;

// ────────────────────────────────────────────────────────────
// Stats shape — mirrors createEmptyStats() in server.js exactly.
// Central factory so the empty object is identical everywhere.
//
// Chat 7 added three tracking fields used by the achievement rules:
//   opponentsPlayed — unique opponent userIds (social / rematch rules)
//   dailyWinDates   — 'YYYY-MM-DD' of each day with ≥1 win (perfect_week)
//   masterWins      — per-master win counts (dojo-special rules)
// ────────────────────────────────────────────────────────────
function createEmptyStats() {
  return {
    wins: 0,
    losses: 0,
    ties: 0,
    total: 0,
    humanWins: 0,
    humanLosses: 0,
    humanTies: 0,
    avatarWins: 0,
    avatarLosses: 0,
    avatarTies: 0,
    dojoWins: 0,
    dojoLosses: 0,
    dojoTies: 0,
    currentStreak: 0,
    bestStreak: 0,
    // Chat 7 tracking
    opponentsPlayed: [],
    dailyWinDates: [],
    masterWins: { rookie: 0, tactician: 0, hunter: 0, grandmaster: 0 },
  };
}

// Shape used when a masterWins column is missing or malformed.
function emptyMasterWins() {
  return { rookie: 0, tactician: 0, hunter: 0, grandmaster: 0 };
}

// Convert a DB row → stats object.
// Numeric fields are copied by name; the three Chat 7 fields are
// sanitized so a NULL / missing column never crashes callers.
function rowToStats(row) {
  if (!row) return createEmptyStats();

  const out = createEmptyStats();

  for (const k of Object.keys(out)) {
    if (k === 'opponentsPlayed' || k === 'dailyWinDates' || k === 'masterWins') {
      continue;
    }
    if (typeof row[k] === 'number') out[k] = row[k];
  }

  // Arrays: accept text[] or JSON array, else default to [].
  if (Array.isArray(row.opponentsPlayed)) {
    out.opponentsPlayed = row.opponentsPlayed.filter(
      (v) => typeof v === 'string' && v.length > 0
    );
  }
  if (Array.isArray(row.dailyWinDates)) {
    out.dailyWinDates = row.dailyWinDates.filter(
      (v) => typeof v === 'string' && v.length > 0
    );
  }

  // masterWins: jsonb → object. Coerce each key to a non-negative int.
  const mw = row.masterWins;
  if (mw && typeof mw === 'object' && !Array.isArray(mw)) {
    const base = emptyMasterWins();
    for (const key of Object.keys(base)) {
      const v = Number(mw[key]);
      base[key] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    }
    out.masterWins = base;
  }

  return out;
}

// ────────────────────────────────────────────────────────────
// Users + tokens
// ────────────────────────────────────────────────────────────

// Returns { userId, username, avatar, createdAt, token } or null.
// Also bumps auth_tokens.lastUsedAt on hit (best-effort, non-blocking
// on failure — a stale lastUsedAt is not worth failing login over).
async function getUserByToken(token) {
  if (!token) return null;

  const { data, error } = await supabase
    .from('auth_tokens')
    .select('token, "userId", users:userId ("userId", username, avatar, "createdAt")')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[DB] getUserByToken error:', error.message);
    return null;
  }
  if (!data || !data.users) return null;

  // Fire-and-forget lastUsedAt bump.
  supabase
    .from('auth_tokens')
    .update({ lastUsedAt: Date.now() })
    .eq('token', token)
    .then(() => {}, () => {});

  return {
    userId: data.users.userId,
    username: data.users.username,
    avatar: data.users.avatar,
    createdAt: data.users.createdAt,
    token: data.token,
  };
}

// Returns { userId, username, avatar, createdAt } or null (no token).
async function getUserById(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from('users')
    .select('"userId", username, avatar, "createdAt"')
    .eq('userId', userId)
    .maybeSingle();

  if (error) {
    console.error('[DB] getUserById error:', error.message);
    return null;
  }
  return data || null;
}

// Case-insensitive availability check against stored accounts only.
// Live-player availability is checked separately in server.js against
// the in-memory onlinePlayers map (unchanged behavior).
// Returns true if the name is free (or only held by exceptUserId).
async function isUsernameAvailable(name, exceptUserId) {
  const normalized = (name || '').trim().toLowerCase();
  if (!normalized) return false;

  let q = supabase
    .from('users')
    .select('"userId"')
    .eq('username', normalized);

  if (exceptUserId) {
    q = q.neq('userId', exceptUserId);
  }

  const { data, error } = await q.limit(1);
  if (error) {
    console.error('[DB] isUsernameAvailable error:', error.message);
    // Fail closed — if we can't verify, treat as taken to avoid dupes.
    return false;
  }
  return !data || data.length === 0;
}

// Creates a fresh user + token in one logical step.
// Returns the full account shape used by server.js:
//   { userId, token, username, avatar, createdAt }
// Throws on DB error so the caller can emit identityError.
async function createUser({ userId, token, username, avatar, createdAt }) {
  const now = createdAt || Date.now();

  const { error: userErr } = await supabase
    .from('users')
    .insert({
      userId,
      username,
      avatar,
      createdAt: now,
      updatedAt: now,
    });

  if (userErr) {
    console.error('[DB] createUser users insert error:', userErr.message);
    throw userErr;
  }

  const { error: tokenErr } = await supabase
    .from('auth_tokens')
    .insert({
      token,
      userId,
      createdAt: now,
      lastUsedAt: now,
    });

  if (tokenErr) {
    console.error('[DB] createUser auth_tokens insert error:', tokenErr.message);
    // Roll back the user row so we don't leave an orphan.
    await supabase.from('users').delete().eq('userId', userId);
    throw tokenErr;
  }

  // Seed a stats row so leaderboard queries see the user immediately.
  // Chat 7: also seed the tracking columns explicitly so they exist
  // from row one (schema defaults cover this too — belt and braces).
  const { error: statsErr } = await supabase
    .from('player_stats')
    .insert({
      userId,
      opponentsPlayed: [],
      dailyWinDates: [],
      masterWins: emptyMasterWins(),
    });

  if (statsErr) {
    // Non-fatal: getOrCreateStats() will create it lazily. Log and move on.
    console.error('[DB] createUser player_stats seed error:', statsErr.message);
  }

  return { userId, token, username, avatar, createdAt: now };
}

// Updates username (and optionally avatar) on the users row.
// Caller must have already verified uniqueness.
// Returns true on success, false on error.
async function updateUsername(userId, username, avatar) {
  if (!userId) return false;

  const patch = { username, updatedAt: Date.now() };
  if (avatar !== undefined) patch.avatar = avatar;

  const { error } = await supabase
    .from('users')
    .update(patch)
    .eq('userId', userId);

  if (error) {
    console.error('[DB] updateUsername error:', error.message);
    return false;
  }
  return true;
}

// Same as updateUsername but only touches avatar. Used by registerIdentity
// when restoring a session with a changed avatar.
async function updateAvatar(userId, avatar) {
  if (!userId || !avatar) return false;

  const { error } = await supabase
    .from('users')
    .update({ avatar, updatedAt: Date.now() })
    .eq('userId', userId);

  if (error) {
    console.error('[DB] updateAvatar error:', error.message);
    return false;
  }
  return true;
}

// Deletes the user. FK ON DELETE CASCADE removes tokens, stats, history,
// and achievement unlocks.
// Returns true on success.
async function deleteUser(userId) {
  if (!userId) return false;

  const { error } = await supabase
    .from('users')
    .delete()
    .eq('userId', userId);

  if (error) {
    console.error('[DB] deleteUser error:', error.message);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────────────────────

// Fetch stats, creating the row if it doesn't exist (lazy init).
// Always returns a full stats object.
async function getOrCreateStats(userId) {
  if (!userId) return createEmptyStats();

  const { data, error } = await supabase
    .from('player_stats')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();

  if (error) {
    console.error('[DB] getOrCreateStats select error:', error.message);
    return createEmptyStats();
  }
  if (data) return rowToStats(data);

  // Missing — create it. ON CONFLICT DO NOTHING handles the race.
  const { error: insErr } = await supabase
    .from('player_stats')
    .insert({ userId });

  // 23505 = unique violation — someone else just created it, fine.
  if (insErr && insErr.code !== '23505') {
    console.error('[DB] getOrCreateStats insert error:', insErr.message);
    return createEmptyStats();
  }

  const { data: created, error: reErr } = await supabase
    .from('player_stats')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();

  if (reErr || !created) {
    console.error('[DB] getOrCreateStats re-select error:', reErr?.message);
    return createEmptyStats();
  }
  return rowToStats(created);
}

// Persist a full stats object. Caller mutates a local copy then writes
// it back with this function — mirrors the old playerStats.set() pattern.
//
// Chat 7: the three tracking fields ride along on the same upsert. They
// are plain JS values that Supabase serializes to text[] / jsonb.
async function saveStats(userId, stats) {
  if (!userId) return false;

  const safe = stats && typeof stats === 'object' ? stats : {};

  const { error } = await supabase
    .from('player_stats')
    .upsert(
      {
        userId,
        ...safe,
        // Defensive: never write undefined/null into these columns.
        opponentsPlayed: Array.isArray(safe.opponentsPlayed)
          ? safe.opponentsPlayed
          : [],
        dailyWinDates: Array.isArray(safe.dailyWinDates)
          ? safe.dailyWinDates
          : [],
        masterWins:
          safe.masterWins && typeof safe.masterWins === 'object'
            ? safe.masterWins
            : emptyMasterWins(),
      },
      { onConflict: 'userId' }
    );

  if (error) {
    console.error('[DB] saveStats error:', error.message);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Match history
// ────────────────────────────────────────────────────────────

// Append a match row, then trim the user's history to MAX_HISTORY.
// The match object uses the exact shape server.js already builds:
//   { mode, opponent, opponentId, result, myScore, theirScore, rounds, timestamp }
async function appendMatch(userId, match) {
  if (!userId || !match) return false;

  const { error } = await supabase
    .from('match_history')
    .insert({
      userId,
      mode: match.mode,
      opponent: match.opponent,
      opponentId: match.opponentId || null,
      result: match.result,
      myScore: match.myScore || 0,
      theirScore: match.theirScore || 0,
      rounds: match.rounds || 0,
      timestamp: match.timestamp || Date.now(),
    });

  if (error) {
    console.error('[DB] appendMatch error:', error.message);
    return false;
  }

  // Trim: find ids of the newest MAX_HISTORY rows, delete the rest.
  // Two-step (select ids, then delete) to avoid needing a subquery.
  const { data: keep, error: selErr } = await supabase
    .from('match_history')
    .select('id')
    .eq('userId', userId)
    .order('timestamp', { ascending: false })
    .limit(MAX_HISTORY);

  if (selErr || !keep) {
    // Non-fatal — history will just grow slightly. Log and move on.
    console.error('[DB] appendMatch trim select error:', selErr?.message);
    return true;
  }

  const keepIds = keep.map((r) => r.id);

  // Delete anything older than the cutoff timestamp. Simpler and safe
  // than a NOT IN (...) with 20 uuids.
  const oldestKept = keep[keep.length - 1];
  if (!oldestKept) return true;

  const { data: oldestRow } = await supabase
    .from('match_history')
    .select('timestamp')
    .eq('id', oldestKept.id)
    .maybeSingle();

  if (!oldestRow) return true;

  const { error: delErr } = await supabase
    .from('match_history')
    .delete()
    .eq('userId', userId)
    .lt('timestamp', oldestRow.timestamp);

  if (delErr) {
    console.error('[DB] appendMatch trim delete error:', delErr.message);
  }

  return true;
}

// Returns the user's matches, newest first, max MAX_HISTORY.
// Shape matches the old in-memory array exactly:
//   { mode, opponent, opponentId, result, myScore, theirScore, rounds, timestamp }
async function getMatchHistory(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from('match_history')
    .select('mode, opponent, "opponentId", result, "myScore", "theirScore", rounds, "timestamp"')
    .eq('userId', userId)
    .order('timestamp', { ascending: false })
    .limit(MAX_HISTORY);

  if (error) {
    console.error('[DB] getMatchHistory error:', error.message);
    return [];
  }
  return data || [];
}

// ────────────────────────────────────────────────────────────
// Leaderboard
// ────────────────────────────────────────────────────────────

// Pulls all stats rows joined with users, then server.js sorts/slices
// into the three top-20 lists exactly as before.
// Returns: array of { userId, username, avatar, ...stats }
async function listStatsWithUsers() {
  const { data, error } = await supabase
    .from('player_stats')
    .select('*, users:userId (username, avatar)')
    .order('wins', { ascending: false })
    .limit(500);

  if (error) {
    console.error('[DB] listStatsWithUsers error:', error.message);
    return [];
  }
  if (!data) return [];

  return data.map((row) => {
    const stats = rowToStats(row);
    const u = row.users || {};
    return {
      userId: row.userId,
      username: u.username || 'Unknown',
      avatar: u.avatar || '🤖',
      ...stats,
    };
  });
}

// ────────────────────────────────────────────────────────────
// ACHIEVEMENTS (Chat 7 — roadmap item #4)
// ────────────────────────────────────────────────────────────

// The full 25-item catalog. Keep ids stable — they are the primary key
// half in the achievements table. `rule` is a human-readable string for
// the client; the actual evaluation lives in checkAchievements().
//
// Category strings are used by the client to group badges.
//   progression | streaks | mode | dojo | volume | social
const ACHIEVEMENT_CATALOG = [
  // ── Progression (5) ──
  { id: 'first_win',         name: 'First Win',         icon: '🥇', category: 'progression', rule: 'wins >= 1',            description: 'Win your first match.' },
  { id: 'ten_wins',          name: 'Getting Started',   icon: '🎯', category: 'progression', rule: 'wins >= 10',           description: 'Win 10 matches.' },
  { id: 'fifty_wins',        name: 'Half Century',      icon: '🏅', category: 'progression', rule: 'wins >= 50',           description: 'Win 50 matches.' },
  { id: 'hundred_wins',      name: 'Century Club',      icon: '💯', category: 'progression', rule: 'wins >= 100',          description: 'Win 100 matches.' },
  { id: 'five_hundred_wins', name: 'Legend',            icon: '👑', category: 'progression', rule: 'wins >= 500',          description: 'Win 500 matches.' },

  // ── Streaks (4) ──
  { id: 'streak_5',          name: 'On Fire',           icon: '🔥', category: 'streaks',     rule: 'bestStreak >= 5',      description: 'Win 5 matches in a row.' },
  { id: 'streak_10',         name: 'Unstoppable',       icon: '⚡', category: 'streaks',     rule: 'bestStreak >= 10',     description: 'Win 10 matches in a row.' },
  { id: 'streak_20',         name: 'Immortal',          icon: '♾️', category: 'streaks',     rule: 'bestStreak >= 20',     description: 'Win 20 matches in a row.' },
  { id: 'perfect_week',      name: 'Perfect Week',      icon: '📅', category: 'streaks',     rule: 'won a match 7 days in a row', description: 'Win at least one match every day for 7 days.' },

  // ── Mode Mastery (6) ──
  { id: 'human_champ',       name: "People's Champion", icon: '👥', category: 'mode',        rule: 'humanWins >= 10',      description: 'Win 10 Human vs Human matches.' },
  { id: 'avatar_champ',      name: 'Arena Champion',    icon: '🎭', category: 'mode',        rule: 'avatarWins >= 10',     description: 'Win 10 Avatar Arena matches.' },
  { id: 'dojo_master',       name: 'Dojo Master',       icon: '🥋', category: 'mode',        rule: 'dojoWins >= 10',       description: 'Win 10 AI Dojo matches.' },
  { id: 'all_rounder',       name: 'All-Rounder',       icon: '🎲', category: 'mode',        rule: 'won at least 1 in each mode (human, avatar, dojo)', description: 'Win at least one match in every mode.' },
  { id: 'mode_specialist',   name: 'Mode Specialist',   icon: '🎪', category: 'mode',        rule: '100 wins in any single mode', description: 'Win 100 matches in a single mode.' },
  { id: 'jack_of_all_trades',name: 'Jack of All Trades',icon: '🃏', category: 'mode',        rule: '50 wins in each mode', description: 'Win 50 matches in every mode.' },

  // ── Dojo Specials (4) ──
  { id: 'grandmaster_slayer',name: 'Grandmaster Slayer',icon: '🐉', category: 'dojo',        rule: 'beat Grandmaster at least once', description: 'Defeat the Grandmaster.' },
  { id: 'dojo_sweeper',      name: 'Dojo Sweeper',      icon: '🧹', category: 'dojo',        rule: 'beat all 4 masters (Rookie, Tactician, Hunter, Grandmaster)', description: 'Defeat every dojo master at least once.' },
  { id: 'rookie_killer',     name: 'Rookie Killer',     icon: '🐣', category: 'dojo',        rule: 'beat Rookie 10 times', description: 'Defeat the Rookie 10 times.' },
  { id: 'hunter_survivor',   name: 'Hunter Survivor',   icon: '🏹', category: 'dojo',        rule: 'beat Hunter 5 times',  description: 'Defeat the Hunter 5 times.' },

  // ── Volume (3) ──
  { id: 'veteran',           name: 'Veteran',           icon: '🎖️', category: 'volume',      rule: 'total matches >= 100', description: 'Play 100 matches.' },
  { id: 'grinder',           name: 'Grinder',           icon: '⚙️', category: 'volume',      rule: 'total matches >= 500', description: 'Play 500 matches.' },
  { id: 'addict',            name: 'Addict',            icon: '🧠', category: 'volume',      rule: 'total matches >= 1000',description: 'Play 1000 matches.' },

  // ── Social (3) ──
  { id: 'social_5',          name: 'Getting Social',    icon: '🤝', category: 'social',      rule: 'played vs 5 unique opponents', description: 'Play against 5 different opponents.' },
  { id: 'social_25',         name: 'Well-Connected',    icon: '🌐', category: 'social',      rule: 'played vs 25 unique opponents', description: 'Play against 25 different opponents.' },
  { id: 'rematch_king',      name: 'Rematch King',      icon: '🔁', category: 'social',      rule: 'played 10 rematches',  description: 'Play 10 rematches.' },
];

// Fast lookup by id.
const ACHIEVEMENT_BY_ID = Object.fromEntries(
  ACHIEVEMENT_CATALOG.map((a) => [a.id, a])
);

// Master ids recognized by masterWins + the dojo achievements.
const MASTER_IDS = ['rookie', 'tactician', 'hunter', 'grandmaster'];

// Map a dojo opponent display name ("Rookie", "The Grandmaster",
// "Master Hunter", …) to a master id. Case-insensitive substring match
// so small display-name variations don't break the rule.
// Returns null if nothing matches (in which case masterWins is untouched).
function resolveMasterId(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  for (const id of MASTER_IDS) {
    if (lower.includes(id)) return id;
  }
  return null;
}

// Local helper — 'YYYY-MM-DD' for a timestamp (local server time).
function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Does dailyWinDates contain 7 consecutive calendar days ending anywhere
// in the array? Cheap: sort unique dates, then scan for a run of 7.
function hasSevenDayWinStreak(dates) {
  if (!Array.isArray(dates) || dates.length < 7) return false;

  const unique = Array.from(new Set(dates.filter((d) => typeof d === 'string' && d)));
  if (unique.length < 7) return false;

  const ms = unique
    .map((s) => {
      const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
      if (!y || !m || !d) return NaN;
      return Date.UTC(y, m - 1, d);
    })
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const DAY = 24 * 60 * 60 * 1000;
  let run = 1;
  for (let i = 1; i < ms.length; i++) {
    if (ms[i] - ms[i - 1] === DAY) {
      run++;
      if (run >= 7) return true;
    } else if (ms[i] !== ms[i - 1]) {
      run = 1;
    }
  }
  return false;
}

// Count how many opponents have been faced more than once.
// opponentsPlayed is a *unique* list, so we can't count rematches from
// it alone. We approximate: rematch_king is satisfied when the user has
// played at least 10 more total matches than unique opponents, i.e.
// total - opponentsPlayed.length >= 10. This is intentionally simple;
// see the "fix later" note about switching to a real rematch counter.
function rematchCountApprox(stats) {
  const unique = Array.isArray(stats.opponentsPlayed)
    ? stats.opponentsPlayed.length
    : 0;
  const totalMatches = (stats.total || 0) + (stats.ties || 0);
  const diff = totalMatches - unique;
  return diff > 0 ? diff : 0;
}

// Evaluate every rule against a stats object.
// Returns the subset of catalog entries whose rules are satisfied.
// Pure — no DB access. checkAchievements() handles persistence.
function evaluateRules(stats) {
  const s = stats || {};
  const wins = s.wins || 0;
  const totalMatches = (s.total || 0) + (s.ties || 0);
  const bestStreak = s.bestStreak || 0;
  const humanWins = s.humanWins || 0;
  const avatarWins = s.avatarWins || 0;
  const dojoWins = s.dojoWins || 0;

  const masterWins = s.masterWins && typeof s.masterWins === 'object'
    ? s.masterWins
    : emptyMasterWins();

  const uniqueOpponents = Array.isArray(s.opponentsPlayed)
    ? s.opponentsPlayed.length
    : 0;

  const rematches = rematchCountApprox(s);

  const modeWinCounts = [humanWins, avatarWins, dojoWins];
  const maxModeWins = Math.max(...modeWinCounts, 0);
  const minModeWins = Math.min(...modeWinCounts);

  const rules = {
    first_win:          wins >= 1,
    ten_wins:           wins >= 10,
    fifty_wins:         wins >= 50,
    hundred_wins:       wins >= 100,
    five_hundred_wins:  wins >= 500,

    streak_5:           bestStreak >= 5,
    streak_10:          bestStreak >= 10,
    streak_20:          bestStreak >= 20,
    perfect_week:       hasSevenDayWinStreak(s.dailyWinDates),

    human_champ:        humanWins >= 10,
    avatar_champ:       avatarWins >= 10,
    dojo_master:        dojoWins >= 10,
    all_rounder:        humanWins >= 1 && avatarWins >= 1 && dojoWins >= 1,
    mode_specialist:    maxModeWins >= 100,
    jack_of_all_trades: minModeWins >= 50,

    grandmaster_slayer: (masterWins.grandmaster || 0) >= 1,
    dojo_sweeper:
      (masterWins.rookie || 0) >= 1 &&
      (masterWins.tactician || 0) >= 1 &&
      (masterWins.hunter || 0) >= 1 &&
      (masterWins.grandmaster || 0) >= 1,
    rookie_killer:      (masterWins.rookie || 0) >= 10,
    hunter_survivor:    (masterWins.hunter || 0) >= 5,

    veteran:            totalMatches >= 100,
    grinder:            totalMatches >= 500,
    addict:             totalMatches >= 1000,

    social_5:           uniqueOpponents >= 5,
    social_25:          uniqueOpponents >= 25,
    rematch_king:       rematches >= 10,
  };

  return ACHIEVEMENT_CATALOG.filter((a) => rules[a.id]);
}

// Returns a map { achievementId: unlockedAt } for everything this user
// has already unlocked. Empty object on error (caller treats as "none").
async function getUnlockedMap(userId) {
  if (!userId) return {};

  const { data, error } = await supabase
    .from('achievements')
    .select('"achievementId", "unlockedAt"')
    .eq('userId', userId);

  if (error) {
    console.error('[DB] getUnlockedMap error:', error.message);
    return {};
  }

  const map = {};
  for (const row of data || []) {
    map[row.achievementId] = row.unlockedAt;
  }
  return map;
}

// Main entry. Reads the user's stats, evaluates all 25 rules, and
// inserts any newly-satisfied achievements.
//
// Idempotent: the achievements table PK (userId, achievementId) plus
// ON CONFLICT DO NOTHING means a re-run inserts nothing.
//
// Returns an ARRAY of catalog entries (id, name, description, icon,
// category, rule) for the achievements unlocked by THIS call — empty
// array if none. On any DB failure, returns [] and logs; it never
// throws, so callers can fire-and-forget.
async function checkAchievements(userId) {
  if (!userId) return [];

  try {
    const stats = await getOrCreateStats(userId);
    const satisfied = evaluateRules(stats);

    if (satisfied.length === 0) return [];

    const already = await getUnlockedMap(userId);
    const fresh = satisfied.filter((a) => !already[a.id]);

    if (fresh.length === 0) return [];

    const now = Date.now();
    const rows = fresh.map((a) => ({
      userId,
      achievementId: a.id,
      unlockedAt: now,
    }));

    const { error } = await supabase
      .from('achievements')
      .upsert(rows, {
        onConflict: 'userId,achievementId',
        ignoreDuplicates: true,
      });

    if (error) {
      console.error('[DB] checkAchievements insert error:', error.message);
      return [];
    }

    console.log(
      '[ACHIEVEMENTS]',
      userId,
      '→ unlocked:',
      fresh.map((a) => a.id).join(', ')
    );

    return fresh;
  } catch (e) {
    console.error('[DB] checkAchievements error:', e?.message || e);
    return [];
  }
}

// ────────────────────────────────────────────────────────────
// Exports
// ────────────────────────────────────────────────────────────
module.exports = {
  supabase,
  createEmptyStats,

  // users / tokens
  getUserByToken,
  getUserById,
  isUsernameAvailable,
  createUser,
  updateUsername,
  updateAvatar,
  deleteUser,

  // stats
  getOrCreateStats,
  saveStats,

  // history
  appendMatch,
  getMatchHistory,

  // leaderboard
  listStatsWithUsers,

  // achievements (Chat 7)
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_BY_ID,
  checkAchievements,
  getUnlockedMap,
  resolveMasterId,
  dateKey,
  // exported for potential client-side mirroring / tests
  evaluateRules,
};