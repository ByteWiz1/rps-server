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
//   - ACHIEVEMENT_CATALOG constant: the 25-item catalog.
//   - checkAchievements(userId): evaluate all 25 rules, insert new
//     unlocks, return the catalog entries newly unlocked.
//   - resolveMasterId(name): map dojo opponent display name → master id.
//
// Chat 9: Supabase Auth migration (Option A-lite).
//   - public.users."userId" (text) now holds a Supabase UID for new
//     users. Legacy rows keep their old 'user_xxx' value until they
//     migrate via migrateLegacyToken in server.js.
//   - public.profiles (uuid PK → auth.users.id) is the new
//     Supabase-side identity: username, avatar, is_premium.
//   - Removed: getUserByToken, createUser (custom user + token).
//   - Added: ensureUserRow, getProfile, updateProfileUsername,
//     setPremium, deleteUserEverywhere, findLegacyUserIdByToken,
//     deleteLegacyToken, migrateLegacyUser.
//   - Every helper still takes a string userId and queries by
//     ".eq('userId', userId)". The column type did NOT change.
//
// Every helper returns the SAME shape the old in-memory code produced,
// so server.js reads almost identically. All helpers are async.
//
// Uses the SERVICE_ROLE key — the server is trusted. Never ship this
// key to the client. It is also required for auth.admin.* calls
// (deleteUserEverywhere, migrateLegacyUser).

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
// Stats shape — mirrors createEmptyStats() in db consumers.
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
// Users  (public.users — game-data join target)
// ────────────────────────────────────────────────────────────

// Returns { userId, username, avatar, createdAt } or null.
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

// Updates username (and optionally avatar) on the users row.
// Caller must have already verified uniqueness.
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

// Same as updateUsername but only touches avatar.
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

// ────────────────────────────────────────────────────────────
// ensureUserRow — Chat 9
// ────────────────────────────────────────────────────────────
// Called on every authenticated socket connect. Guarantees a
// public.users row exists for this Supabase UID, creating one
// lazily if not. Also seeds a player_stats row.
//
// `username` should already be normalized + uniqueness-checked by
// the caller (server.js). If the user already exists, only avatar
// is synced (username changes go through updateUsername).
//
// Returns the full { userId, username, avatar, createdAt } shape,
// or null on failure.
async function ensureUserRow(uid, { username, avatar } = {}) {
  if (!uid) return null;

  const existing = await getUserById(uid);
  if (existing) {
    // Sync avatar if the client sent a different one.
    if (avatar && avatar !== existing.avatar) {
      await updateAvatar(uid, avatar);
      existing.avatar = avatar;
    }
    // Make sure a stats row exists (idempotent, cheap).
    await getOrCreateStats(uid);
    return existing;
  }

  const now = Date.now();
  const finalUsername = (username && String(username).trim()) || 'Player';
  const finalAvatar = avatar || '🤖';

  const { error: userErr } = await supabase
    .from('users')
    .insert({
      userId: uid,
      username: finalUsername,
      avatar: finalAvatar,
      createdAt: now,
      updatedAt: now,
    });

  if (userErr) {
    // 23505 = unique violation. Two sockets raced; re-select.
    if (userErr.code === '23505') {
      const retry = await getUserById(uid);
      if (retry) {
        await getOrCreateStats(uid);
        return retry;
      }
    }
    console.error('[DB] ensureUserRow insert error:', userErr.message);
    return null;
  }

  // Seed stats row. Non-fatal on failure (getOrCreateStats recreates lazily).
  const { error: statsErr } = await supabase
    .from('player_stats')
    .insert({
      userId: uid,
      opponentsPlayed: [],
      dailyWinDates: [],
      masterWins: emptyMasterWins(),
    });

  if (statsErr && statsErr.code !== '23505') {
    console.error('[DB] ensureUserRow player_stats seed error:', statsErr.message);
  }

  return {
    userId: uid,
    username: finalUsername,
    avatar: finalAvatar,
    createdAt: now,
  };
}

// ────────────────────────────────────────────────────────────
// Profiles  (public.profiles — Supabase Auth identity)
// ────────────────────────────────────────────────────────────

// Returns { id, username, avatar, is_premium, premium_since,
// created_at, updated_at } or null.
async function getProfile(uid) {
  if (!uid) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar, is_premium, premium_since, created_at, updated_at')
    .eq('id', uid)
    .maybeSingle();

  if (error) {
    console.error('[DB] getProfile error:', error.message);
    return null;
  }
  return data || null;
}

// Update profiles.username (and optionally avatar). Caller must have
// already verified uniqueness against BOTH public.users and profiles.
async function updateProfileUsername(uid, username, avatar) {
  if (!uid) return false;

  const patch = { username };
  if (avatar !== undefined) patch.avatar = avatar;

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', uid);

  if (error) {
    console.error('[DB] updateProfileUsername error:', error.message);
    return false;
  }
  return true;
}

