// rps-server/db.js
//
// RPS Arena — Supabase persistence layer.
//
// Chat 4: users + tokens + stats + history.
// Chat 7: achievements.
// Chat 9: Supabase Auth migration (Option A-lite).
// Chat 9b: avatars.
// Chat 9c: ES256 JWT verification (in server.js).
// Chat 9d:
//   - createAvatar now generates its own UUID server-side.
//     Fixes "invalid input syntax for type uuid" caused by the
//     client sending non-UUID ids from AvatarEngine.
//   - New createDefaultAvatarForUser(uid, name) — idempotent default
//     avatar for users with zero avatars.
//   - New renameDefaultAvatarIfNeeded(uid, newName) — renames a
//     single "Guest"/"Player" avatar to the user's chosen name.
// Chat 11: tournaments.
//   - CRUD helpers for `tournaments` and `tournament_rounds`.
//   - awardTournamentRewards(uid, { ratingDelta, xpDelta, title }).
//   - calculateAvatarLevel(xp) mirrors avatarStore.calculateLevelLocal
//     so server-written level matches what the client would compute.
//   - migrateLegacyUser rewrites tournaments.hostId + players[] and
//     colorMap keys. tournament_rounds.matches jsonb is NOT rewritten
//     (known limitation — logged for a follow-up chat).
// Chat 12a: onboarding + identity model.
//   - New getEmailByUsername(username) — case-insensitive lookup on
//     profiles.username. Used by the resolveEmailFromUsername socket
//     event. Returns email string or null.
//   - New syncUsername(userId, newUsername) — single atomic writer
//     for BOTH public.users.username and public.profiles.username.
//     Fixes bug #15 (username drift). Returns { ok, message? }.
//   - getProfile now selects email + is_guest.
//   - ensureUserRow no longer overwrites a profile username that
//     already exists (defers to profiles as authoritative).
//   - New setProfileGuestStatus(userId, isGuest, email?) — used after
//     link-email to flip is_guest = false and store the email.
//
// Uses the SERVICE_ROLE key — the server is trusted. Never ship this
// key to the client.

'use strict';

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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
// Stats shape
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
    opponentsPlayed: [],
    dailyWinDates: [],
    masterWins: { rookie: 0, tactician: 0, hunter: 0, grandmaster: 0 },
  };
}

function emptyMasterWins() {
  return { rookie: 0, tactician: 0, hunter: 0, grandmaster: 0 };
}

function rowToStats(row) {
  if (!row) return createEmptyStats();

  const out = createEmptyStats();

  for (const k of Object.keys(out)) {
    if (k === 'opponentsPlayed' || k === 'dailyWinDates' || k === 'masterWins') {
      continue;
    }
    if (typeof row[k] === 'number') out[k] = row[k];
  }

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
// Users
// ────────────────────────────────────────────────────────────
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
    return false;
  }
  return !data || data.length === 0;
}

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

async function updateUserAvatar(userId, avatar) {
  if (!userId || !avatar) return false;

  const { error } = await supabase
    .from('users')
    .update({ avatar, updatedAt: Date.now() })
    .eq('userId', userId);

  if (error) {
    console.error('[DB] updateUserAvatar error:', error.message);
    return false;
  }
  return true;
}

