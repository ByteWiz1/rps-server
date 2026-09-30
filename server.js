// rps-server/server.js
//
// RPS Arena — Node.js + Express + Socket.IO server.
//
// Chat 1: tokens. Chat 2: adaptive AI. Chat 4: Supabase.
// Chat 5: Dojo stats sync. Chat 7: achievements.
// Chat 9: Supabase Auth migration.
// Chat 9b: avatars, profiles-driven identify, avatar W/L on match end.
// Chat 9c: ES256-only JWT verification via Supabase JWKS (jose).
// Chat 9d:
//   - identify auto-creates a default avatar for users with zero.
//   - identify + changeUsername rename a lone "Guest"/"Player" avatar
//     to the user's chosen name.
//   - New checkUsernameAvailability socket event for signup.
// Chat 11 — Tournament Mode.
// Chat 11 — Tournament Mode bug fix pass:
//   B1  emitMatchAssigned moved from beginRound into closeActiveWindow.
//       The match screen only opens AFTER the Active window closes for
//       surviving players. Previously both clients were navigated to
//       the match immediately and never saw the Active button.
//   B2  closeActiveWindow now cancels the room for any match affected
//       by elimination, emits matchCancelled to the room so both
//       clients navigate away.
//   B3  pressActive early-close now checks that every currently-active
//       player is in the activeSet, not just a size comparison.
//   B4  checkRoundComplete has an idempotency guard.
//   B5  onMatchProgress early-returns if the match is already complete.
//   B6  _handleParticipantGone only fires on real socket disconnect or
//       an explicit leave, not on every match-screen unmount. The
//       unmount path no longer emits leaveRoom for tournament rooms.
//   B9  roundStarted emitted exactly once per round (was emitted twice:
//       once in beginRound and once in openActiveWindow).
//   B11 Rooms are notified on every walkover path (disconnect + active
//       timeout + leave).
//   B16 BYE players are auto-added to activeSet so they survive the
//       Active check.
//   B21 winTarget is server-authoritative. The client no longer sends
//       it in createRoom, and the server no longer honors a client
//       override. Both clients read winTarget from roomState.
//   B22 publicState includes a usernames map. Populated on identify,
//       on join, and on start. Every client screen reads from it.
//
// Preserved constants: AVATAR_ROUND_DELAY = 2000, WIN_TARGET = 30,
//   MAX_HISTORY = 20, MAX_RECENT_MOVES = 5, DISCONNECT_TIMEOUT = 20000,
//   INVITE_TIMEOUT = 5 min.

const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } = require('jose');
const { createAdaptiveAI } = require('./aiEngine');
const db = require('./db');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Env ───
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  console.error(
    '[SERVER] Missing SUPABASE_URL. Set it on Render ' +
    '(Supabase dashboard → Settings → API → Project URL).'
  );
}

if (!SUPABASE_ANON_KEY) {
  console.error(
    '[SERVER] Missing SUPABASE_ANON_KEY. Set it on Render ' +
    '(Supabase dashboard → Settings → API → anon public key). ' +
    'Required for the JWKS fetch.'
  );
}

// ─── Supabase JWKS (ES256 verification) ───
const SUPABASE_JWKS_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
  : null;

let jwks = null;
if (SUPABASE_JWKS_URL && SUPABASE_ANON_KEY) {
  jwks = createRemoteJWKSet(new URL(SUPABASE_JWKS_URL), {
    headers: { apikey: SUPABASE_ANON_KEY },
    cooldownDuration: 10_000,
    cacheMaxAge: 10 * 60 * 1000,
  });
  console.log('[JWT] JWKS configured:', SUPABASE_JWKS_URL);
} else {
  console.warn(
    '[JWT] JWKS not configured. All authenticated sockets will be rejected.'
  );
}

// ─── In-memory state ───
const rooms = new Map();
const players = new Map();
const onlinePlayers = new Map();
const activeInvites = new Map();
const recentOpponents = new Map();

// Chat 11 — tournament state (in-memory mirror).
// tournaments: tournamentId → tournament state object
// tournamentCodes: code → tournamentId
const tournaments = new Map();
const tournamentCodes = new Map();

// ─── Constants ───
const WIN_TARGET = 30;
const DISCONNECT_TIMEOUT = 20000;
const INVITE_TIMEOUT = 5 * 60 * 1000;
const AVATAR_ROUND_DELAY = 2000;    // MUST stay 2000
const MAX_RECENT_MOVES = 5;

// Chat 11 — tournament constants
const ACTIVE_WINDOW_MS = 90 * 1000;      // 90s per STEP 5
const ACTIVE_TICK_MS = 1000;              // 1s countdown updates
const TOURNAMENT_CODE_LEN = 6;            // STEP 6
const TOURNAMENT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const TOURNAMENT_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
  '#f43f5e', '#fb7185', '#fdba74', '#fcd34d',
  '#bef264', '#86efac', '#6ee7b7', '#5eead4',
  '#67e8f9', '#7dd3fc', '#93c5fd', '#a5b4fc',
  '#c4b5fd', '#d8b4fe', '#f0abfc', '#fbcfe8',
];

// ─── Small helpers ───

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function generateTournamentCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(TOURNAMENT_CODE_LEN);
    for (let i = 0; i < TOURNAMENT_CODE_LEN; i++) {
      code += TOURNAMENT_CODE_ALPHABET[bytes[i] % TOURNAMENT_CODE_ALPHABET.length];
    }
    if (!tournamentCodes.has(code)) return code;
  }
  return ('T' + Date.now().toString(36)).slice(0, TOURNAMENT_CODE_LEN).toUpperCase();
}

