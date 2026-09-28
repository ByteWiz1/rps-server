// rps-server/db.js
//
// RPS Arena — Supabase persistence layer (Chat 4, roadmap item #1).
//
// Replaces the four in-memory Maps that used to live in server.js:
//   userAccounts      → users + auth_tokens
//   accountsByUserId  → users + auth_tokens
//   playerStats       → player_stats
//   matchHistory      → match_history
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
  };
}

// Convert a DB row (snake-free, PascalCase keys) → stats object.
// DB columns match createEmptyStats() exactly, so this is a shallow copy
// with the userId stripped.
function rowToStats(row) {
  if (!row) return createEmptyStats();
  const { userId, ...stats } = row;
  // Guard against nulls just in case (shouldn't happen — schema has defaults).
  const out = createEmptyStats();
  for (const k of Object.keys(out)) {
    if (typeof row[k] === 'number') out[k] = row[k];
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
  const { error: statsErr } = await supabase
    .from('player_stats')
    .insert({ userId });

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

// Deletes the user. FK ON DELETE CASCADE removes tokens, stats, history.
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
async function saveStats(userId, stats) {
  if (!userId) return false;

  const { error } = await supabase
    .from('player_stats')
    .upsert(
      { userId, ...stats },
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
};