async function ensureUserRow(uid, { username, avatar } = {}) {
  if (!uid) return null;

  const existing = await getUserById(uid);
  if (existing) {
    if (avatar && avatar !== existing.avatar) {
      await updateUserAvatar(uid, avatar);
      existing.avatar = avatar;
    }
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
// Profiles
// ────────────────────────────────────────────────────────────
//
// Chat 12a — getProfile now selects email + is_guest.
//
// Fields:
//   id            uuid PK → auth.users.id
//   username      text (nullable)
//   avatar        text (nullable)
//   is_premium    bool
//   premium_since timestamptz
//   email         text (nullable) — null for guests, filled for members
//   is_guest      bool — true until the account is linked
//   created_at    timestamptz
//   updated_at    timestamptz
async function getProfile(uid) {
  if (!uid) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, username, avatar, is_premium, premium_since, email, is_guest, created_at, updated_at'
    )
    .eq('id', uid)
    .maybeSingle();

  if (error) {
    console.error('[DB] getProfile error:', error.message);
    return null;
  }
  return data || null;
}

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

// Chat 12a — atomic username sync.
//
// Writes `username` to BOTH public.users and public.profiles. Returns
// { ok: boolean, message?: string }.
//
// Semantics:
//   * Both writes are attempted. If either fails, we return
//     ok: false with a message. The caller (changeUsername handler)
//     reports the failure to the user.
//   * profiles.username is treated as the authoritative copy when
//     detecting drift on identify — see server.js identify.
//   * Order: profiles first, then users. If profiles succeeds and
//     users fails, profiles is briefly ahead. On next identify,
//     profiles wins. Acceptable for our scale; both are idempotent.
async function syncUsername(userId, newUsername) {
  if (!userId || !newUsername) {
    return { ok: false, message: 'Missing userId or username' };
  }

  const normalized = String(newUsername).trim();
  if (!normalized) {
    return { ok: false, message: 'Empty username' };
  }

  const now = Date.now();

  const { error: profErr } = await supabase
    .from('profiles')
    .update({ username: normalized })
    .eq('id', userId);

  if (profErr) {
    console.error('[DB] syncUsername profiles error:', profErr.message);
    return { ok: false, message: 'Could not update profile' };
  }

  const { error: userErr } = await supabase
    .from('users')
    .update({ username: normalized, updatedAt: now })
    .eq('userId', userId);

  if (userErr) {
    console.error('[DB] syncUsername users error:', userErr.message);
    return { ok: false, message: 'Could not update account' };
  }

  return { ok: true };
}

// Chat 12a — case-insensitive email lookup by username.
//
// Used by the resolveEmailFromUsername socket event so a user can
// sign in with either their email or their username.
//
// Returns the email string, or null if:
//   * the username does not exist
//   * the profile has no email (i.e. it is a guest)
//
// The caller (server.js) never differentiates between these two
// cases when replying to the client — both become 'not_found',
// which the client renders as "Invalid credentials".
async function getEmailByUsername(username) {
  if (!username || typeof username !== 'string') return null;

  const normalized = username.trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('email, is_guest')
    .ilike('username', normalized)
    .maybeSingle();

  if (error) {
    console.error('[DB] getEmailByUsername error:', error.message);
    return null;
  }
  if (!data) return null;
  if (data.is_guest === true) return null;
  if (!data.email) return null;

  return data.email;
}

// Chat 12a — mark a profile as a member (or guest).
//
// Called after link-email succeeds so profiles.email is stored and
// is_guest flips to false. Also used by future flows (e.g. email
// change) to keep profiles in sync.
async function setProfileGuestStatus(userId, isGuest, email) {
  if (!userId) return false;

  const patch = { is_guest: !!isGuest };
  if (email !== undefined) {
    patch.email = email || null;
  }

  const { error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', userId);

  if (error) {
    console.error('[DB] setProfileGuestStatus error:', error.message);
    return false;
  }
  return true;
}

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
// deleteUserEverywhere
// ────────────────────────────────────────────────────────────
async function deleteUserEverywhere(uid) {
  if (!uid) return false;

  // Best-effort: remove the user from any tournament they are in or
  // host. tournament_rounds cascade-deletes when the tournament row
  // is deleted. A live tournament they host will simply end; the
  // in-memory engine in server.js handles the same case via
  // handleDisconnect.
  try {
    const { data: hosted } = await supabase
      .from('tournaments')
      .select('id')
      .eq('hostId', uid);

    if (Array.isArray(hosted) && hosted.length > 0) {
      const ids = hosted.map((r) => r.id);
      await supabase.from('tournaments').delete().in('id', ids);
    }

    const { data: joined } = await supabase
      .from('tournaments')
      .select('id, players')
      .contains('players', [uid]);

    if (Array.isArray(joined)) {
      for (const row of joined) {
        const next = (row.players || []).filter((p) => p !== uid);
        await supabase
          .from('tournaments')
          .update({ players: next })
          .eq('id', row.id);
      }
    }
  } catch (e) {
    console.error('[DB] deleteUserEverywhere tournament cleanup:', e?.message);
  }

  const { error: pubErr } = await supabase
    .from('users')
    .delete()
    .eq('userId', uid);

  if (pubErr) {
    console.error('[DB] deleteUserEverywhere public.users error:', pubErr.message);
    return false;
  }

  const { error: authErr } = await supabase.auth.admin.deleteUser(uid);
  if (authErr) {
    console.error('[DB] deleteUserEverywhere auth.admin error:', authErr.message);
    return true;
  }

  return true;
}

// ────────────────────────────────────────────────────────────
// Legacy migration
// ────────────────────────────────────────────────────────────
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

async function migrateLegacyUser(oldUserId, legacyToken) {
  if (!oldUserId) return null;

  const legacy = await getUserById(oldUserId);
  if (!legacy) {
    console.error('[DB] migrateLegacyUser: no public.users row for', oldUserId);
    return null;
  }

  const syntheticEmail = `legacy+${oldUserId}@rps-arena.local`;
  const randomPassword = crypto.randomBytes(32).toString('hex');

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
      return null;
    }
  }

  const { error: avatarsErr } = await supabase
    .from('avatars')
    .update({ userId: newUid })
    .eq('userId', oldUserId);

  if (avatarsErr) {
    console.error('[DB] migrateLegacyUser avatars rewrite error:', avatarsErr.message);
  }

  // Chat 11: rewrite tournaments.hostId, players[] and colorMap keys.
  // tournament_rounds.matches jsonb is NOT rewritten — if a legacy user
  // was mid-tournament, old rounds will show stale userIds. Logged for
  // a follow-up chat.
  try {
    const { data: hostedTournaments } = await supabase
      .from('tournaments')
      .select('id')
      .eq('hostId', oldUserId);

    if (Array.isArray(hostedTournaments)) {
      for (const t of hostedTournaments) {
        await supabase
          .from('tournaments')
          .update({ hostId: newUid })
          .eq('id', t.id);
      }
    }

    const { data: joinedTournaments } = await supabase
      .from('tournaments')
      .select('id, players, colorMap')
      .contains('players', [oldUserId]);

    if (Array.isArray(joinedTournaments)) {
      for (const t of joinedTournaments) {
        const nextPlayers = (t.players || []).map((p) =>
          p === oldUserId ? newUid : p
        );
        const oldColorMap = t.colorMap || {};
        const nextColorMap = { ...oldColorMap };
        if (Object.prototype.hasOwnProperty.call(nextColorMap, oldUserId)) {
          nextColorMap[newUid] = nextColorMap[oldUserId];
          delete nextColorMap[oldUserId];
        }
        await supabase
          .from('tournaments')
          .update({ players: nextPlayers, colorMap: nextColorMap })
          .eq('id', t.id);
      }
    }
  } catch (e) {
    console.error('[DB] migrateLegacyUser tournaments rewrite error:', e?.message);
  }

  const { error: delOldErr } = await supabase
    .from('users')
    .delete()
    .eq('userId', oldUserId);

  if (delOldErr) {
    console.error('[DB] migrateLegacyUser old users delete error:', delOldErr.message);
  }

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

async function saveStats(userId, stats) {
  if (!userId) return null;

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
    console.error('[DB] saveStats error:', error.message, '| userId:', userId);
    return null;
  }

  const { data, error: readErr } = await supabase
    .from('player_stats')
    .select('*')
    .eq('userId', userId)
    .maybeSingle();

  if (readErr || !data) {
    console.error(
      '[DB] saveStats read-back failed:',
      readErr?.message,
      '| userId:',
      userId
    );
    return null;
  }

  return rowToStats(data);
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

// ════════════════════════════════════════════════════════════
// AVATARS
// ════════════════════════════════════════════════════════════

const DEFAULT_PERSONALITY = {
  aggression: 0.5,
  memory: 0.5,
  randomness: 0.5,
  defense: 0.5,
};

function rowToAvatar(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    emoji: row.emoji,
    personality: row.personality || { ...DEFAULT_PERSONALITY },
    rating: typeof row.rating === 'number' ? row.rating : 1000,
    level: typeof row.level === 'number' ? row.level : 1,
    xp: typeof row.xp === 'number' ? row.xp : 0,
    wins: typeof row.wins === 'number' ? row.wins : 0,
    losses: typeof row.losses === 'number' ? row.losses : 0,
    ties: typeof row.ties === 'number' ? row.ties : 0,
    winStreak: typeof row.win_streak === 'number' ? row.win_streak : 0,
    bestStreak: typeof row.best_streak === 'number' ? row.best_streak : 0,
    titles: Array.isArray(row.titles) ? row.titles : [],
    defeatedMasters: Array.isArray(row.defeated_masters)
      ? row.defeated_masters
      : [],
    isSelected: !!row.is_selected,
    imageUrl: row.image_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listAvatars(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from('avatars')
    .select('*')
    .eq('userId', userId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[DB] listAvatars error:', error.message);
    return [];
  }

  return (data || []).map(rowToAvatar).filter(Boolean);
}

async function getSelectedAvatar(userId) {
  if (!userId) return null;

  const { data, error } = await supabase
    .from('avatars')
    .select('*')
    .eq('userId', userId)
    .eq('is_selected', true)
    .maybeSingle();

  if (error) {
    console.error('[DB] getSelectedAvatar error:', error.message);
    return null;
  }
  return data ? rowToAvatar(data) : null;
}

// Create an avatar.
//
// CHAT 9d FIX: the server generates its own UUID for `id`. The client's
// proposed id is ignored — AvatarEngine produces non-UUID strings that
// Postgres rejects.
//
// Auto-selects if this is the user's first avatar. Returns the created
// avatar, or null on failure.
async function createAvatar(userId, avatar) {
  if (!userId) return null;

  const { count, error: countErr } = await supabase
    .from('avatars')
    .select('id', { count: 'exact', head: true })
    .eq('userId', userId);

  if (countErr) {
    console.error('[DB] createAvatar count error:', countErr.message);
  }

  const isFirst = (count || 0) === 0;

  const row = {
    id: crypto.randomUUID(),   // ← FIX: server-generated UUID
    userId,
    name: avatar?.name || 'Champion',
    emoji: avatar?.emoji || '🤖',
    personality: avatar?.personality || { ...DEFAULT_PERSONALITY },
    rating: typeof avatar?.rating === 'number' ? avatar.rating : 1000,
    level: typeof avatar?.level === 'number' ? avatar.level : 1,
    xp: typeof avatar?.xp === 'number' ? avatar.xp : 0,
    wins: 0,
    losses: 0,
    ties: 0,
    win_streak: 0,
    best_streak: 0,
    titles: Array.isArray(avatar?.titles) ? avatar.titles : [],
    defeated_masters: Array.isArray(avatar?.defeatedMasters)
      ? avatar.defeatedMasters
      : [],
    is_selected: isFirst,
    image_url: avatar?.imageUrl || null,
  };

  const { data, error } = await supabase
    .from('avatars')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] createAvatar error:', error.message);
    return null;
  }

  return rowToAvatar(data);
}