// Set premium flag. Used by future payment webhook handlers.
// `until` is a timestamp (ms) or null. Stored as timestamptz.
async function setPremium(uid, isPremium, sinceMs) {
  if (!uid) return false;

  const patch = {
    is_premium: !!isPremium,
    premium_since: sinceMs ? new Date(sinceMs).toISOString() : null,
  };

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', uid);

  if (error) {
    console.error('[DB] setPremium error:', error.message);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// deleteUserEverywhere — Chat 9
// ────────────────────────────────────────────────────────────
// Deletes a user across BOTH layers:
//   1. auth.users via admin API (cascades to profiles).
//   2. public.users (cascades to player_stats, match_history,
//      achievements via FKs).
// Order matters: deleting auth.users first would cascade-drop the
// profiles row, but public.users is independent. We do public.users
// first, then auth, so a partial failure leaves the auth side
// intact for a retry (the user can still sign in and try again).
async function deleteUserEverywhere(uid) {
  if (!uid) return false;

  // 1. public.users (cascades game data).
  const { error: pubErr } = await supabase
    .from('users')
    .delete()
    .eq('userId', uid);

  if (pubErr) {
    console.error('[DB] deleteUserEverywhere public.users error:', pubErr.message);
    return false;
  }

  // 2. auth.users (cascades profiles).
  const { error: authErr } = await supabase.auth.admin.deleteUser(uid);
  if (authErr) {
    // Not fatal — public.users is gone, the account is unusable.
    // A stale auth.users row can be cleaned up manually.
    console.error('[DB] deleteUserEverywhere auth.admin error:', authErr.message);
    return true;
  }

  return true;
}

// ────────────────────────────────────────────────────────────
// Legacy migration — Chat 9
// ────────────────────────────────────────────────────────────

// Look up the old custom userId for a legacy token.
// Returns 'user_xxx' string or null.
async function findLegacyUserIdByToken(token) {
  if (!token) return null;

  const { data, error } = await supabase
    .from('auth_tokens')
    .select('"userId"')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[DB] findLegacyUserIdByToken error:', error.message);
    return null;
  }
  return data?.userId || null;
}

// Remove the legacy token row once migration succeeds.
async function deleteLegacyToken(token) {
  if (!token) return false;

  const { error } = await supabase
    .from('auth_tokens')
    .delete()
    .eq('token', token);

  if (error) {
    console.error('[DB] deleteLegacyToken error:', error.message);
    return false;
  }
  return true;
}

// Migrate a legacy user from 'user_xxx' to a Supabase UID.
//
// Steps:
//   1. Read the legacy public.users row.
//   2. Create an auth.users row with a synthetic email + random
//      password. Mark user_metadata.legacy_migrated = true and
//      carry username/avatar so the trigger seeds profiles.
//   3. Rewrite userId in users, player_stats, match_history,
//      achievements from oldUserId → newUid.
//   4. Log to migration_log.
//   5. Return { newUid, access_token, refresh_token }.
//      The session tokens come from a password grant against the
//      synthetic email/password the server just set. Client will
//      call supabase.auth.setSession() with them.
//
// On any failure after step 2, we attempt to clean up the newly
// created auth user so we don't orphan it.
async function migrateLegacyUser(oldUserId, legacyToken) {
  if (!oldUserId) return null;

  // 1. Read legacy user row (for username/avatar carry-over).
  const legacy = await getUserById(oldUserId);
  if (!legacy) {
    console.error('[DB] migrateLegacyUser: no public.users row for', oldUserId);
    return null;
  }

  // 2. Create Supabase auth user.
  const syntheticEmail = `legacy+${oldUserId}@rps-arena.local`;
  const randomPassword =
    require('crypto').randomBytes(32).toString('hex');

  const { data: created, error: createErr } =
    await supabase.auth.admin.createUser({
      email: syntheticEmail,
      password: randomPassword,
      email_confirm: true,
      user_metadata: {
        username: legacy.username,
        avatar: legacy.avatar,
        legacy_migrated: true,
        legacy_user_id: oldUserId,
      },
    });

  if (createErr || !created?.user) {
    console.error('[DB] migrateLegacyUser createUser error:', createErr?.message);
    return null;
  }

  const newUid = created.user.id;

  // 3. Rewrite userId across the four game tables.
  // Order matters only for FK integrity — users must be renamed
  // LAST or the child rows would orphan. So: children first, then
  // parent. But children have FKs pointing at the old userId, so
  // we can't update children before the parent without breaking FK.
  //
  // Correct order with FKs in place:
  //   a. Insert a new public.users row with userId = newUid.
  //   b. Update children from oldUserId → newUid.
  //   c. Delete the old public.users row.
  //
  // This keeps every FK valid at every step.
  const now = Date.now();

  const { error: newUserErr } = await supabase
    .from('users')
    .insert({
      userId: newUid,
      username: legacy.username,
      avatar: legacy.avatar,
      createdAt: legacy.createdAt || now,
      updatedAt: now,
    });

  if (newUserErr) {
    console.error('[DB] migrateLegacyUser new users insert error:', newUserErr.message);
    // Roll back the auth user we just created.
    await supabase.auth.admin.deleteUser(newUid).catch(() => {});
    return null;
  }

  const childTables = [
    { table: 'player_stats',   key: 'userId' },
    { table: 'match_history',  key: 'userId' },
    { table: 'achievements',   key: 'userId' },
  ];

  for (const { table, key } of childTables) {
    const { error } = await supabase
      .from(table)
      .update({ [key]: newUid })
      .eq(key, oldUserId);
    if (error) {
      console.error(`[DB] migrateLegacyUser ${table} rewrite error:`, error.message);
      // Best-effort: leave the new row + auth user in place so a
      // retry can finish. Return null to signal failure.
      return null;
    }
  }

  // c. Delete old public.users row. FK cascade would take children
  //    if any remained, but they were all rewritten above.
  const { error: delOldErr } = await supabase
    .from('users')
    .delete()
    .eq('userId', oldUserId);

  if (delOldErr) {
    console.error('[DB] migrateLegacyUser old users delete error:', delOldErr.message);
    // Non-fatal — the old row is now unreferenced.
  }

  // 4. Log.
  await supabase
    .from('migration_log')
    .insert({
      old_user_id: oldUserId,
      new_uid: newUid,
      legacy_token: legacyToken || null,
    })
    .then(() => {}, (e) =>
      console.error('[DB] migration_log insert error:', e?.message)
    );

  // 5. Get session tokens via password grant.
  //    Use a separate client so we don't pollute the service-role
  //    client's state with a user session.
  const { createClient: createAnonClient } = require('@supabase/supabase-js');
  const anonClient = createAnonClient(
    SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  const { data: session, error: signErr } =
    await anonClient.auth.signInWithPassword({
      email: syntheticEmail,
      password: randomPassword,
    });

  if (signErr || !session?.session) {
    console.error('[DB] migrateLegacyUser password grant error:', signErr?.message);
    // Auth user + rewritten rows exist; migration is functional but
    // the client didn't get a session. Return what we have so the
    // caller can still complete the connect, or fail loudly.
    return {
      newUid,
      access_token: null,
      refresh_token: null,
    };
  }

  return {
    newUid,
    access_token: session.session.access_token,
    refresh_token: session.session.refresh_token,
  };
}

// ────────────────────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────────────────────

// Fetch stats, creating the row if it doesn't exist (lazy init).
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

  const { error: insErr } = await supabase
    .from('player_stats')
    .insert({ userId });

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

// Persist a full stats object.
async function saveStats(userId, stats) {
  if (!userId) return false;

  const safe = stats && typeof stats === 'object' ? stats : {};

  const { error } = await supabase
    .from('player_stats')
    .upsert(
      {
        userId,
        ...safe,
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

  const { data: keep, error: selErr } = await supabase
    .from('match_history')
    .select('id')
    .eq('userId', userId)
    .order('timestamp', { ascending: false })
    .limit(MAX_HISTORY);

  if (selErr || !keep) {
    console.error('[DB] appendMatch trim select error:', selErr?.message);
    return true;
  }

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

const ACHIEVEMENT_BY_ID = Object.fromEntries(
  ACHIEVEMENT_CATALOG.map((a) => [a.id, a])
);

const MASTER_IDS = ['rookie', 'tactician', 'hunter', 'grandmaster'];

function resolveMasterId(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  for (const id of MASTER_IDS) {
    if (lower.includes(id)) return id;
  }
  return null;
}

function dateKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

function rematchCountApprox(stats) {
  const unique = Array.isArray(stats.opponentsPlayed)
    ? stats.opponentsPlayed.length
    : 0;
  const totalMatches = (stats.total || 0) + (stats.ties || 0);
  const diff = totalMatches - unique;
  return diff > 0 ? diff : 0;
}

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

  // users
  getUserById,
  isUsernameAvailable,
  updateUsername,
  updateAvatar,
  ensureUserRow,

  // profiles (Chat 9)
  getProfile,
  updateProfileUsername,
  setPremium,

  // deletion (Chat 9)
  deleteUserEverywhere,

  // legacy migration (Chat 9)
  findLegacyUserIdByToken,
  deleteLegacyToken,
  migrateLegacyUser,

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
  evaluateRules,
};