function normalizeUsername(name) {
  return (name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

async function isUsernameAvailable(name, exceptUserId) {
  const normalized = normalizeUsername(name);
  if (!normalized) return false;

  for (const [, player] of onlinePlayers) {
    if (player.username === normalized && player.userId !== exceptUserId) {
      return false;
    }
  }

  const dbFree = await db.isUsernameAvailable(normalized, exceptUserId);
  return dbFree;
}

async function generateUniqueUsername(baseName, exceptUserId) {
  let name = baseName;
  let counter = 1;
  while (!(await isUsernameAvailable(name, exceptUserId))) {
    name = `${baseName}${counter}`;
    counter++;
    if (counter > 100) {
      name = `${baseName}${Math.floor(Math.random() * 9999)}`;
      break;
    }
  }
  return name;
}

function getRoomPlayers(room) {
  return room.players.map((id) => {
    const p = players.get(id);
    return {
      id,
      name: p?.name || 'Player',
      userId: p?.userId || null,
    };
  });
}

function setPlayerStatus(socketId, status) {
  if (!socketId) return;
  const entry = onlinePlayers.get(socketId);
  if (!entry) return;
  if (entry.status === status) return;
  entry.status = status;
  broadcastOnlineUsers();
  console.log('[STATUS]', socketId, '→', status);
}

function pushRecentMove(room, playerId, move) {
  if (!room || !playerId || !move) return;
  if (!room.recentMoves) room.recentMoves = {};
  const list = room.recentMoves[playerId] || [];
  list.push(move);
  room.recentMoves[playerId] = list.slice(-MAX_RECENT_MOVES);
}

function resetRecentMoves(room) {
  if (!room) return;
  room.recentMoves = {};
  room.players.forEach((id) => {
    room.recentMoves[id] = [];
  });
}

function buildRecentMovesPayload(room) {
  if (!room || !room.recentMoves) return {};
  const payload = {};
  room.players.forEach((id) => {
    payload[id] = room.recentMoves[id] || [];
  });
  return payload;
}

function resetRoomScores(room) {
  room.players.forEach((id) => {
    room.scores[id] = 0;
    room.ties[id] = 0;
  });
  room.moves = {};
  room.round = 0;
  room.matchOver = false;
  room.winner = null;
  resetRecentMoves(room);
}

function broadcastRoomState(room) {
  const playerList = getRoomPlayers(room);
  io.to(room.code).emit('roomState', {
    players: playerList,
    scores: room.scores,
    ties: room.ties,
    round: room.round,
    matchOver: room.matchOver,
    winner: room.winner,
    winTarget: room.winTarget ?? WIN_TARGET,
    recentMoves: buildRecentMovesPayload(room),
  });
}

function broadcastOnlineUsers() {
  const users = [];
  for (const [socketId, player] of onlinePlayers) {
    users.push({
      userId: player.userId,
      name: player.name,
      username: player.username,
      avatar: player.avatar,
      status: player.status,
      socketId,
    });
  }
  io.emit('onlineUsers', { users });
}

function broadcastOnlineCount() {
  io.emit('onlineCount', { count: onlinePlayers.size });
}

function resetPlayersToOnline(room) {
  if (!room) return;
  let changed = false;
  room.players.forEach((id) => {
    const entry = onlinePlayers.get(id);
    if (entry && entry.status !== 'online') {
      entry.status = 'online';
      changed = true;
      console.log('[STATUS]', id, '→ online (bulk)');
    }
  });
  if (changed) {
    broadcastOnlineUsers();
  }
}

function recordRecentOpponent(playerId, opponentId) {
  if (!playerId || !opponentId) return;
  const list = recentOpponents.get(playerId) || [];
  const filtered = list.filter((x) => x.id !== opponentId);
  const opponent = players.get(opponentId);
  if (opponent) {
    filtered.unshift({
      id: opponentId,
      name: opponent.name,
      lastPlayed: Date.now(),
    });
  }
  recentOpponents.set(playerId, filtered.slice(0, 5));
}

function resolveRound(move1, move2) {
  if (move1 === move2) return 'tie';
  const rules = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return rules[move1] === move2 ? 'p1' : 'p2';
}

// ─── AI state setup ───
function ensureAvatarAI(room) {
  if (!room || room.battleMode !== 'avatar') return;
  if (room.players.length < 2) return;

  const [p1, p2] = room.players;

  const p1Personality = room.avatarPersonalities?.[p1];
  const p2Personality = room.avatarPersonalities?.[p2];

  const p1Name = players.get(p1)?.name || 'Player 1';
  const p2Name = players.get(p2)?.name || 'Player 2';

  room.aiState = {
    [p1]: createAdaptiveAI(p1Name, p1Personality),
    [p2]: createAdaptiveAI(p2Name, p2Personality),
  };

  console.log(
    '[AI] Room', room.code, 'AI created |',
    p1Name, '→', room.aiState[p1].difficulty, room.aiState[p1].personality,
    '|', p2Name, '→', room.aiState[p2].difficulty, room.aiState[p2].personality,
  );
}

function clearAvatarAI(room) {
  if (!room) return;
  room.aiState = null;
}

// ─── Achievement emission helper ───
function emitAchievementsToSocket(socketId, unlocked) {
  if (!socketId || !Array.isArray(unlocked) || unlocked.length === 0) return;
  for (const a of unlocked) {
    io.to(socketId).emit('achievementUnlocked', {
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      category: a.category,
    });
  }
}

// ─── Tracking helpers ───
function trackOpponent(stats, opponentId) {
  if (!stats || !opponentId) return;
  if (!Array.isArray(stats.opponentsPlayed)) stats.opponentsPlayed = [];
  if (!stats.opponentsPlayed.includes(opponentId)) {
    stats.opponentsPlayed.push(opponentId);
  }
}

function trackDailyWin(stats) {
  if (!stats) return;
  if (!Array.isArray(stats.dailyWinDates)) stats.dailyWinDates = [];
  const key = db.dateKey(Date.now());
  if (!stats.dailyWinDates.includes(key)) {
    stats.dailyWinDates.push(key);
  }
}

function ensureMasterWins(stats) {
  if (!stats) return;
  if (!stats.masterWins || typeof stats.masterWins !== 'object') {
    stats.masterWins = { rookie: 0, tactician: 0, hunter: 0, grandmaster: 0 };
    return;
  }
  for (const k of ['rookie', 'tactician', 'hunter', 'grandmaster']) {
    if (typeof stats.masterWins[k] !== 'number') stats.masterWins[k] = 0;
  }
}

function trackMasterWin(stats, masterId) {
  if (!stats || !masterId) return;
  ensureMasterWins(stats);
  stats.masterWins[masterId] = (stats.masterWins[masterId] || 0) + 1;
}

// ─── Snapshot selected avatars at room start ───
async function snapshotRoomAvatars(room) {
  if (!room) return;
  room.avatarIds = {};

  for (const socketId of room.players) {
    const uid = onlinePlayers.get(socketId)?.userId || players.get(socketId)?.userId;
    if (!uid) continue;
    try {
      const selected = await db.getSelectedAvatar(uid);
      if (selected?.id) {
        room.avatarIds[socketId] = selected.id;
      }
    } catch (e) {
      console.error('[AVATAR SNAPSHOT] failed for', uid, e?.message);
    }
  }

  console.log(
    '[AVATAR SNAPSHOT] Room', room.code,
    '→', JSON.stringify(room.avatarIds)
  );
}

// ─── Match result recording (human / avatar rooms) ───
async function recordMatchResult(room) {
  if (!room || !room.winner) return;

  const [p1, p2] = room.players;
  if (!p1 || !p2) return;

  const p1UserId = onlinePlayers.get(p1)?.userId || players.get(p1)?.userId;
  const p2UserId = onlinePlayers.get(p2)?.userId || players.get(p2)?.userId;
  if (!p1UserId || !p2UserId) return;

  const p1Name = players.get(p1)?.name || 'Player 1';
  const p2Name = players.get(p2)?.name || 'Player 2';

  const p1Won = room.winner === p1;
  const p2Won = room.winner === p2;

  const mode = room.battleMode || 'human';
  const isHuman = mode === 'human';
  const isAvatar = mode === 'avatar';
  const isDojo = mode === 'dojo';

  const p1Score = room.scores[p1] || 0;
  const p2Score = room.scores[p2] || 0;
  const rounds = room.round;
  const timestamp = Date.now();

  await db.appendMatch(p1UserId, {
    mode: room.battleMode,
    opponent: p2Name,
    opponentId: p2UserId,
    result: p1Won ? 'win' : 'loss',
    myScore: p1Score,
    theirScore: p2Score,
    rounds,
    timestamp,
  });

  const p1Stats = await db.getOrCreateStats(p1UserId);
  if (p1Won) {
    p1Stats.wins++;
    p1Stats.currentStreak = (p1Stats.currentStreak || 0) + 1;
    if (p1Stats.currentStreak > (p1Stats.bestStreak || 0)) {
      p1Stats.bestStreak = p1Stats.currentStreak;
    }
  } else {
    p1Stats.losses++;
    p1Stats.currentStreak = 0;
  }
  p1Stats.total = p1Stats.wins + p1Stats.losses;

  if (isHuman) {
    if (p1Won) p1Stats.humanWins++;
    else p1Stats.humanLosses++;
  } else if (isAvatar) {
    if (p1Won) p1Stats.avatarWins++;
    else p1Stats.avatarLosses++;
  } else if (isDojo) {
    if (p1Won) p1Stats.dojoWins++;
    else p1Stats.dojoLosses++;
  }

  trackOpponent(p1Stats, p2UserId);
  if (p1Won) trackDailyWin(p1Stats);

  const p1Saved = await db.saveStats(p1UserId, p1Stats);
  if (!p1Saved) {
    console.error('[MATCH RECORD] P1 saveStats failed for', p1UserId);
  } else {
    console.log('[MATCH RECORD] P1 stats saved for', p1UserId, JSON.stringify({
      wins: p1Saved.wins, losses: p1Saved.losses, humanWins: p1Saved.humanWins,
      avatarWins: p1Saved.avatarWins, dojoWins: p1Saved.dojoWins,
    }));
  }

  await db.appendMatch(p2UserId, {
    mode: room.battleMode,
    opponent: p1Name,
    opponentId: p1UserId,
    result: p2Won ? 'win' : 'loss',
    myScore: p2Score,
    theirScore: p1Score,
    rounds,
    timestamp,
  });

  const p2Stats = await db.getOrCreateStats(p2UserId);
  if (p2Won) {
    p2Stats.wins++;
    p2Stats.currentStreak = (p2Stats.currentStreak || 0) + 1;
    if (p2Stats.currentStreak > (p2Stats.bestStreak || 0)) {
      p2Stats.bestStreak = p2Stats.currentStreak;
    }
  } else {
    p2Stats.losses++;
    p2Stats.currentStreak = 0;
  }
  p2Stats.total = p2Stats.wins + p2Stats.losses;

  if (isHuman) {
    if (p2Won) p2Stats.humanWins++;
    else p2Stats.humanLosses++;
  } else if (isAvatar) {
    if (p2Won) p2Stats.avatarWins++;
    else p2Stats.avatarLosses++;
  } else if (isDojo) {
    if (p2Won) p2Stats.dojoWins++;
    else p2Stats.dojoLosses++;
  }

  trackOpponent(p2Stats, p1UserId);
  if (p2Won) trackDailyWin(p2Stats);

  const p2Saved = await db.saveStats(p2UserId, p2Stats);
  if (!p2Saved) {
    console.error('[MATCH RECORD] P2 saveStats failed for', p2UserId);
  } else {
    console.log('[MATCH RECORD] P2 stats saved for', p2UserId, JSON.stringify({
      wins: p2Saved.wins, losses: p2Saved.losses, humanWins: p2Saved.humanWins,
      avatarWins: p2Saved.avatarWins, dojoWins: p2Saved.dojoWins,
    }));
  }

  if (p1Saved) io.to(p1).emit('playerStats', { stats: p1Saved });
  if (p2Saved) io.to(p2).emit('playerStats', { stats: p2Saved });

  console.log('[MATCH RECORDED]', p1Name, 'vs', p2Name, '→ winner:',
    room.winner === p1 ? p1Name : p2Name, `(${mode})`);

  if (room.avatarIds) {
    const p1AvatarId = room.avatarIds[p1];
    const p2AvatarId = room.avatarIds[p2];

    if (p1AvatarId) {
      db.recordAvatarResult(p1UserId, p1AvatarId, p1Won).then((ok) => {
        if (ok) console.log('[AVATAR STAT] P1 avatar', p1AvatarId, p1Won ? 'W' : 'L');
      }).catch((e) => console.error('[AVATAR STAT] P1 failed:', e?.message));
    }
    if (p2AvatarId) {
      db.recordAvatarResult(p2UserId, p2AvatarId, p2Won).then((ok) => {
        if (ok) console.log('[AVATAR STAT] P2 avatar', p2AvatarId, p2Won ? 'W' : 'L');
      }).catch((e) => console.error('[AVATAR STAT] P2 failed:', e?.message));
    }
  }

  try {
    const p1Unlocked = await db.checkAchievements(p1UserId);
    emitAchievementsToSocket(p1, p1Unlocked);
  } catch (e) {
    console.error('[ACHIEVEMENTS] P1 check failed:', e?.message || e);
  }

  try {
    const p2Unlocked = await db.checkAchievements(p2UserId);
    emitAchievementsToSocket(p2, p2Unlocked);
  } catch (e) {
    console.error('[ACHIEVEMENTS] P2 check failed:', e?.message || e);
  }
}

// ─── Dojo match recording ───
async function recordDojoMatchResult(userId, payload) {
  if (!userId) return null;

  const result = payload?.result;
  if (result !== 'win' && result !== 'loss' && result !== 'tie') {
    console.log('[DOJO MATCH] invalid result:', result, '| payload:', JSON.stringify(payload));
    return null;
  }

  const opponentName = String(payload?.opponentName || 'Master').slice(0, 40);
  const myScore = Math.max(0, Math.min(9999, Math.floor(Number(payload?.myScore) || 0)));
  const opponentScore = Math.max(0, Math.min(9999, Math.floor(Number(payload?.opponentScore) || 0)));
  const rounds = Math.max(0, Math.min(9999, Math.floor(Number(payload?.rounds) || 0)));
  const timestamp = Date.now();

  await db.appendMatch(userId, {
    mode: 'dojo',
    opponent: opponentName,
    opponentId: null,
    result,
    myScore,
    theirScore: opponentScore,
    rounds,
    timestamp,
  });

  const stats = await db.getOrCreateStats(userId);

  if (result === 'win') {
    stats.wins++;
    stats.dojoWins++;
    stats.currentStreak = (stats.currentStreak || 0) + 1;
    if (stats.currentStreak > (stats.bestStreak || 0)) {
      stats.bestStreak = stats.currentStreak;
    }
  } else if (result === 'loss') {
    stats.losses++;
    stats.dojoLosses++;
    stats.currentStreak = 0;
  } else {
    stats.ties++;
    stats.dojoTies++;
  }

  stats.total = stats.wins + stats.losses;

  if (result === 'win') {
    trackDailyWin(stats);
    const masterId = db.resolveMasterId(opponentName);
    if (masterId) trackMasterWin(stats, masterId);
  }

  const saved = await db.saveStats(userId, stats);

  console.log(
    '[DOJO MATCH] userId=', userId,
    'result=', result,
    'newStats=', JSON.stringify({
      wins: saved?.wins,
      losses: saved?.losses,
      ties: saved?.ties,
      total: saved?.total,
      dojoWins: saved?.dojoWins,
      dojoLosses: saved?.dojoLosses,
      dojoTies: saved?.dojoTies,
      currentStreak: saved?.currentStreak,
      bestStreak: saved?.bestStreak,
      saveOk: !!saved,
    })
  );

  if (!saved) {
    console.error('[DOJO MATCH] saveStats FAILED for', userId);
    return null;
  }

  console.log(
    '[DOJO RECORDED]', userId, 'vs', opponentName,
    '→', result, `(${myScore}-${opponentScore}, ${rounds} rounds)`,
  );

  let unlocked = [];
  try {
    unlocked = await db.checkAchievements(userId);
  } catch (e) {
    console.error('[ACHIEVEMENTS] dojo check failed:', e?.message || e);
  }

  return { stats: saved, unlocked };
}

// ─── Leaderboard ───
function buildLeaderboardEntry(row) {
  const total = row.total || 0;
  const winRate = total > 0 ? row.wins / total : 0;
  return {
    userId: row.userId,
    username: row.username,
    avatar: row.avatar,
    wins: row.wins || 0,
    losses: row.losses || 0,
    ties: row.ties || 0,
    winRate,
    bestStreak: row.bestStreak || 0,
    total,
  };
}

async function buildLeaderboard() {
  const rows = await db.listStatsWithUsers();
  const entries = rows.map(buildLeaderboardEntry);

  const topByWins = [...entries]
    .sort((a, b) => b.wins - a.wins || b.winRate - a.winRate)
    .slice(0, 20);

  const topByWinRate = [...entries]
    .filter((e) => e.total >= 5)
    .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)
    .slice(0, 20);

  const topByStreak = [...entries]
    .sort((a, b) => b.bestStreak - a.bestStreak || b.wins - a.wins)
    .slice(0, 20);

  return { topByWins, topByWinRate, topByStreak };
}

// ─── Avatar auto-play ───
function startAvatarAutoPlay(roomCode) {
  const room = rooms.get(roomCode);
  console.log('[AVATAR AUTO] Called for room', roomCode, '| battleMode:', room?.battleMode, '| players:', room?.players.length);
  if (!room) return;
  if (room.avatarAutoTimer) clearTimeout(room.avatarAutoTimer);
  if (room.matchOver) return;
  if (room.players.length < 2) {
    console.log('[AVATAR AUTO] Aborted — not enough players');
    return;
  }

  if (!room.aiState) {
    ensureAvatarAI(room);
  }

  const runRound = () => {
    const r = rooms.get(roomCode);
    if (!r) return;
    if (r.matchOver) return;
    if (r.players.length < 2) return;
    if (!r.aiState) {
      console.log('[AVATAR AUTO] No AI state — aborting round');
      return;
    }

    const [p1, p2] = r.players;

    const ai1 = r.aiState[p1];
    const ai2 = r.aiState[p2];
    if (!ai1 || !ai2) {
      console.log('[AVATAR AUTO] AI instance missing for a player — aborting');
      return;
    }

    const move1 = ai1.makeMove();
    const move2 = ai2.makeMove();

    ai1.recordOpponentMove(move2);
    ai2.recordOpponentMove(move1);

    io.to(roomCode).emit('playerMoved', { playerId: p1 });
    io.to(roomCode).emit('playerMoved', { playerId: p2 });

    const result = resolveRound(move1, move2);

    if (result === 'p1') {
      r.scores[p1]++;
      ai1.recordResult('win');
      ai2.recordResult('lose');
    } else if (result === 'p2') {
      r.scores[p2]++;
      ai2.recordResult('win');
      ai1.recordResult('lose');
    } else {
      r.ties[p1] = (r.ties[p1] || 0) + 1;
      r.ties[p2] = (r.ties[p2] || 0) + 1;
      ai1.recordResult('tie');
      ai2.recordResult('tie');
    }
    r.round++;

    pushRecentMove(r, p1, move1);
    pushRecentMove(r, p2, move2);

    let matchWinner = null;
    const target = r.winTarget ?? WIN_TARGET;
    if (r.scores[p1] >= target) matchWinner = p1;
    else if (r.scores[p2] >= target) matchWinner = p2;

    if (matchWinner) {
      r.matchOver = true;
      r.winner = matchWinner;
      recordMatchResult(r).catch((e) =>
        console.error('[MATCH RECORD ERROR]', e?.message)
      );
    }

    io.to(roomCode).emit('roundResult', {
      moves: { [p1]: move1, [p2]: move2 },
      result,
      scores: r.scores,
      ties: r.ties,
      round: r.round,
      matchOver: r.matchOver,
      matchWinner,
      winTarget: target,
      recentMoves: buildRecentMovesPayload(r),
    });

    if (r.tournamentId) {
      tournamentEngine.onMatchProgress(r).catch((e) =>
        console.error('[TOURNAMENT] onMatchProgress (auto) error:', e?.message)
      );
    }

    if (!r.matchOver) {
      r.avatarAutoTimer = setTimeout(runRound, AVATAR_ROUND_DELAY);
    } else {
      r.avatarAutoTimer = null;
    }
  };

  room.avatarAutoTimer = setTimeout(runRound, AVATAR_ROUND_DELAY);
  console.log('[AVATAR AUTO] Started for room', roomCode);
}

// ════════════════════════════════════════════════════════════════
// TOURNAMENT ENGINE (Chat 11) — bug-fix pass
// ════════════════════════════════════════════════════════════════
//
// Round lifecycle (post-fix):
//   1. beginRound: create rooms, emit roundStarted once, open Active.
//      Do NOT emit matchAssigned. Clients stay on the bracket and
//      see the Active button.
//   2. Players press Active. When everyone alive has pressed, the
//      window closes early. Otherwise the 90s timer closes it.
//   3. closeActiveWindow: eliminate non-Active players, cancel their
//      rooms with matchCancelled, mark walkovers, then emit
//      matchAssigned to survivors' matches.
//   4. Survivors play. matchAssigned -> TournamentMatchScreen.
//   5. Match resolves -> onMatchProgress -> checkRoundComplete.
//   6. Round complete -> next round (auto or host-triggered).

const tournamentEngine = {
  // ────────────────────────────────────────────────────────
  // createTournament
  // ────────────────────────────────────────────────────────
  async create(userId, cfg) {
    if (!userId) return { error: 'Not authenticated' };

    const type = cfg?.type === 'avatar' ? 'avatar' : cfg?.type === 'human' ? 'human' : null;
    if (!type) return { error: 'Invalid type' };

    const maxPlayers = Math.floor(Number(cfg?.maxPlayers));
    if (!Number.isFinite(maxPlayers) || maxPlayers < 2 || maxPlayers > 32) {
      return { error: 'maxPlayers must be between 2 and 32' };
    }

    const winTarget = Math.floor(Number(cfg?.winTarget));
    if (!Number.isFinite(winTarget) || winTarget < 15 || winTarget > 30) {
      return { error: 'winTarget must be between 15 and 30' };
    }

    const autoAdvance = cfg?.autoAdvance !== undefined ? !!cfg.autoAdvance : true;
    const name = typeof cfg?.name === 'string' && cfg.name.trim()
      ? cfg.name.trim().slice(0, 40)
      : null;
    const isPrivate = cfg?.isPrivate !== undefined ? !!cfg.isPrivate : true;

    const code = generateTournamentCode();

    const row = await db.createTournament({
      code,
      hostId: userId,
      type,
      maxPlayers,
      winTarget,
      autoAdvance,
      name,
      isPrivate,
    });

    if (!row) return { error: 'Could not create tournament' };

    // Pre-populate the host's username.
    const usernames = {};
    usernames[userId] = this._lookupUsernameSync(userId) || 'Player';

    const state = {
      id: row.id,
      code: row.code,
      hostId: row.hostId,
      type: row.type,
      maxPlayers: row.maxPlayers,
      winTarget: row.winTarget,
      autoAdvance: row.autoAdvance,
      name: row.name,
      isPrivate: row.isPrivate,
      status: 'lobby',
      currentRound: 0,
      colorMap: {},
      players: [userId],
      winnerId: null,
      usernames,                    // B22
      createdAt: Date.now(),
      activeDeadline: null,
      activeTickHandle: null,
      activeSet: new Set(),
      rounds: [],
    };

    tournaments.set(state.id, state);
    tournamentCodes.set(state.code, state.id);

    console.log('[TOURNAMENT] created', state.id, state.code, 'by', userId, type, `max=${maxPlayers} win=${winTarget} auto=${autoAdvance}`);
    return { tournamentId: state.id, code: state.code };
  },

  // ────────────────────────────────────────────────────────
  // get / hydrate
  // ────────────────────────────────────────────────────────
  async get(tournamentId) {
    if (!tournamentId) return null;
    if (tournaments.has(tournamentId)) return tournaments.get(tournamentId);
    const row = await db.getTournamentById(tournamentId);
    if (!row) return null;
    if (row.status !== 'lobby') return null;
    const state = {
      id: row.id,
      code: row.code,
      hostId: row.hostId,
      type: row.type,
      maxPlayers: row.maxPlayers,
      winTarget: row.winTarget,
      autoAdvance: row.autoAdvance,
      name: row.name,
      isPrivate: row.isPrivate,
      status: 'lobby',
      currentRound: 0,
      colorMap: {},
      players: Array.isArray(row.players) ? [...row.players] : [],
      winnerId: null,
      usernames: {},
      createdAt: Date.now(),
      activeDeadline: null,
      activeTickHandle: null,
      activeSet: new Set(),
      rounds: [],
    };
    // Populate usernames from the DB for each known player.
    for (const uid of state.players) {
      const u = await db.getUserById(uid).catch(() => null);
      if (u?.username) state.usernames[uid] = u.username;
    }
    tournaments.set(state.id, state);
    tournamentCodes.set(state.code, state.id);
    return state;
  },

  async getByCode(code) {
    if (!code) return null;
    const upper = String(code).toUpperCase();
    const cachedId = tournamentCodes.get(upper);
    if (cachedId) return this.get(cachedId);
    const row = await db.getTournamentByCode(upper);
    if (!row) return null;
    if (row.status !== 'lobby') return null;
    return this.get(row.id);
  },

  // ────────────────────────────────────────────────────────
  // join
  // ────────────────────────────────────────────────────────
  async join(userId, code) {
    if (!userId) return { error: 'Not authenticated' };
    const state = await this.getByCode(code);
    if (!state) return { error: 'Tournament not found' };
    if (state.status !== 'lobby') {
      return { error: 'This tournament has already started' };
    }
    if (state.players.includes(userId)) {
      return { tournament: this.publicState(state), alreadyJoined: true };
    }
    if (state.players.length >= state.maxPlayers) {
      return { error: 'Tournament is full' };
    }
    state.players.push(userId);
    // B22: capture username for the joined user immediately.
    const uname = this._lookupUsernameSync(userId);
    if (uname) state.usernames[userId] = uname;
    await db.updateTournament(state.id, { players: state.players });
    return { tournament: this.publicState(state) };
  },

  // ────────────────────────────────────────────────────────
  // leave (lobby only)
  // ────────────────────────────────────────────────────────
  async leave(userId, tournamentId) {
    if (!userId || !tournamentId) return;
    const state = await this.get(tournamentId);
    if (!state) return;
    if (state.status !== 'lobby') return;

    if (!state.players.includes(userId)) return;
    state.players = state.players.filter((p) => p !== userId);
    await db.updateTournament(state.id, { players: state.players });

    if (state.hostId === userId && state.players.length > 0) {
      const nextHost = state.players[Math.floor(Math.random() * state.players.length)];
      state.hostId = nextHost;
      await db.updateTournament(state.id, { hostId: nextHost });
      io.to('tournament:' + state.id).emit('hostChanged', { newHostId: nextHost });
      console.log('[TOURNAMENT]', state.id, 'host promoted to', nextHost, '(host left lobby)');
    }
    if (state.players.length === 0) {
      tournaments.delete(state.id);
      tournamentCodes.delete(state.code);
      await db.deleteTournament(state.id);
    }
  },

  // ────────────────────────────────────────────────────────
  // start (host only)
  // ────────────────────────────────────────────────────────
  async start(userId, tournamentId) {
    if (!userId || !tournamentId) return { error: 'Not authenticated' };
    const state = await this.get(tournamentId);
    if (!state) return { error: 'Tournament not found' };
    if (state.hostId !== userId) return { error: 'Only the host can start' };
    if (state.status !== 'lobby') return { error: 'Tournament already started' };
    if (state.players.length < 2) return { error: 'Need at least 2 players' };
    if (state.players.length > state.maxPlayers) return { error: 'Too many players' };

    state.colorMap = this.assignColors(state.players);

    // B22: refresh every player's username before the tournament goes live.
    for (const uid of state.players) {
      if (!state.usernames[uid]) {
        const uname = this._lookupUsernameSync(uid);
        if (uname) state.usernames[uid] = uname;
        else {
          const u = await db.getUserById(uid).catch(() => null);
          if (u?.username) state.usernames[uid] = u.username;
        }
      }
    }

    state.status = 'live';
    state.currentRound = 0;

    await db.updateTournament(state.id, {
      status: 'live',
      colorMap: state.colorMap,
    });

    io.to('tournament:' + state.id).emit('tournamentStarted', {
      colorMap: state.colorMap,
    });

    await this.beginRound(state);
    return { ok: true };
  },

  // ────────────────────────────────────────────────────────
  // beginNextRound (host only, !autoAdvance)
  // ────────────────────────────────────────────────────────
  async beginNextRound(userId, tournamentId) {
    if (!userId || !tournamentId) return { error: 'Not authenticated' };
    const state = await this.get(tournamentId);
    if (!state) return { error: 'Tournament not found' };
    if (state.hostId !== userId) return { error: 'Only the host can begin a round' };
    if (state.status !== 'live') return { error: 'Tournament not live' };
    if (state.autoAdvance) return { error: 'This tournament auto-advances' };

    const last = state.rounds[state.rounds.length - 1];
    if (last && last.status !== 'complete') {
      return { error: 'Previous round is still in progress' };
    }
    if (state.pendingNextRound) {
      return { error: 'Round already starting' };
    }

    await this.beginRound(state);
    return { ok: true };
  },

  // ────────────────────────────────────────────────────────
  // beginRound
  //
  // FIXES:
  //   B1  no emitMatchAssigned here — moved to closeActiveWindow.
  //   B9  roundStarted emitted exactly once (in openActiveWindow).
  //   B16 BYE players auto-added to activeSet in openActiveWindow.
  // ────────────────────────────────────────────────────────
  async beginRound(state) {
    if (!state) return;

    const activePlayers = [...state.players];

    if (activePlayers.length === 0) {
      console.error('[TOURNAMENT]', state.id, 'beginRound with 0 players');
      return;
    }
    if (activePlayers.length === 1) {
      await this.finishTournament(state, activePlayers[0]);
      return;
    }

    const roundNumber = state.currentRound + 1;
    state.currentRound = roundNumber;
    state.activeSet = new Set();

    const shuffled = this.shuffle([...activePlayers]);
    const matches = [];
    let bye = null;

    for (let i = 0; i < shuffled.length; i += 2) {
      if (i + 1 < shuffled.length) {
        const p1 = shuffled[i];
        const p2 = shuffled[i + 1];
        const matchId = crypto.randomUUID();
        const roomCode = generateRoomCode();
        matches.push({
          matchId,
          p1,
          p2,
          roomCode,
          winner: null,
          status: 'pending',
          scores: { p1: 0, p2: 0, round: 0 },
        });
      } else {
        bye = shuffled[i];
      }
    }

    const round = {
      roundNumber,
      matches,
      bye,
      status: 'pending',
      startedAt: Date.now(),
      completedAt: null,
      _completing: false,        // B4 idempotency flag
    };
    state.rounds.push(round);

    await db.updateTournament(state.id, { currentRound: roundNumber });
    await db.createTournamentRound({
      tournamentId: state.id,
      roundNumber,
      matches: matches.map((m) => ({
        matchId: m.matchId,
        p1: m.p1,
        p2: m.p2,
        roomCode: m.roomCode,
        winner: null,
        status: 'pending',
        scores: { p1: 0, p2: 0, round: 0 },
      })),
      bye,
      status: 'pending',
    });

    // Pre-create rooms so clients can join them later.
    for (const m of matches) {
      this.createTournamentRoom(state, m);
    }

    // Broadcast state so clients see the round shape (colour-coded, etc.)
    this.broadcastState(state);

    // Open the Active window (this emits roundStarted once).
    this.openActiveWindow(state, round);

    console.log(
      '[TOURNAMENT]', state.id, 'round', roundNumber, 'started —',
      matches.length, 'matches,', bye ? `BYE for ${bye}` : 'no BYE'
    );
  },

  // ────────────────────────────────────────────────────────
  // createTournamentRoom
  // ────────────────────────────────────────────────────────
  createTournamentRoom(state, match) {
    const roomCode = match.roomCode;
    if (!roomCode) return;
    if (rooms.has(roomCode)) return;

    const room = {
      code: roomCode,
      players: [],
      moves: {},
      scores: {},
      ties: {},
      round: 0,
      matchOver: false,
      winner: null,
      disconnectTimer: null,
      disconnectedPlayer: null,
      battleMode: state.type === 'avatar' ? 'avatar' : 'human',
      avatarAutoTimer: null,
      recentMoves: {},
      avatarPersonalities: {},
      avatarIds: {},
      aiState: null,
      tournamentId: state.id,
      tournamentMatchId: match.matchId,
      winTarget: state.winTarget,
    };
    rooms.set(roomCode, room);
    console.log('[TOURNAMENT] pre-created room', roomCode, 'for match', match.matchId);
  },

  // ────────────────────────────────────────────────────────
  // openActiveWindow
  // ────────────────────────────────────────────────────────
  openActiveWindow(state, round) {
    if (state.activeTickHandle) {
      clearInterval(state.activeTickHandle);
      state.activeTickHandle = null;
    }
    state.activeDeadline = Date.now() + ACTIVE_WINDOW_MS;

    round.status = 'active';
    db.updateTournamentRound(state.id, round.roundNumber, {
      status: 'active',
      startedAt: round.startedAt,
    }).catch(() => {});

    // B16: BYE player is auto-considered Active for this round.
    if (round.bye) {
      state.activeSet.add(round.bye);
      io.to('tournament:' + state.id).emit('playerActive', {
        userId: round.bye,
        color: state.colorMap[round.bye] || null,
      });
    }

    // Emit roundStarted ONCE (B9).
    io.to('tournament:' + state.id).emit('roundStarted', {
      roundNumber: round.roundNumber,
      bye: round.bye,
      matches: round.matches.map((m) => ({
        matchId: m.matchId,
        p1: m.p1,
        p2: m.p2,
        roomCode: m.roomCode,
        status: m.status,
      })),
      activeWindowMs: ACTIVE_WINDOW_MS,
    });

    const tick = () => {
      const secondsLeft = Math.max(0, Math.ceil((state.activeDeadline - Date.now()) / 1000));
      io.to('tournament:' + state.id).emit('activeWindowUpdate', { secondsLeft });
      if (secondsLeft <= 0) {
        this.closeActiveWindow(state, round).catch((e) =>
          console.error('[TOURNAMENT] closeActiveWindow error:', e?.message)
        );
      }
    };

    tick();
    state.activeTickHandle = setInterval(tick, ACTIVE_TICK_MS);
  },

  // ────────────────────────────────────────────────────────
  // closeActiveWindow
  //
  // FIXES:
  //   B2  cancel rooms for eliminated players, emit matchCancelled.
  //   B11 walkover notification to affected rooms.
  //   B1  emit matchAssigned only for survivors.
  // ────────────────────────────────────────────────────────
  async closeActiveWindow(state, round) {
    if (!round) return;
    if (round._closing) return;
    round._closing = true;

    if (state.activeTickHandle) {
      clearInterval(state.activeTickHandle);
      state.activeTickHandle = null;
    }
    state.activeDeadline = null;

    // Who didn't press Active?
    const eliminated = [];
    for (const userId of state.players) {
      if (!state.activeSet.has(userId)) {
        eliminated.push(userId);
      }
    }

    for (const userId of eliminated) {
      io.to('tournament:' + state.id).emit('playerInactive', {
        userId,
        reason: 'timeout',
      });
      console.log('[TOURNAMENT]', state.id, 'eliminated', userId, '(did not press Active)');
    }

    for (const userId of eliminated) {
      state.players = state.players.filter((p) => p !== userId);
    }

    if (round.bye && !state.players.includes(round.bye)) {
      round.bye = null;
    }

    // Mark matches: walkovers for eliminated players, cancelling the
    // underlying room if it exists.
    for (const m of round.matches) {
      if (m.status === 'complete') continue;
      const p1Alive = state.players.includes(m.p1);
      const p2Alive = state.players.includes(m.p2);
      if (p1Alive && p2Alive) continue;

      if (!p1Alive && !p2Alive) {
        m.status = 'complete';
        m.winner = null;
      } else if (!p1Alive) {
        m.status = 'complete';
        m.winner = m.p2;
      } else {
        m.status = 'complete';
        m.winner = m.p1;
      }

      // Cancel the room so clients navigate away (B2, B11).
      this._cancelTournamentRoom(m, m.winner, 'active-timeout');
    }

    this.broadcastState(state);

    if (state.players.length <= 1) {
      await this.finishTournament(state, state.players[0] || null);
      return;
    }

    // B1: emit matchAssigned to survivors' matches only. Matches that
    // were already completed as walkovers never had their players
    // navigated to a match screen — that's correct, they advance.
    for (const m of round.matches) {
      if (m.status !== 'pending') continue;
      this.emitMatchAssigned(state, m);
    }

    this.broadcastScores(state, round);
    await this.checkRoundComplete(state, round);
  },

  // ────────────────────────────────────────────────────────
  // pressActive
  //
  // FIXES:
  //   B3  early-close checks every currently-in player.
  // ────────────────────────────────────────────────────────
  async pressActive(userId, tournamentId) {
    if (!userId || !tournamentId) return { error: 'Not authenticated' };
    const state = await this.get(tournamentId);
    if (!state) return { error: 'Tournament not found' };
    if (state.status !== 'live') return { error: 'Tournament not live' };
    if (!state.players.includes(userId)) return { error: 'Not a participant' };
    const round = state.rounds[state.rounds.length - 1];
    if (!round) return { error: 'No active round' };
    if (round.status !== 'active') return { error: 'Active window is closed' };
    if (state.activeSet.has(userId)) return { ok: true };

    state.activeSet.add(userId);
    const color = state.colorMap[userId] || null;

    io.to('tournament:' + state.id).emit('playerActive', { userId, color });
    this.broadcastState(state);

    // B3: check every CURRENT player is Active, not just a size compare.
    const allActive = state.players.every((p) => state.activeSet.has(p));
    if (allActive) {
      await this.closeActiveWindow(state, round);
    }

    return { ok: true };
  },

  // ────────────────────────────────────────────────────────
  // onMatchReady
  // ────────────────────────────────────────────────────────
  async onMatchReady(room) {
    if (!room || !room.tournamentId || !room.tournamentMatchId) return;
    const state = await this.get(room.tournamentId);
    if (!state) return;
    const round = state.rounds[state.rounds.length - 1];
    if (!round) return;
    const m = round.matches.find((x) => x.matchId === room.tournamentMatchId);
    if (!m) return;
    if (m.status === 'active') return;

    m.status = 'active';
    this.broadcastScores(state, round);
  },

  // ────────────────────────────────────────────────────────
  // onMatchProgress
  //
  // FIXES:
  //   B5  early-return if the match is already complete.
  // ────────────────────────────────────────────────────────
  async onMatchProgress(room) {
    if (!room || !room.tournamentId || !room.tournamentMatchId) return;
    const state = await this.get(room.tournamentId);
    if (!state) return;
    const round = state.rounds[state.rounds.length - 1];
    if (!round) return;
    const m = round.matches.find((x) => x.matchId === room.tournamentMatchId);
    if (!m) return;
    if (m.status === 'complete') return;    // B5

    const [p1Socket, p2Socket] = room.players;
    const p1UserId = onlinePlayers.get(p1Socket)?.userId || players.get(p1Socket)?.userId;
    const p2UserId = onlinePlayers.get(p2Socket)?.userId || players.get(p2Socket)?.userId;

    if (p1UserId === m.p1) {
      m.scores.p1 = room.scores[p1Socket] || 0;
      m.scores.p2 = room.scores[p2Socket] || 0;
    } else if (p2UserId === m.p1) {
      m.scores.p1 = room.scores[p2Socket] || 0;
      m.scores.p2 = room.scores[p1Socket] || 0;
    }
    m.scores.round = room.round;

    if (room.matchOver && room.winner) {
      const winnerSocket = room.winner;
      const winnerUserId =
        onlinePlayers.get(winnerSocket)?.userId ||
        players.get(winnerSocket)?.userId ||
        null;
      m.winner = winnerUserId;
      m.status = 'complete';
    }

    this.broadcastScores(state, round);
    await this.persistRound(state, round);

    if (m.status === 'complete') {
      await this.checkRoundComplete(state, round);
    }
  },

  // ────────────────────────────────────────────────────────
  // onPlayerDisconnect / onPlayerLeave
  //
  // FIXES:
  //   B6  Distinguish disconnect from intentional leave. Only fires
  //       for genuine socket loss or an explicit leaveTournament.
  //       The unmount of TournamentMatchScreen no longer triggers
  //       a tournament removal.
  //   B11 Room is cancelled with matchCancelled so both clients can
  //       navigate away.
  // ────────────────────────────────────────────────────────
  async onPlayerDisconnect(socketId) {
    const uid = onlinePlayers.get(socketId)?.userId ||
                players.get(socketId)?.userId ||
                null;
    if (!uid) return;
    await this._handleParticipantGone(uid, socketId, 'disconnected');
  },

  async onPlayerLeave(socketId) {
    // B6: this is only called from handleLeave with notify=true,
    // meaning the user explicitly tapped a leave button. Screen
    // unmount does NOT route here anymore.
    const uid = onlinePlayers.get(socketId)?.userId ||
                players.get(socketId)?.userId ||
                null;
    if (!uid) return;
    await this._handleParticipantGone(uid, socketId, 'left');
  },

  async _handleParticipantGone(userId, socketId, reason) {
    let state = null;
    for (const [, t] of tournaments) {
      if (t.players.includes(userId)) { state = t; break; }
    }
    if (!state) return;

    io.to('tournament:' + state.id).emit('playerInactive', { userId, reason });

    state.players = state.players.filter((p) => p !== userId);

    if (state.hostId === userId && state.players.length > 0) {
      const nextHost = state.players[Math.floor(Math.random() * state.players.length)];
      state.hostId = nextHost;
      db.updateTournament(state.id, { hostId: nextHost }).catch(() => {});
      io.to('tournament:' + state.id).emit('hostChanged', { newHostId: nextHost });
      console.log('[TOURNAMENT]', state.id, 'host promoted to', nextHost, `(${reason})`);
    }

    const round = state.rounds[state.rounds.length - 1];
    if (round && round.status !== 'complete') {
      for (const m of round.matches) {
        if (m.status === 'complete') continue;
        if (m.p1 === userId && m.p2 !== userId) {
          m.winner = m.p2;
          m.status = 'complete';
          this._cancelTournamentRoom(m, m.p2, reason);
        } else if (m.p2 === userId && m.p1 !== userId) {
          m.winner = m.p1;
          m.status = 'complete';
          this._cancelTournamentRoom(m, m.p1, reason);
        }
      }
      this.broadcastScores(state, round);
      await this.persistRound(state, round);
    }

    this.broadcastState(state);

    if (state.players.length <= 1) {
      await this.finishTournament(state, state.players[0] || null);
      return;
    }
    if (round) await this.checkRoundComplete(state, round);
  },

  // ────────────────────────────────────────────────────────
  // _cancelTournamentRoom
  //
  // B2, B11: End a room whose tournament match is no longer live.
  // Emits matchCancelled so clients on the match screen navigate away.
  // ────────────────────────────────────────────────────────
  _cancelTournamentRoom(match, winnerUserId, reason) {
    if (!match || !match.roomCode) return;
    const room = rooms.get(match.roomCode);
    if (!room) return;
    if (room.matchOver) return;

    room.matchOver = true;

    // Determine the winner socket for the room, if any.
    let winnerSocket = null;
    if (winnerUserId) {
      for (const sid of room.players) {
        const uid = onlinePlayers.get(sid)?.userId || players.get(sid)?.userId;
        if (uid === winnerUserId) { winnerSocket = sid; break; }
      }
    }
    room.winner = winnerSocket;

    // Notify the room so both clients leave the match screen.
    io.to(room.code).emit('matchCancelled', {
      winnerId: winnerUserId || null,
      winnerSocketId: winnerSocket || null,
      reason: reason || 'walkover',
    });

    // Clean up AI timers if any.
    if (room.avatarAutoTimer) {
      clearTimeout(room.avatarAutoTimer);
      room.avatarAutoTimer = null;
    }
    clearAvatarAI(room);

    console.log('[TOURNAMENT] cancelled room', room.code, '| winner:', winnerUserId || '(none)', '| reason:', reason);
  },

  // ────────────────────────────────────────────────────────
  // checkRoundComplete
  //
  // FIXES:
  //   B4  idempotency guard.
  // ────────────────────────────────────────────────────────
  async checkRoundComplete(state, round) {
    if (!round || round.status === 'complete') return;
    if (round._completing) return;
    round._completing = true;

    const allResolved = round.matches.every((m) => m.status === 'complete');
    if (!allResolved) {
      round._completing = false;
      return;
    }

    round.status = 'complete';
    round.completedAt = Date.now();

    const winners = [];
    for (const m of round.matches) {
      if (m.winner) winners.push(m.winner);
    }
    if (round.bye) winners.push(round.bye);

    state.players = Array.from(new Set(winners));

    await db.updateTournamentRound(state.id, round.roundNumber, {
      status: 'complete',
      completedAt: round.completedAt,
      matches: round.matches.map((m) => ({
        matchId: m.matchId,
        p1: m.p1,
        p2: m.p2,
        roomCode: m.roomCode,
        winner: m.winner,
        status: m.status,
        scores: m.scores,
      })),
    });

    io.to('tournament:' + state.id).emit('roundComplete', {
      roundNumber: round.roundNumber,
      winners,
      nextRound: state.players.length > 1 ? round.roundNumber + 1 : null,
    });

    this.broadcastState(state);

    if (state.players.length <= 1) {
      await this.finishTournament(state, state.players[0] || null);
      return;
    }

    if (state.autoAdvance) {
      state.pendingNextRound = true;
      setTimeout(() => {
        state.pendingNextRound = false;
        this.beginRound(state).catch((e) =>
          console.error('[TOURNAMENT] autoAdvance beginRound failed:', e?.message)
        );
      }, 4000);
    } else {
      state.pendingNextRound = false;
      console.log('[TOURNAMENT]', state.id, 'waiting for host to begin next round');
    }
  },

  // ────────────────────────────────────────────────────────
  // finishTournament
  // ────────────────────────────────────────────────────────
  async finishTournament(state, championUserId) {
    if (!state) return;
    if (state.status === 'finished') return;

    state.status = 'finished';
    state.winnerId = championUserId || null;

    await db.updateTournament(state.id, {
      status: 'finished',
      winnerId: championUserId || null,
    });

    const rewards = await this.applyRewards(state, championUserId);

    io.to('tournament:' + state.id).emit('tournamentComplete', {
      winnerId: championUserId || null,
      rewards,
    });

    console.log('[TOURNAMENT]', state.id, 'finished. champion =', championUserId);

    setTimeout(() => {
      tournaments.delete(state.id);
      tournamentCodes.delete(state.code);
    }, 10 * 60 * 1000);
  },

  // ────────────────────────────────────────────────────────
  // applyRewards — STEP 5 tiers.
  // ────────────────────────────────────────────────────────
  async applyRewards(state, championUserId) {
    const rewards = {};

    for (const userId of Object.keys(state.colorMap)) {
      rewards[userId] = { ratingDelta: 0, xpDelta: 50, title: null };
    }

    const rounds = state.rounds || [];
    if (rounds.length >= 2) {
      const semiRound = rounds[rounds.length - 2];
      const semiSet = new Set();
      for (const m of semiRound.matches) {
        if (m.p1) semiSet.add(m.p1);
        if (m.p2) semiSet.add(m.p2);
      }
      for (const userId of semiSet) {
        if (!rewards[userId]) rewards[userId] = { ratingDelta: 0, xpDelta: 50, title: null };
        rewards[userId].ratingDelta += 10;
        rewards[userId].xpDelta += 100;
      }
    }

    const finalRound = rounds[rounds.length - 1];
    if (finalRound && championUserId) {
      let runnerUpId = null;
      for (const m of finalRound.matches) {
        if (m.p1 === championUserId && m.p2) runnerUpId = m.p2;
        else if (m.p2 === championUserId && m.p1) runnerUpId = m.p1;
      }
      if (runnerUpId) {
        if (!rewards[runnerUpId]) rewards[runnerUpId] = { ratingDelta: 0, xpDelta: 50, title: null };
        rewards[runnerUpId].ratingDelta += 25;
        rewards[runnerUpId].xpDelta += 250;
      }
    }

    if (championUserId) {
      if (!rewards[championUserId]) rewards[championUserId] = { ratingDelta: 0, xpDelta: 50, title: null };
      rewards[championUserId].ratingDelta += 50;
      rewards[championUserId].xpDelta += 500;
      rewards[championUserId].title = 'Tournament Champion';
    }

    for (const [userId, r] of Object.entries(rewards)) {
      try {
        const avatars = await db.awardTournamentRewards(userId, {
          ratingDelta: r.ratingDelta,
          xpDelta: r.xpDelta,
          title: r.title,
        });
        if (Array.isArray(avatars)) {
          const sockets = this.socketsForUser(userId);
          for (const sid of sockets) {
            io.to(sid).emit('avatars', { avatars });
          }
        }
      } catch (e) {
        console.error('[TOURNAMENT] reward failed for', userId, e?.message);
      }
    }

    return rewards;
  },

  // ────────────────────────────────────────────────────────
  // broadcast helpers
  // ────────────────────────────────────────────────────────
  broadcastState(state) {
    if (!state) return;
    io.to('tournament:' + state.id).emit('tournamentState', this.publicState(state));
  },

  broadcastScores(state, round) {
    if (!state || !round) return;
    const payload = {};
    for (const m of round.matches) {
      payload[m.matchId] = {
        p1: m.p1,
        p2: m.p2,
        scores: m.scores,
        round: m.scores?.round || 0,
        status: m.status,
      };
    }
    io.to('tournament:' + state.id).emit('tournamentScoresUpdate', payload);
  },

  emitMatchAssigned(state, match) {
    const payload = {
      matchId: match.matchId,
      roomCode: match.roomCode,
    };
    const s1 = this.socketsForUser(match.p1);
    const s2 = this.socketsForUser(match.p2);
    for (const sid of s1) {
      io.to(sid).emit('matchAssigned', { ...payload, opponentUserId: match.p2 });
    }
    for (const sid of s2) {
      io.to(sid).emit('matchAssigned', { ...payload, opponentUserId: match.p1 });
    }
    console.log('[TOURNAMENT] matchAssigned', match.matchId, `(p1=${match.p1}, p2=${match.p2}, room=${match.roomCode})`);
  },

  socketsForUser(userId) {
    const out = [];
    for (const [socketId, entry] of onlinePlayers) {
      if (entry.userId === userId) out.push(socketId);
    }
    return out;
  },

  // ────────────────────────────────────────────────────────
  // helpers
  // ────────────────────────────────────────────────────────
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  assignColors(userIds) {
    const palette = this.shuffle(TOURNAMENT_COLORS);
    const map = {};
    userIds.forEach((uid, i) => {
      map[uid] = palette[i % palette.length];
    });
    return map;
  },

  async persistRound(state, round) {
    if (!state || !round) return;
    try {
      await db.updateTournamentRound(state.id, round.roundNumber, {
        matches: round.matches.map((m) => ({
          matchId: m.matchId,
          p1: m.p1,
          p2: m.p2,
          roomCode: m.roomCode,
          winner: m.winner,
          status: m.status,
          scores: m.scores,
        })),
        status: round.status,
      });
    } catch (e) {
      console.error('[TOURNAMENT] persistRound failed:', e?.message);
    }
  },

  // B22: best-effort username lookup from in-memory onlinePlayers.
  _lookupUsernameSync(userId) {
    if (!userId) return null;
    for (const [, entry] of onlinePlayers) {
      if (entry.userId === userId) return entry.username || entry.name || null;
    }
    return null;
  },

  publicState(state) {
    // B22: ensure the usernames map has an entry for every player we
    // know about. Cheap to build each broadcast.
    const usernames = { ...(state.usernames || {}) };
    for (const uid of state.players) {
      if (!usernames[uid]) {
        const uname = this._lookupUsernameSync(uid);
        if (uname) usernames[uid] = uname;
      }
    }

    return {
      id: state.id,
      code: state.code,
      hostId: state.hostId,
      type: state.type,
      maxPlayers: state.maxPlayers,
      winTarget: state.winTarget,
      autoAdvance: state.autoAdvance,
      name: state.name,
      isPrivate: state.isPrivate,
      status: state.status,
      currentRound: state.currentRound,
      colorMap: state.colorMap,
      players: state.players,
      winnerId: state.winnerId,
      usernames,                     // B22
      activeUserIds: Array.from(state.activeSet || []),
      activeSecondsLeft: state.activeDeadline
        ? Math.max(0, Math.ceil((state.activeDeadline - Date.now()) / 1000))
        : 0,
      rounds: state.rounds.map((r) => ({
        roundNumber: r.roundNumber,
        bye: r.bye,
        status: r.status,
        matches: r.matches.map((m) => ({
          matchId: m.matchId,
          p1: m.p1,
          p2: m.p2,
          roomCode: m.roomCode,
          winner: m.winner,
          status: m.status,
          scores: m.scores,
        })),
      })),
    };
  },
};

// ════════════════════════════════════════════════════════════════
// JWT middleware
// ════════════════════════════════════════════════════════════════
io.use(async (socket, next) => {
  const auth = socket.handshake.auth || {};
  const token = typeof auth.token === 'string' ? auth.token : null;
  const legacyToken =
    typeof auth.legacyToken === 'string' ? auth.legacyToken : null;

  if (!token && legacyToken) {
    socket.data.userId = null;
    socket.data.legacyOnly = true;
    return next();
  }

  if (!token) {
    socket.data.userId = null;
    return next();
  }

  if (!jwks) {
    console.error('[JWT] reject: JWKS not configured');
    return next(new Error('jwks-not-configured'));
  }

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch (e) {
    console.error('[JWT] reject: malformed token header');
    return next(new Error('invalid-jwt-header'));
  }

  const alg = header?.alg;
  if (alg !== 'ES256') {
    console.error('[JWT] reject: unsupported alg', alg);
    return next(new Error(`unsupported-jwt-alg:${alg || 'none'}`));
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ['ES256'],
    });

    if (!payload?.sub) {
      console.error('[JWT] reject: no sub in payload');
      return next(new Error('invalid-jwt-no-sub'));
    }

    socket.data.userId = String(payload.sub);
    socket.data.jwtPayload = payload;
    return next();
  } catch (e) {
    console.error('[JWT] verify failed:', e?.code || e?.message);
    return next(new Error('invalid-jwt'));
  }
});