// Idempotent default-avatar factory.
// Creates one 🤖 avatar for the given user if they have zero avatars.
// Returns the created avatar (or null if no-op / failure).
async function createDefaultAvatarForUser(uid, name) {
  if (!uid) return null;

  const { count, error: countErr } = await supabase
    .from('avatars')
    .select('id', { count: 'exact', head: true })
    .eq('userId', uid);

  if (countErr) {
    console.error('[DB] createDefaultAvatarForUser count error:', countErr.message);
    return null;
  }

  if ((count || 0) > 0) {
    // Already has avatars. Nothing to do.
    return null;
  }

  const safeName = (name && String(name).trim()) || 'Guest';

  const row = {
    id: crypto.randomUUID(),
    userId: uid,
    name: safeName.slice(0, 20),
    emoji: '🤖',
    personality: { ...DEFAULT_PERSONALITY },
    rating: 1000,
    level: 1,
    xp: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    win_streak: 0,
    best_streak: 0,
    titles: [],
    defeated_masters: [],
    is_selected: true,
    image_url: null,
  };

  const { data, error } = await supabase
    .from('avatars')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] createDefaultAvatarForUser insert error:', error.message);
    return null;
  }

  console.log('[DB] default avatar created for', uid, '→', safeName);
  return rowToAvatar(data);
}