io.on('connection', (socket) => {
  console.log('[CONNECT]', socket.id, '| userId:', socket.data.userId || '(none)');
  players.set(socket.id, {
    room: null,
    name: 'Player',
    username: null,
    userId: socket.data.userId || null,
    avatar: '🤖',
  });

  socket.emit('connected', { playerId: socket.id });

  // ────────────────────────────────────────────────────────────
  // identify
  // ────────────────────────────────────────────────────────────
  socket.on('identify', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      if (socket.data.legacyOnly) return;
      socket.emit('identifyError', { message: 'Not authenticated' });
      return;
    }

    const profile = await db.getProfile(uid);
    const clientUsernameRaw = (data?.username || '').trim().slice(0, 15);
    const clientAvatar = data?.avatar || null;

    let usernameToUse = profile?.username || null;
    if (!usernameToUse && clientUsernameRaw && clientUsernameRaw.length >= 3) {
      const normalized = normalizeUsername(clientUsernameRaw);
      if (normalized && normalized.length >= 3) {
        usernameToUse = await generateUniqueUsername(normalized, uid);
      }
    }
    if (!usernameToUse) {
      const base = 'player';
      usernameToUse = await generateUniqueUsername(base, uid);
    }

    const avatarToUse = profile?.avatar || clientAvatar || '🤖';

    const user = await db.ensureUserRow(uid, {
      username: usernameToUse,
      avatar: avatarToUse,
    });

    if (!user) {
      socket.emit('identifyError', { message: 'Registration failed' });
      return;
    }

    if (!profile?.username) {
      db.updateProfileUsername(uid, user.username, user.avatar).catch(() => {});
    }

    for (const [existingSocketId, existingPlayer] of onlinePlayers) {
      if (existingPlayer.userId === uid && existingSocketId !== socket.id) {
        console.log('[SESSION REPLACED]', existingSocketId, '→', socket.id, `(${uid})`);
        io.to(existingSocketId).emit('sessionReplaced', {
          reason: 'logged-in-elsewhere',
        });
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
          setTimeout(() => {
            try { oldSocket.disconnect(true); } catch {}
          }, 50);
        }
      }
    }

    const player = players.get(socket.id);
    if (player) {
      player.name = user.username;
      player.username = user.username;
      player.userId = uid;
      player.avatar = user.avatar;
    }

    onlinePlayers.set(socket.id, {
      userId: uid,
      name: user.username,
      username: user.username,
      avatar: user.avatar,
      status: 'online',
      socketId: socket.id,
      connectedAt: Date.now(),
    });

    // B22: refresh the username in every tournament this user is in.
    for (const [, t] of tournaments) {
      if (t.players.includes(uid)) {
        t.usernames = t.usernames || {};
        t.usernames[uid] = user.username;
      }
    }

    broadcastOnlineUsers();
    broadcastOnlineCount();

    const stats = await db.getOrCreateStats(uid);
    socket.emit('playerStats', { stats });

    let avatars = [];
    try {
      avatars = await db.listAvatars(uid);
    } catch (e) {
      console.error('[IDENTIFY] listAvatars failed:', e?.message);
    }

    if (avatars.length === 0) {
      try {
        await db.createDefaultAvatarForUser(uid, user.username || 'Guest');
        avatars = await db.listAvatars(uid);
      } catch (e) {
        console.error('[IDENTIFY] createDefaultAvatarForUser failed:', e?.message);
      }
    } else {
      try {
        await db.renameDefaultAvatarIfNeeded(uid, user.username);
      } catch (e) {
        console.error('[IDENTIFY] renameDefaultAvatarIfNeeded failed:', e?.message);
      }
      avatars = await db.listAvatars(uid);
    }

    socket.emit('avatars', { avatars });

    const payload = socket.data.jwtPayload || {};
    const meta = payload.user_metadata || {};
    const isAnonymous = !payload.email || meta.is_anonymous === true;

    socket.emit('selfRegistered', {
      userId: uid,
      username: user.username,
      avatar: user.avatar,
      isPremium: !!(profile && profile.is_premium),
      premiumSince: profile?.premium_since || null,
      email: payload.email || null,
      isAnonymous,
    });

    console.log('[IDENTIFY]', socket.id, '→', user.username, `(${uid})`);
  });

  // ────────────────────────────────────────────────────────────
  // migrateLegacyToken
  // ────────────────────────────────────────────────────────────
  socket.on('migrateLegacyToken', async (data) => {
    const legacyToken = typeof data?.token === 'string' ? data.token : null;
    if (!legacyToken) {
      socket.emit('legacyMigrationResult', {
        success: false,
        message: 'No token provided',
      });
      return;
    }

    try {
      const oldUserId = await db.findLegacyUserIdByToken(legacyToken);
      if (!oldUserId) {
        socket.emit('legacyMigrationResult', {
          success: false,
          message: 'Token not found',
        });
        return;
      }

      const result = await db.migrateLegacyUser(oldUserId, legacyToken);
      if (!result || !result.newUid) {
        socket.emit('legacyMigrationResult', {
          success: false,
          message: 'Migration failed',
        });
        return;
      }

      await db.deleteLegacyToken(legacyToken);

      socket.emit('legacyMigrationResult', {
        success: true,
        userId: result.newUid,
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      });

      console.log('[MIGRATION]', socket.id, oldUserId, '→', result.newUid);
    } catch (e) {
      console.error('[MIGRATION ERROR]', e?.message || e);
      socket.emit('legacyMigrationResult', {
        success: false,
        message: 'Migration failed',
      });
    }
  });

  // ────────────────────────────────────────────────────────────
  // checkUsernameAvailability
  // ────────────────────────────────────────────────────────────
  socket.on('checkUsernameAvailability', async (data) => {
    const raw = (data?.username || '').trim().slice(0, 15);
    const normalized = normalizeUsername(raw);

    if (!normalized || normalized.length < 3) {
      socket.emit('usernameAvailability', {
        username: raw,
        available: false,
        message: 'Username must be at least 3 characters',
      });
      return;
    }

    if (normalized.length > 15) {
      socket.emit('usernameAvailability', {
        username: raw,
        available: false,
        message: 'Username must be 15 characters or less',
      });
      return;
    }

    const exceptUid = socket.data.userId || undefined;

    try {
      const available = await isUsernameAvailable(normalized, exceptUid);
      socket.emit('usernameAvailability', {
        username: raw,
        available,
        message: available ? undefined : 'That username is already taken',
      });
    } catch (e) {
      console.error('[USERNAME CHECK] error:', e?.message);
      socket.emit('usernameAvailability', {
        username: raw,
        available: false,
        message: 'Could not check availability',
      });
    }
  });

  // ────────────────────────────────────────────────────────────
  // changeUsername
  // ────────────────────────────────────────────────────────────
  socket.on('changeUsername', async (data) => {
    const uid = socket.data.userId;
    const newUsername = (data?.newUsername || '').trim().slice(0, 15);

    console.log(
      '[CHANGE USERNAME] receive',
      '| socketId:', socket.id,
      '| uid:', uid || '(none)',
      '| requested:', JSON.stringify(newUsername)
    );

    if (!uid) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'Not authenticated',
      });
      return;
    }

    const account = await db.getUserById(uid);
    if (!account) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'Not authenticated',
      });
      return;
    }

    if (newUsername.length < 3) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'Username must be at least 3 characters',
      });
      return;
    }

    const normalized = normalizeUsername(newUsername);
    if (!normalized || normalized.length < 3) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'Username can only contain letters, numbers, and underscores',
      });
      return;
    }

    if (
      normalized !== account.username &&
      !(await isUsernameAvailable(normalized, uid))
    ) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'That username is already taken',
      });
      return;
    }

    const ok = await db.updateUsername(uid, normalized);
    if (!ok) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'That username is already taken',
      });
      return;
    }

    db.updateProfileUsername(uid, normalized).catch(() => {});
    db.supabase.auth.admin
      .updateUserById(uid, { user_metadata: { username: normalized } })
      .catch(() => {});

    db.renameDefaultAvatarIfNeeded(uid, normalized).catch(() => {});

    const player = players.get(socket.id);
    if (player) {
      player.name = newUsername;
      player.username = normalized;
    }
    const onlineEntry = onlinePlayers.get(socket.id);
    if (onlineEntry) {
      onlineEntry.name = newUsername;
      onlineEntry.username = normalized;
    }

    // B22: propagate to any tournament this user is in.
    for (const [, t] of tournaments) {
      if (t.players.includes(uid)) {
        t.usernames = t.usernames || {};
        t.usernames[uid] = newUsername;
        this.broadcastState?.(t);   // safe no-op if not bound
        io.to('tournament:' + t.id).emit('tournamentState', tournamentEngine.publicState(t));
      }
    }

    broadcastOnlineUsers();

    socket.emit('changeUsernameResult', {
      success: true,
      username: newUsername,
      message: 'Username updated',
    });

    console.log('[CHANGE USERNAME] ok', socket.id, '→', newUsername);
  });

  // ────────────────────────────────────────────────────────────
  // deleteAccount
  // ────────────────────────────────────────────────────────────
  socket.on('deleteAccount', async () => {
    console.log('[DELETE ACCOUNT]', socket.id);

    const uid = socket.data.userId;

    const player = players.get(socket.id);
    if (player && player.room) {
      handleLeave(socket.id, true);
    }

    onlinePlayers.delete(socket.id);
    broadcastOnlineUsers();
    broadcastOnlineCount();

    players.delete(socket.id);

    if (uid) {
      await db.deleteUserEverywhere(uid);
    }

    socket.emit('deleteAccountResult', {
      success: true,
      message: 'Account deleted',
    });

    setTimeout(() => {
      socket.disconnect(true);
    }, 300);
  });

  socket.on('getMatchHistory', async () => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('matchHistory', { matches: [] });
      return;
    }
    const matches = await db.getMatchHistory(uid);
    socket.emit('matchHistory', { matches });
  });

  socket.on('getPlayerStats', async () => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('playerStats', { stats: db.createEmptyStats() });
      return;
    }
    const stats = await db.getOrCreateStats(uid);
    socket.emit('playerStats', { stats });
  });

  socket.on('recordDojoMatch', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      console.log('[DOJO RECORD] Unauthenticated socket, ignored:', socket.id);
      return;
    }

    try {
      const result = await recordDojoMatchResult(uid, data);
      if (result) {
        socket.emit('playerStats', { stats: result.stats });
        emitAchievementsToSocket(socket.id, result.unlocked);
      }
    } catch (e) {
      console.error('[DOJO RECORD ERROR]', e?.message);
    }
  });

  // ────────────────────────────────────────────────────────────
  // AVATARS
  // ────────────────────────────────────────────────────────────

  socket.on('getAvatars', async () => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('avatars', { avatars: [] });
      return;
    }
    const avatars = await db.listAvatars(uid);
    socket.emit('avatars', { avatars });
  });

  socket.on('createAvatar', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('avatarError', { action: 'create', message: 'Not authenticated' });
      return;
    }

    try {
      const created = await db.createAvatar(uid, data?.avatar || {});
      if (!created) {
        socket.emit('avatarError', { action: 'create', message: 'Create failed' });
        return;
      }
      socket.emit('avatarCreated', { avatar: created });
      const avatars = await db.listAvatars(uid);
      socket.emit('avatars', { avatars });
    } catch (e) {
      console.error('[AVATAR] createAvatar error:', e?.message);
      socket.emit('avatarError', { action: 'create', message: 'Create failed' });
    }
  });

  socket.on('updateAvatar', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('avatarError', { action: 'update', message: 'Not authenticated' });
      return;
    }

    const avatarId = data?.avatarId;
    const patch = data?.patch || {};
    if (!avatarId) {
      socket.emit('avatarError', { action: 'update', message: 'No avatarId' });
      return;
    }

    try {
      const updated = await db.updateAvatar(uid, avatarId, patch);
      if (!updated) {
        socket.emit('avatarError', { action: 'update', message: 'Update failed' });
        return;
      }
      socket.emit('avatarUpdated', { avatar: updated });
      const avatars = await db.listAvatars(uid);
      socket.emit('avatars', { avatars });
    } catch (e) {
      console.error('[AVATAR] updateAvatar error:', e?.message);
      socket.emit('avatarError', { action: 'update', message: 'Update failed' });
    }
  });

  socket.on('deleteAvatar', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('avatarError', { action: 'delete', message: 'Not authenticated' });
      return;
    }

    const avatarId = data?.avatarId;
    if (!avatarId) {
      socket.emit('avatarError', { action: 'delete', message: 'No avatarId' });
      return;
    }

    try {
      const result = await db.deleteAvatar(uid, avatarId);
      if (!result.deleted) {
        socket.emit('avatarError', { action: 'delete', message: 'Delete failed' });
        return;
      }
      socket.emit('avatarDeleted', {
        avatarId,
        newSelectedId: result.newSelectedId,
      });
      const avatars = await db.listAvatars(uid);
      socket.emit('avatars', { avatars });
    } catch (e) {
      console.error('[AVATAR] deleteAvatar error:', e?.message);
      socket.emit('avatarError', { action: 'delete', message: 'Delete failed' });
    }
  });

  socket.on('selectAvatar', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('avatarError', { action: 'select', message: 'Not authenticated' });
      return;
    }

    const avatarId = data?.avatarId;
    if (!avatarId) {
      socket.emit('avatarError', { action: 'select', message: 'No avatarId' });
      return;
    }

    try {
      const selected = await db.selectAvatar(uid, avatarId);
      if (!selected) {
        socket.emit('avatarError', { action: 'select', message: 'Select failed' });
        return;
      }
      const avatars = await db.listAvatars(uid);
      socket.emit('avatars', { avatars });
    } catch (e) {
      console.error('[AVATAR] selectAvatar error:', e?.message);
      socket.emit('avatarError', { action: 'select', message: 'Select failed' });
    }
  });

  // ────────────────────────────────────────────────────────────
  // Achievements
  // ────────────────────────────────────────────────────────────
  socket.on('getAchievements', async () => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('achievements', { unlocked: {} });
      return;
    }

    try {
      const unlocked = await db.getUnlockedMap(uid);
      socket.emit('achievements', { unlocked });
    } catch (e) {
      console.error('[ACHIEVEMENTS] getAchievements failed:', e?.message);
      socket.emit('achievements', { unlocked: {} });
    }
  });

  socket.on('getAchievementCatalog', () => {
    socket.emit('achievementCatalog', { catalog: db.ACHIEVEMENT_CATALOG });
  });

  socket.on('getLeaderboard', async () => {
    const leaderboard = await buildLeaderboard();
    socket.emit('leaderboard', leaderboard);
  });

  socket.on('getOnlineUsers', () => {
    const users = [];
    for (const [socketId, player] of onlinePlayers) {
      users.push({
        userId: player.userId,
        name: player.name,
        username: player.username,
        avatar: player.avatar,
        status: player.status,
        socketId,
      });
    }
    socket.emit('onlineUsers', { users });
  });

  socket.on('getOnlineCount', () => {
    socket.emit('onlineCount', { count: onlinePlayers.size });
  });

  socket.on('enterMatchScreen', () => {
    setPlayerStatus(socket.id, 'in-match');
  });

  socket.on('leaveMatchScreen', () => {
    setPlayerStatus(socket.id, 'online');
  });

  // ────────────────────────────────────────────────────────────
  // searchPlayer
  // ────────────────────────────────────────────────────────────
  socket.on('searchPlayer', async (data) => {
    const target = normalizeUsername(data.username || '');
    if (!target) {
      socket.emit('searchResult', { found: false, message: 'Enter a username' });
      return;
    }

    for (const [socketId, player] of onlinePlayers) {
      if (socketId === socket.id) continue;
      if (player.username === target) {
        socket.emit('searchResult', {
          found: true,
          player: {
            id: socketId,
            name: player.name,
            status: player.status,
          },
        });
        return;
      }
    }

    const { data: profile } = await db.supabase
      .from('profiles')
      .select('id, username')
      .ilike('username', target)
      .maybeSingle();

    if (profile) {
      socket.emit('searchResult', {
        found: false,
        message: `${profile.username} is offline`,
      });
      return;
    }

    socket.emit('searchResult', {
      found: false,
      message: 'Player not found or offline',
    });
  });

  socket.on('sendInvite', (data) => {
    const fromPlayer = players.get(socket.id);
    if (!fromPlayer) return;

    const targetSocketId = data.targetId;
    const targetPlayer = players.get(targetSocketId);
    if (!targetPlayer) {
      socket.emit('inviteError', { message: 'Player not found' });
      return;
    }

    const inviteId = `${socket.id}-${targetSocketId}-${Date.now()}`;
    const invite = {
      id: inviteId,
      fromId: socket.id,
      fromName: fromPlayer.name,
      toId: targetSocketId,
      toName: targetPlayer.name,
      status: 'pending',
      createdAt: Date.now(),
      battleMode: data.battleMode || 'human',
      fromAvatarPersonality: data.avatarPersonality ?? null,
    };

    activeInvites.set(inviteId, invite);

    const timeout = setTimeout(() => {
      const inv = activeInvites.get(inviteId);
      if (inv && inv.status === 'pending') {
        inv.status = 'expired';
        io.to(targetSocketId).emit('inviteExpired', { inviteId });
        io.to(socket.id).emit('inviteExpired', { inviteId });
        activeInvites.delete(inviteId);
      }
    }, INVITE_TIMEOUT);

    invite.timeout = timeout;

    io.to(targetSocketId).emit('inviteReceived', {
      inviteId: invite.id,
      fromName: fromPlayer.name,
      fromId: socket.id,
      battleMode: invite.battleMode,
    });

    socket.emit('inviteSent', {
      inviteId: invite.id,
      toName: targetPlayer.name,
      toId: targetSocketId,
    });

    console.log('[INVITE]', fromPlayer.name, '→', targetPlayer.name, `(${invite.battleMode})`);
  });

  socket.on('respondToInvite', async (data) => {
    const invite = activeInvites.get(data.inviteId);
    if (!invite) {
      socket.emit('inviteError', { message: 'Invite expired or not found' });
      return;
    }
    if (invite.toId !== socket.id) {
      socket.emit('inviteError', { message: 'Invalid invite' });
      return;
    }

    if (invite.timeout) clearTimeout(invite.timeout);

    if (data.accepted) {
      invite.status = 'accepted';

      const resolvedMode = invite.battleMode || data.battleMode || 'human';

      const roomCode = generateRoomCode();
      const room = {
        code: roomCode,
        players: [invite.fromId, invite.toId],
        moves: {},
        scores: { [invite.fromId]: 0, [invite.toId]: 0 },
        ties: { [invite.fromId]: 0, [invite.toId]: 0 },
        round: 0,
        matchOver: false,
        winner: null,
        disconnectTimer: null,
        disconnectedPlayer: null,
        battleMode: resolvedMode,
        avatarAutoTimer: null,
        recentMoves: {
          [invite.fromId]: [],
          [invite.toId]: [],
        },
        avatarPersonalities: {
          [invite.fromId]: invite.fromAvatarPersonality ?? null,
          [invite.toId]: data.avatarPersonality ?? null,
        },
        avatarIds: {},
        aiState: null,
        tournamentId: null,
        tournamentMatchId: null,
        winTarget: WIN_TARGET,
      };
      rooms.set(roomCode, room);

      const fromPlayerData = players.get(invite.fromId);
      const toPlayerData = players.get(invite.toId);
      if (fromPlayerData) fromPlayerData.room = roomCode;
      if (toPlayerData) toPlayerData.room = roomCode;

      const fromSocket = io.sockets.sockets.get(invite.fromId);
      const toSocket = io.sockets.sockets.get(invite.toId);
      if (fromSocket) fromSocket.join(roomCode);
      if (toSocket) toSocket.join(roomCode);

      const playerList = getRoomPlayers(room);

      if (room.battleMode === 'avatar') {
        ensureAvatarAI(room);
      }

      await snapshotRoomAvatars(room);

      io.to(invite.fromId).emit('inviteAccepted', {
        roomCode,
        playerId: invite.fromId,
        playerName: fromPlayerData?.name || 'Player',
        opponentName: toPlayerData?.name || 'Player',
        opponentId: invite.toId,
        players: playerList,
        battleMode: room.battleMode,
      });

      io.to(invite.toId).emit('inviteAccepted', {
        roomCode,
        playerId: invite.toId,
        playerName: toPlayerData?.name || 'Player',
        opponentName: fromPlayerData?.name || 'Player',
        opponentId: invite.fromId,
        players: playerList,
        battleMode: room.battleMode,
      });

      io.to(roomCode).emit('roomReady', {
        roomCode,
        battleMode: room.battleMode,
        players: playerList,
        reason: 'invite-accept',
        hostId: invite.fromId,
        guestId: invite.toId,
        recentMoves: buildRecentMovesPayload(room),
      });

      io.to(roomCode).emit('roomState', {
        players: playerList,
        scores: room.scores,
        ties: room.ties,
        round: room.round,
        matchOver: room.matchOver,
        winner: room.winner,
        winTarget: room.winTarget ?? WIN_TARGET,
        recentMoves: buildRecentMovesPayload(room),
      });

      recordRecentOpponent(invite.fromId, invite.toId);
      recordRecentOpponent(invite.toId, invite.fromId);

      if (room.battleMode === 'avatar') {
        console.log('[ACCEPT] Scheduling avatar auto-play for room', roomCode);
        setTimeout(() => startAvatarAutoPlay(roomCode), 2000);
      }

      console.log('[ACCEPT]', fromPlayerData?.name, 'vs', toPlayerData?.name, '→ room', roomCode, `(${room.battleMode})`);
    } else {
      invite.status = 'declined';

      io.to(invite.fromId).emit('inviteDeclined', {
        inviteId: invite.id,
        byName: players.get(socket.id)?.name || 'Player',
      });
    }

    activeInvites.delete(invite.id);
  });

  socket.on('getRecentOpponents', () => {
    const list = recentOpponents.get(socket.id) || [];
    const enriched = list.map((item) => {
      const online = onlinePlayers.has(item.id);
      return {
        ...item,
        status: online ? onlinePlayers.get(item.id).status : 'offline',
      };
    });
    socket.emit('recentOpponents', enriched);
  });

  socket.on('createRoom', (data) => {
    let roomCode;

    if (data.customCode && data.customCode.length === 4) {
      roomCode = data.customCode.toUpperCase();
      if (rooms.has(roomCode)) {
        socket.emit('error', { message: 'Code already in use. Try another.' });
        return;
      }
    } else {
      roomCode = generateRoomCode();
    }

    const tournamentId = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    const tournamentMatchId = typeof data?.tournamentMatchId === 'string' ? data.tournamentMatchId : null;
    const requestedRoomCode = typeof data?.roomCode === 'string' ? data.roomCode.toUpperCase() : null;

    if (tournamentId && requestedRoomCode && rooms.has(requestedRoomCode)) {
      const existing = rooms.get(requestedRoomCode);
      if (existing.tournamentId !== tournamentId) {
        socket.emit('error', { message: 'Room code conflict' });
        return;
      }
      if (existing.players.includes(socket.id)) return;
      if (existing.players.length >= 2) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
      existing.disconnectedPlayer = null;
      existing.players.push(socket.id);
      existing.scores[socket.id] = 0;
      existing.ties[socket.id] = 0;
      if (!existing.recentMoves) existing.recentMoves = {};
      existing.recentMoves[socket.id] = [];
      if (!existing.avatarPersonalities) existing.avatarPersonalities = {};
      existing.avatarPersonalities[socket.id] = data.avatarPersonality ?? null;

      const player = players.get(socket.id);
      if (player) {
        player.room = requestedRoomCode;
        if (data.name) player.name = data.name;
      }
      socket.join(requestedRoomCode);
      socket.join('tournament:' + tournamentId);

      // B21: winTarget is server-authoritative. Do NOT honor a client
      // override here — the room already has the correct value from
      // createTournamentRoom().

      broadcastRoomState(existing);

      io.to(requestedRoomCode).emit('playerJoined', {
        players: getRoomPlayers(existing),
        playerId: socket.id,
        playerName: player?.name || 'Player 2',
      });

      io.to(requestedRoomCode).emit('roomReady', {
        roomCode: requestedRoomCode,
        battleMode: existing.battleMode,
        players: getRoomPlayers(existing),
        reason: 'tournament-join',
        hostId: existing.players[0],
        guestId: socket.id,
        recentMoves: buildRecentMovesPayload(existing),
      });

      io.to(requestedRoomCode).emit('gameReset', {
        scores: existing.scores,
        ties: existing.ties,
        recentMoves: buildRecentMovesPayload(existing),
      });

      console.log('[TOURNAMENT JOIN ROOM]', socket.id, '→', requestedRoomCode, `(${existing.battleMode})`);

      if (existing.players.length === 2) {
        snapshotRoomAvatars(existing).then(() => {
          tournamentEngine.onMatchReady(existing);
        });
      }

      if (existing.battleMode === 'avatar' && existing.players.length === 2) {
        ensureAvatarAI(existing);
        setTimeout(() => startAvatarAutoPlay(requestedRoomCode), 2000);
      }

      return;
    }

    const room = {
      code: roomCode,
      players: [socket.id],
      moves: {},
      scores: { [socket.id]: 0 },
      ties: { [socket.id]: 0 },
      round: 0,
      matchOver: false,
      winner: null,
      disconnectTimer: null,
      disconnectedPlayer: null,
      battleMode: data.battleMode || 'human',
      avatarAutoTimer: null,
      recentMoves: { [socket.id]: [] },
      avatarPersonalities: {
        [socket.id]: data.avatarPersonality ?? null,
      },
      avatarIds: {},
      aiState: null,
      tournamentId: tournamentId,
      tournamentMatchId: tournamentMatchId,
      winTarget: WIN_TARGET,     // B21: non-tournament rooms use the global default
    };
    rooms.set(roomCode, room);

    const player = players.get(socket.id);
    if (player) {
      player.room = roomCode;
      if (data.name) player.name = data.name;
    }

    socket.join(roomCode);

    if (tournamentId) {
      socket.join('tournament:' + tournamentId);
    }

    socket.emit('roomCreated', {
      code: roomCode,
      playerId: socket.id,
      playerName: player?.name || 'Player 1',
      battleMode: room.battleMode,
      recentMoves: buildRecentMovesPayload(room),
    });

    console.log('[CREATE ROOM]', socket.id, '→', roomCode, `(${room.battleMode})`);
  });

  socket.on('getHostCode', () => {
    const player = players.get(socket.id);
    if (!player || !player.room) {
      socket.emit('hostCode', { code: null });
      return;
    }
    const room = rooms.get(player.room);
    if (!room) {
      socket.emit('hostCode', { code: null });
      return;
    }
    socket.emit('hostCode', { code: room.code });
  });

  socket.on('joinRoom', async (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    if (room.disconnectTimer) {
      clearTimeout(room.disconnectTimer);
      room.disconnectTimer = null;
    }
    room.disconnectedPlayer = null;

    room.players.push(socket.id);
    room.scores[socket.id] = 0;
    room.ties[socket.id] = 0;

    if (!room.recentMoves) room.recentMoves = {};
    room.recentMoves[socket.id] = [];

    if (!room.avatarPersonalities) room.avatarPersonalities = {};
    room.avatarPersonalities[socket.id] = data.avatarPersonality ?? null;

    const player = players.get(socket.id);
    if (player) {
      player.room = code;
      if (data.name) player.name = data.name;
    }

    socket.join(code);

    if (room.tournamentId) {
      socket.join('tournament:' + room.tournamentId);
    }

    resetRoomScores(room);
    broadcastRoomState(room);

    io.to(code).emit('playerJoined', {
      players: getRoomPlayers(room),
      playerId: socket.id,
      playerName: player?.name || 'Player 2',
    });

    io.to(code).emit('roomReady', {
      roomCode: code,
      battleMode: room.battleMode,
      players: getRoomPlayers(room),
      reason: 'code-join',
      hostId: room.players[0],
      guestId: socket.id,
      recentMoves: buildRecentMovesPayload(room),
    });

    io.to(code).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
      recentMoves: buildRecentMovesPayload(room),
    });

    console.log('[JOIN ROOM]', socket.id, '→', code, `(${room.battleMode})`);

    if (room.players.length === 2) {
      await snapshotRoomAvatars(room);
      if (room.tournamentId) {
        tournamentEngine.onMatchReady(room);
      }
    }

    if (room.battleMode === 'avatar' && room.players.length === 2) {
      ensureAvatarAI(room);
      console.log('[JOIN ROOM] Scheduling avatar auto-play for room', code);
      setTimeout(() => startAvatarAutoPlay(code), 2000);
    }
  });

  socket.on('makeMove', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;
    if (room.matchOver) return;
    if (room.battleMode === 'avatar') return;

    room.moves[socket.id] = data.move;

    socket.to(player.room).emit('playerMoved', { playerId: socket.id });

    const bothMoved =
      room.players.length === 2 && room.players.every((id) => room.moves[id]);

    if (bothMoved) {
      const [p1, p2] = room.players;
      const move1 = room.moves[p1];
      const move2 = room.moves[p2];

      const result = resolveRound(move1, move2);

      if (result === 'p1') room.scores[p1]++;
      else if (result === 'p2') room.scores[p2]++;
      else {
        room.ties[p1] = (room.ties[p1] || 0) + 1;
        room.ties[p2] = (room.ties[p2] || 0) + 1;
      }
      room.round++;

      pushRecentMove(room, p1, move1);
      pushRecentMove(room, p2, move2);

      let matchWinner = null;
      const target = room.winTarget ?? WIN_TARGET;   // B21
      if (room.scores[p1] >= target) matchWinner = p1;
      else if (room.scores[p2] >= target) matchWinner = p2;

      if (matchWinner) {
        room.matchOver = true;
        room.winner = matchWinner;
        recordMatchResult(room).catch((e) =>
          console.error('[MATCH RECORD ERROR]', e?.message)
        );
      }

      io.to(player.room).emit('roundResult', {
        moves: { [p1]: move1, [p2]: move2 },
        result,
        scores: room.scores,
        ties: room.ties,
        round: room.round,
        matchOver: room.matchOver,
        matchWinner,
        winTarget: target,
        recentMoves: buildRecentMovesPayload(room),
      });

      if (room.tournamentId) {
        tournamentEngine.onMatchProgress(room).catch((e) =>
          console.error('[TOURNAMENT] onMatchProgress error:', e?.message)
        );
      }

      room.moves = {};
    }
  });

  socket.on('sendMessage', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const text = typeof data?.text === 'string' ? data.text : '';
    if (!text.trim()) return;

    const room = player.room ? rooms.get(player.room) : null;

    const message = {
      playerId: socket.id,
      playerName: player.name,
      text,
      timestamp: Date.now(),
    };

    if (room) {
      io.to(room.code).emit('newMessage', message);
      if (room.tournamentId) {
        io.to('tournament:' + room.tournamentId).emit('newMessage', message);
      }
      return;
    }

    const requestedId =
      typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    if (requestedId && tournaments.has(requestedId)) {
      io.to('tournament:' + requestedId).emit('newMessage', message);
      return;
    }

    const uid = socket.data.userId;
    if (uid) {
      for (const [, t] of tournaments) {
        if (t.players.includes(uid)) {
          io.to('tournament:' + t.id).emit('newMessage', message);
          return;
        }
      }
    }
  });

  socket.on('playAgain', () => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;

    if (room.tournamentId) return;

    if (room.avatarAutoTimer) {
      clearTimeout(room.avatarAutoTimer);
      room.avatarAutoTimer = null;
    }

    clearAvatarAI(room);

    resetRoomScores(room);

    io.to(player.room).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
      recentMoves: buildRecentMovesPayload(room),
    });

    broadcastRoomState(room);

    if (room.battleMode === 'avatar' && room.players.length === 2) {
      ensureAvatarAI(room);
      setTimeout(() => startAvatarAutoPlay(room.code), 2000);
    }
  });

  // B6: leaveRoom only routes the tournament engine if the user is
  // actually exiting via an explicit leave, not on screen unmount.
  // TournamentMatchScreen no longer emits leaveRoom on unmount.
  socket.on('leaveRoom', () => {
    handleLeave(socket.id, true);
  });

  // ────────────────────────────────────────────────────────────
  // TOURNAMENT EVENTS
  // ────────────────────────────────────────────────────────────

  socket.on('createTournament', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('tournamentError', { action: 'create', message: 'Not authenticated' });
      return;
    }
    try {
      const result = await tournamentEngine.create(uid, data || {});
      if (result.error) {
        socket.emit('tournamentError', { action: 'create', message: result.error });
        return;
      }
      socket.join('tournament:' + result.tournamentId);
      socket.emit('tournamentCreated', {
        tournamentId: result.tournamentId,
        code: result.code,
      });
      const state = await tournamentEngine.get(result.tournamentId);
      if (state) tournamentEngine.broadcastState(state);
    } catch (e) {
      console.error('[TOURNAMENT] createTournament error:', e?.message);
      socket.emit('tournamentError', { action: 'create', message: 'Create failed' });
    }
  });

  socket.on('joinTournament', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('tournamentError', { action: 'join', message: 'Not authenticated' });
      return;
    }
    const code = typeof data?.code === 'string' ? data.code.toUpperCase().trim() : '';
    if (!code) {
      socket.emit('tournamentError', { action: 'join', message: 'Enter a tournament code' });
      return;
    }
    try {
      const result = await tournamentEngine.join(uid, code);
      if (result.error) {
        socket.emit('tournamentError', { action: 'join', message: result.error });
        return;
      }
      const state = await tournamentEngine.get(result.tournament.id);
      if (!state) {
        socket.emit('tournamentError', { action: 'join', message: 'Tournament not found' });
        return;
      }
      socket.join('tournament:' + state.id);
      socket.emit('tournamentJoined', {
        tournamentId: state.id,
        code: state.code,
      });
      tournamentEngine.broadcastState(state);
    } catch (e) {
      console.error('[TOURNAMENT] joinTournament error:', e?.message);
      socket.emit('tournamentError', { action: 'join', message: 'Join failed' });
    }
  });

  socket.on('leaveTournament', async (data) => {
    const uid = socket.data.userId;
    if (!uid) return;
    const tournamentId = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    if (!tournamentId) return;
    try {
      await tournamentEngine.leave(uid, tournamentId);
      socket.leave('tournament:' + tournamentId);
      const state = await tournamentEngine.get(tournamentId);
      if (state) tournamentEngine.broadcastState(state);
    } catch (e) {
      console.error('[TOURNAMENT] leaveTournament error:', e?.message);
    }
  });

  socket.on('pressActive', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('tournamentError', { action: 'active', message: 'Not authenticated' });
      return;
    }
    const tournamentId = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    if (!tournamentId) return;
    try {
      const result = await tournamentEngine.pressActive(uid, tournamentId);
      if (result?.error) {
        socket.emit('tournamentError', { action: 'active', message: result.error });
      }
    } catch (e) {
      console.error('[TOURNAMENT] pressActive error:', e?.message);
    }
  });

  socket.on('startTournament', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('tournamentError', { action: 'start', message: 'Not authenticated' });
      return;
    }
    const tournamentId = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    if (!tournamentId) return;
    try {
      const result = await tournamentEngine.start(uid, tournamentId);
      if (result?.error) {
        socket.emit('tournamentError', { action: 'start', message: result.error });
      }
    } catch (e) {
      console.error('[TOURNAMENT] startTournament error:', e?.message);
      socket.emit('tournamentError', { action: 'start', message: 'Start failed' });
    }
  });

  socket.on('beginNextRound', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      socket.emit('tournamentError', { action: 'beginRound', message: 'Not authenticated' });
      return;
    }
    const tournamentId = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    if (!tournamentId) return;
    try {
      const result = await tournamentEngine.beginNextRound(uid, tournamentId);
      if (result?.error) {
        socket.emit('tournamentError', { action: 'beginRound', message: result.error });
      }
    } catch (e) {
      console.error('[TOURNAMENT] beginNextRound error:', e?.message);
    }
  });

  socket.on('getTournament', async (data) => {
    const uid = socket.data.userId;
    const id = typeof data?.tournamentId === 'string' ? data.tournamentId : null;
    const code = typeof data?.code === 'string' ? data.code.toUpperCase().trim() : null;
    let state = null;
    try {
      if (id) state = await tournamentEngine.get(id);
      else if (code) state = await tournamentEngine.getByCode(code);
    } catch (e) {
      console.error('[TOURNAMENT] getTournament error:', e?.message);
    }
    if (!state) {
      socket.emit('tournamentState', null);
      return;
    }
    socket.join('tournament:' + state.id);
    socket.emit('tournamentState', tournamentEngine.publicState(state));
  });

  socket.on('disconnect', () => {
    console.log('[DISCONNECT]', socket.id);
    handleDisconnect(socket.id);
  });
});