// If the user has exactly one avatar whose name is 'Guest' or 'Player',
// rename it to newName. No-op in every other case.
//
// Chat 12a: also recognizes names matching the 'Guest_XXXX' placeholder
// pattern produced by the handle_new_user trigger.
//
// Returns true if a rename happened, false otherwise.
async function renameDefaultAvatarIfNeeded(uid, newName) {
  if (!uid || !newName) return false;

  const { data: avatars, error } = await supabase
    .from('avatars')
    .select('id, name')
    .eq('userId', uid);

  if (error) {
    console.error('[DB] renameDefaultAvatarIfNeeded select error:', error.message);
    return false;
  }

  if (!avatars || avatars.length !== 1) return false;

  const only = avatars[0];
  const currentName = (only.name || '').trim();
  const isPlaceholder =
    currentName === 'Guest' ||
    currentName === 'Player' ||
    /^Guest_\d{4}$/i.test(currentName);

  if (!isPlaceholder) return false;

  const safeName = String(newName).trim().slice(0, 20);
  if (!safeName) return false;

  const { error: updErr } = await supabase
    .from('avatars')
    .update({ name: safeName })
    .eq('id', only.id)
    .eq('userId', uid);

  if (updErr) {
    console.error('[DB] renameDefaultAvatarIfNeeded update error:', updErr.message);
    return false;
  }

  console.log('[DB] renamed default avatar for', uid, '→', safeName);
  return true;
}

async function updateAvatar(userId, avatarId, patch) {
  if (!userId || !avatarId) return null;

  const update = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.emoji !== undefined) update.emoji = patch.emoji;
  if (patch.personality !== undefined) update.personality = patch.personality;
  if (patch.rating !== undefined) update.rating = patch.rating;
  if (patch.level !== undefined) update.level = patch.level;
  if (patch.xp !== undefined) update.xp = patch.xp;
  if (patch.titles !== undefined) update.titles = patch.titles;
  if (patch.winStreak !== undefined) update.win_streak = patch.winStreak;
  if (patch.bestStreak !== undefined) update.best_streak = patch.bestStreak;
  if (patch.defeatedMasters !== undefined) {
    update.defeated_masters = patch.defeatedMasters;
  }
  if (patch.imageUrl !== undefined) update.image_url = patch.imageUrl;

  if (Object.keys(update).length === 0) {
    const { data } = await supabase
      .from('avatars')
      .select('*')
      .eq('id', avatarId)
      .eq('userId', userId)
      .maybeSingle();
    return data ? rowToAvatar(data) : null;
  }

  const { data, error } = await supabase
    .from('avatars')
    .update(update)
    .eq('id', avatarId)
    .eq('userId', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[DB] updateAvatar error:', error.message);
    return null;
  }
  return data ? rowToAvatar(data) : null;
}