function handleDisconnect(socketId) {
  const player = players.get(socketId);
  if (!player) return;

  tournamentEngine.onPlayerDisconnect(socketId).catch((e) =>
    console.error('[TOURNAMENT] onPlayerDisconnect error:', e?.message)
  );

  onlinePlayers.delete(socketId);
  broadcastOnlineUsers();
  broadcastOnlineCount();

  if (!player.room) {
    players.delete(socketId);
    return;
  }

  const room = rooms.get(player.room);
  if (!room) {
    players.delete(socketId);
    return;
  }

  if (room.avatarAutoTimer) {
    clearTimeout(room.avatarAutoTimer);
    room.avatarAutoTimer = null;
  }

  if (room.tournamentId) {
    io.to(player.room).emit('playerLeft', { playerId: socketId });
    room.players = room.players.filter((id) => id !== socketId);
    clearAvatarAI(room);
    if (room.players.length === 0) rooms.delete(player.room);
    players.delete(socketId);
    return;
  }

  if (room.matchOver) {
    io.to(player.room).emit('playerLeft', { playerId: socketId });
    room.players = room.players.filter((id) => id !== socketId);
    clearAvatarAI(room);
    if (room.players.length === 0) rooms.delete(player.room);
    players.delete(socketId);
    return;
  }

  room.disconnectedPlayer = socketId;
  const opponentId = room.players.find((id) => id !== socketId);

  if (opponentId) {
    io.to(opponentId).emit('opponentDisconnected', {
      playerId: socketId,
      timeout: DISCONNECT_TIMEOUT,
    });
  }

  if (room.disconnectTimer) clearTimeout(room.disconnectTimer);

  room.disconnectTimer = setTimeout(() => {
    if (!room.disconnectedPlayer) return;

    const disconnectedId = room.disconnectedPlayer;
    const winnerId = room.players.find((id) => id !== disconnectedId);

    if (winnerId) {
      room.matchOver = true;
      room.winner = winnerId;
      recordMatchResult(room).catch((e) =>
        console.error('[MATCH RECORD ERROR]', e?.message)
      );
      io.to(winnerId).emit('opponentTimedOut', {
        winnerId,
        loserId: disconnectedId,
      });
    }

    room.players = room.players.filter((id) => id !== disconnectedId);
    clearAvatarAI(room);
    if (room.players.length === 0) rooms.delete(room.code);
    players.delete(disconnectedId);
    room.disconnectedPlayer = null;
    room.disconnectTimer = null;
  }, DISCONNECT_TIMEOUT);
}

function handleLeave(socketId, notify = false) {
  const player = players.get(socketId);
  if (!player) return;

  // B6: only fire the tournament leave path for explicit leaves.
  if (notify) {
    tournamentEngine.onPlayerLeave(socketId).catch((e) =>
      console.error('[TOURNAMENT] onPlayerLeave error:', e?.message)
    );
  }

  if (player.room) {
    const room = rooms.get(player.room);
    if (room) {
      if (room.disconnectTimer) {
        clearTimeout(room.disconnectTimer);
        room.disconnectTimer = null;
      }
      if (room.avatarAutoTimer) {
        clearTimeout(room.avatarAutoTimer);
        room.avatarAutoTimer = null;
      }
      room.disconnectedPlayer = null;
      clearAvatarAI(room);

      if (notify) {
        io.to(player.room).emit('playerLeft', { playerId: socketId });
      }

      room.players = room.players.filter((id) => id !== socketId);
      if (room.players.length === 0) {
        rooms.delete(player.room);
      } else {
        resetPlayersToOnline(room);
      }
    }
  }

  setPlayerStatus(socketId, 'online');

  players.delete(socketId);
}

app.get('/', (req, res) => {
  res.send('RPS Arena Server is running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});