async function deleteAvatar(userId, avatarId) {
  if (!userId || !avatarId) return { deleted: false, newSelectedId: null };

  const { data: target, error: selErr } = await supabase
    .from('avatars')
    .select('id, is_selected')
    .eq('id', avatarId)
    .eq('userId', userId)
    .maybeSingle();

  if (selErr) {
    console.error('[DB] deleteAvatar select error:', selErr.message);
    return { deleted: false, newSelectedId: null };
  }
  if (!target) {
    return { deleted: false, newSelectedId: null };
  }

  const wasSelected = !!target.is_selected;

  const { error: delErr } = await supabase
    .from('avatars')
    .delete()
    .eq('id', avatarId)
    .eq('userId', userId);

  if (delErr) {
    console.error('[DB] deleteAvatar delete error:', delErr.message);
    return { deleted: false, newSelectedId: null };
  }

  let newSelectedId = null;
  if (wasSelected) {
    const { data: next } = await supabase
      .from('avatars')
      .select('id')
      .eq('userId', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (next?.id) {
      await supabase
        .from('avatars')
        .update({ is_selected: true })
        .eq('id', next.id)
        .eq('userId', userId);
      newSelectedId = next.id;
    }
  }

  return { deleted: true, newSelectedId };
}

async function selectAvatar(userId, avatarId) {
  if (!userId || !avatarId) return null;

  const { error: unsetErr } = await supabase
    .from('avatars')
    .update({ is_selected: false })
    .eq('userId', userId);

  if (unsetErr) {
    console.error('[DB] selectAvatar unset error:', unsetErr.message);
    return null;
  }

  const { data, error } = await supabase
    .from('avatars')
    .update({ is_selected: true })
    .eq('id', avatarId)
    .eq('userId', userId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[DB] selectAvatar set error:', error.message);
    return null;
  }
  return data ? rowToAvatar(data) : null;
}

async function recordAvatarResult(userId, avatarId, won) {
  if (!userId || !avatarId) return false;

  const { data: current, error: readErr } = await supabase
    .from('avatars')
    .select('wins, losses, ties, win_streak, best_streak')
    .eq('id', avatarId)
    .eq('userId', userId)
    .maybeSingle();

  if (readErr || !current) {
    console.error('[DB] recordAvatarResult read error:', readErr?.message);
    return false;
  }

  const wins = (current.wins || 0) + (won ? 1 : 0);
  const losses = (current.losses || 0) + (won ? 0 : 1);
  const newWinStreak = won ? (current.win_streak || 0) + 1 : 0;
  const newBestStreak = Math.max(current.best_streak || 0, newWinStreak);

  const { error: writeErr } = await supabase
    .from('avatars')
    .update({
      wins,
      losses,
      win_streak: newWinStreak,
      best_streak: newBestStreak,
    })
    .eq('id', avatarId)
    .eq('userId', userId);

  if (writeErr) {
    console.error('[DB] recordAvatarResult write error:', writeErr.message);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Avatar level (mirrors avatarStore.calculateLevelLocal)
// ────────────────────────────────────────────────────────────
//
// Kept in sync with the client's calculateLevelLocal so server-written
// `level` matches what the client would compute from `xp`. If the
// client table ever changes, update both. Logged as a maintenance
// coupling in PROJECT_STATE.md.
const AVATAR_LEVELS = [0, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];

function calculateAvatarLevel(xp) {
  const safe = typeof xp === 'number' && Number.isFinite(xp) ? xp : 0;
  for (let i = AVATAR_LEVELS.length - 1; i >= 0; i--) {
    if (safe >= AVATAR_LEVELS[i]) return i + 1;
  }
  return 1;
}

// ────────────────────────────────────────────────────────────
// Tournament rewards (Chat 11)
// ────────────────────────────────────────────────────────────
//
// Applies STEP 5 rewards to the user's SELECTED avatar:
//   champion:      +50 rating, +500 XP, "Tournament Champion" title
//   runner-up:     +25 rating, +250 XP
//   semifinalist:  +10 rating, +100 XP
//   participant:   +50 XP
//
// Rating is floored at 0. XP is floored at 0. Level is recomputed
// from XP using AVATAR_LEVELS. Titles are deduped.
//
// Returns the refreshed avatar list (Array<ServerAvatar>) so the
// caller can emit the existing `avatars` event, or null on failure.
async function awardTournamentRewards(userId, opts = {}) {
  if (!userId) return null;

  const ratingDelta = Number.isFinite(opts.ratingDelta) ? opts.ratingDelta : 0;
  const xpDelta = Number.isFinite(opts.xpDelta) ? opts.xpDelta : 0;
  const title = typeof opts.title === 'string' && opts.title.trim()
    ? opts.title.trim()
    : null;

  const selected = await getSelectedAvatar(userId);

  // Fallback: if the user somehow has no selected avatar, pick the
  // first one via listAvatars. If they have none at all, ensure a
  // default avatar exists first.
  let avatar = selected;
  if (!avatar) {
    let avatars = await listAvatars(userId);
    if (!avatars || avatars.length === 0) {
      await createDefaultAvatarForUser(userId, 'Player');
      avatars = await listAvatars(userId);
    }
    avatar = avatars[0] || null;
  }

  if (!avatar) {
    console.error('[DB] awardTournamentRewards: no avatar for', userId);
    return null;
  }

  const newRating = Math.max(0, (avatar.rating || 0) + ratingDelta);
  const newXP = Math.max(0, (avatar.xp || 0) + xpDelta);
  const newLevel = calculateAvatarLevel(newXP);

  let newTitles = Array.isArray(avatar.titles) ? [...avatar.titles] : [];
  if (title && !newTitles.includes(title)) {
    newTitles = [...newTitles, title];
    if (newTitles.length > 25) {
      // Cap to avoid unbounded growth; keep most recent.
      newTitles = newTitles.slice(newTitles.length - 25);
    }
  }

  const updated = await updateAvatar(userId, avatar.id, {
    rating: newRating,
    xp: newXP,
    level: newLevel,
    titles: newTitles,
  });

  if (!updated) {
    console.error('[DB] awardTournamentRewards update failed for', userId);
    return null;
  }

  console.log(
    '[DB] tournament rewards →', userId,
    `rating ${avatar.rating}→${newRating}`,
    `xp ${avatar.xp}→${newXP}`,
    `level ${avatar.level}→${newLevel}`,
    title ? `title +"${title}"` : ''
  );

  const avatars = await listAvatars(userId);
  return avatars;
}

// ────────────────────────────────────────────────────────────
// Tournaments (Chat 11)
// ────────────────────────────────────────────────────────────

function rowToTournament(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    hostId: row.hostId,
    type: row.type,
    maxPlayers: row.maxPlayers,
    winTarget: row.winTarget,
    autoAdvance: !!row.autoAdvance,
    name: row.name || null,
    isPrivate: !!row.isPrivate,
    status: row.status,
    currentRound: row.currentRound || 0,
    colorMap: row.colorMap && typeof row.colorMap === 'object' ? row.colorMap : {},
    players: Array.isArray(row.players) ? row.players : [],
    winnerId: row.winnerId || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createTournament({
  code,
  hostId,
  type,
  maxPlayers,
  winTarget,
  autoAdvance,
  name,
  isPrivate,
}) {
  if (!code || !hostId) return null;

  const row = {
    code,
    hostId,
    type,
    maxPlayers,
    winTarget,
    autoAdvance: autoAdvance !== undefined ? !!autoAdvance : true,
    name: name || null,
    isPrivate: isPrivate !== undefined ? !!isPrivate : true,
    status: 'lobby',
    currentRound: 0,
    colorMap: {},
    players: [hostId],
  };

  const { data, error } = await supabase
    .from('tournaments')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] createTournament error:', error.message);
    return null;
  }
  return rowToTournament(data);
}

async function getTournamentById(id) {
  if (!id) return null;

  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[DB] getTournamentById error:', error.message);
    return null;
  }
  return data ? rowToTournament(data) : null;
}

async function getTournamentByCode(code) {
  if (!code) return null;

  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (error) {
    console.error('[DB] getTournamentByCode error:', error.message);
    return null;
  }
  return data ? rowToTournament(data) : null;
}

async function listPublicTournaments() {
  const { data, error } = await supabase
    .from('tournaments')
    .select('*')
    .eq('isPrivate', false)
    .eq('status', 'lobby')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('[DB] listPublicTournaments error:', error.message);
    return [];
  }
  return (data || []).map(rowToTournament);
}

async function updateTournament(id, patch) {
  if (!id || !patch) return null;

  const update = {};
  if (patch.hostId !== undefined) update.hostId = patch.hostId;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.currentRound !== undefined) update.currentRound = patch.currentRound;
  if (patch.colorMap !== undefined) update.colorMap = patch.colorMap;
  if (patch.players !== undefined) update.players = patch.players;
  if (patch.winnerId !== undefined) update.winnerId = patch.winnerId;
  if (patch.name !== undefined) update.name = patch.name;

  if (Object.keys(update).length === 0) {
    return getTournamentById(id);
  }

  const { data, error } = await supabase
    .from('tournaments')
    .update(update)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[DB] updateTournament error:', error.message);
    return null;
  }
  return data ? rowToTournament(data) : null;
}

async function deleteTournament(id) {
  if (!id) return false;

  const { error } = await supabase
    .from('tournaments')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('[DB] deleteTournament error:', error.message);
    return false;
  }
  return true;
}

// ────────────────────────────────────────────────────────────
// Tournament rounds (Chat 11)
// ────────────────────────────────────────────────────────────

function rowToTournamentRound(row) {
  if (!row) return null;
  return {
    id: row.id,
    tournamentId: row.tournamentId,
    roundNumber: row.roundNumber,
    matches: Array.isArray(row.matches) ? row.matches : [],
    bye: row.bye || null,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

async function createTournamentRound({
  tournamentId,
  roundNumber,
  matches,
  bye,
  status,
}) {
  if (!tournamentId || !roundNumber) return null;

  const row = {
    tournamentId,
    roundNumber,
    matches: Array.isArray(matches) ? matches : [],
    bye: bye || null,
    status: status || 'pending',
  };

  const { data, error } = await supabase
    .from('tournament_rounds')
    .insert(row)
    .select('*')
    .single();

  if (error) {
    console.error('[DB] createTournamentRound error:', error.message);
    return null;
  }
  return rowToTournamentRound(data);
}

async function getTournamentRound(tournamentId, roundNumber) {
  if (!tournamentId || !roundNumber) return null;

  const { data, error } = await supabase
    .from('tournament_rounds')
    .select('*')
    .eq('tournamentId', tournamentId)
    .eq('roundNumber', roundNumber)
    .maybeSingle();

  if (error) {
    console.error('[DB] getTournamentRound error:', error.message);
    return null;
  }
  return data ? rowToTournamentRound(data) : null;
}

async function listTournamentRounds(tournamentId) {
  if (!tournamentId) return [];

  const { data, error } = await supabase
    .from('tournament_rounds')
    .select('*')
    .eq('tournamentId', tournamentId)
    .order('roundNumber', { ascending: true });

  if (error) {
    console.error('[DB] listTournamentRounds error:', error.message);
    return [];
  }
  return (data || []).map(rowToTournamentRound);
}

async function updateTournamentRound(
  tournamentId,
  roundNumber,
  patch
) {
  if (!tournamentId || !roundNumber || !patch) return null;

  const update = {};
  if (patch.matches !== undefined) update.matches = patch.matches;
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.bye !== undefined) update.bye = patch.bye;
  if (patch.startedAt !== undefined) {
    update.started_at = patch.startedAt;
  }
  if (patch.completedAt !== undefined) {
    update.completed_at = patch.completedAt;
  }

  if (Object.keys(update).length === 0) {
    return getTournamentRound(tournamentId, roundNumber);
  }

  const { data, error } = await supabase
    .from('tournament_rounds')
    .update(update)
    .eq('tournamentId', tournamentId)
    .eq('roundNumber', roundNumber)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('[DB] updateTournamentRound error:', error.message);
    return null;
  }
  return data ? rowToTournamentRound(data) : null;
}

// ────────────────────────────────────────────────────────────
// ACHIEVEMENTS
// ────────────────────────────────────────────────────────────

const ACHIEVEMENT_CATALOG = [
  { id: 'first_win',         name: 'First Win',         icon: '🥇', category: 'progression', rule: 'wins >= 1',            description: 'Win your first match.' },
  { id: 'ten_wins',          name: 'Getting Started',   icon: '🎯', category: 'progression', rule: 'wins >= 10',           description: 'Win 10 matches.' },
  { id: 'fifty_wins',        name: 'Half Century',      icon: '🏅', category: 'progression', rule: 'wins >= 50',           description: 'Win 50 matches.' },
  { id: 'hundred_wins',      name: 'Century Club',      icon: '💯', category: 'progression', rule: 'wins >= 100',          description: 'Win 100 matches.' },
  { id: 'five_hundred_wins', name: 'Legend',            icon: '👑', category: 'progression', rule: 'wins >= 500',          description: 'Win 500 matches.' },

  { id: 'streak_5',          name: 'On Fire',           icon: '🔥', category: 'streaks',     rule: 'bestStreak >= 5',      description: 'Win 5 matches in a row.' },
  { id: 'streak_10',         name: 'Unstoppable',       icon: '⚡', category: 'streaks',     rule: 'bestStreak >= 10',     description: 'Win 10 matches in a row.' },
  { id: 'streak_20',         name: 'Immortal',          icon: '♾️', category: 'streaks',     rule: 'bestStreak >= 20',     description: 'Win 20 matches in a row.' },
  { id: 'perfect_week',      name: 'Perfect Week',      icon: '📅', category: 'streaks',     rule: 'won a match 7 days in a row', description: 'Win at least one match every day for 7 days.' },

  { id: 'human_champ',       name: "People's Champion", icon: '👥', category: 'mode',        rule: 'humanWins >= 10',      description: 'Win 10 Human vs Human matches.' },
  { id: 'avatar_champ',      name: 'Arena Champion',    icon: '🎭', category: 'mode',        rule: 'avatarWins >= 10',     description: 'Win 10 Avatar Arena matches.' },
  { id: 'dojo_master',       name: 'Dojo Master',       icon: '🥋', category: 'mode',        rule: 'dojoWins >= 10',       description: 'Win 10 AI Dojo matches.' },
  { id: 'all_rounder',       name: 'All-Rounder',       icon: '🎲', category: 'mode',        rule: 'won at least 1 in each mode (human, avatar, dojo)', description: 'Win at least one match in every mode.' },
  { id: 'mode_specialist',   name: 'Mode Specialist',   icon: '🎪', category: 'mode',        rule: '100 wins in any single mode', description: 'Win 100 matches in a single mode.' },
  { id: 'jack_of_all_trades',name: 'Jack of All Trades',icon: '🃏', category: 'mode',        rule: '50 wins in each mode', description: 'Win 50 matches in every mode.' },

  { id: 'grandmaster_slayer',name: 'Grandmaster Slayer',icon: '🐉', category: 'dojo',        rule: 'beat Grandmaster at least once', description: 'Defeat the Grandmaster.' },
  { id: 'dojo_sweeper',      name: 'Dojo Sweeper',      icon: '🧹', category: 'dojo',        rule: 'beat all 4 masters (Rookie, Tactician, Hunter, Grandmaster)', description: 'Defeat every dojo master at least once.' },
  { id: 'rookie_killer',     name: 'Rookie Killer',     icon: '🐣', category: 'dojo',        rule: 'beat Rookie 10 times', description: 'Defeat the Rookie 10 times.' },
  { id: 'hunter_survivor',   name: 'Hunter Survivor',   icon: '🏹', category: 'dojo',        rule: 'beat Hunter 5 times',  description: 'Defeat the Hunter 5 times.' },

  { id: 'veteran',           name: 'Veteran',           icon: '🎖️', category: 'volume',      rule: 'total matches >= 100', description: 'Play 100 matches.' },
  { id: 'grinder',           name: 'Grinder',           icon: '⚙️', category: 'volume',      rule: 'total matches >= 500', description: 'Play 500 matches.' },
  { id: 'addict',            name: 'Addict',            icon: '🧠', category: 'volume',      rule: 'total matches >= 1000',description: 'Play 1000 matches.' },

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
  const minModeWins = Math.min(...modeWinCounts, 0);

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
  updateUserAvatar,
  ensureUserRow,

  // profiles
  getProfile,
  updateProfileUsername,
  setPremium,

  // profiles (Chat 12a)
  syncUsername,
  getEmailByUsername,
  setProfileGuestStatus,

  // deletion
  deleteUserEverywhere,

  // legacy migration
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

  // avatars
  listAvatars,
  getSelectedAvatar,
  createAvatar,
  updateAvatar,
  deleteAvatar,
  selectAvatar,
  recordAvatarResult,

  // avatars (Chat 9d)
  createDefaultAvatarForUser,
  renameDefaultAvatarIfNeeded,

  // avatars (Chat 11)
  calculateAvatarLevel,
  awardTournamentRewards,

  // tournaments (Chat 11)
  createTournament,
  getTournamentById,
  getTournamentByCode,
  listPublicTournaments,
  updateTournament,
  deleteTournament,

  // tournament rounds (Chat 11)
  createTournamentRound,
  getTournamentRound,
  listTournamentRounds,
  updateTournamentRound,

  // achievements
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_BY_ID,
  checkAchievements,
  getUnlockedMap,
  resolveMasterId,
  dateKey,
  evaluateRules,
};