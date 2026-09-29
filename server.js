// rps-server/server.js
//
// RPS Arena — Node.js + Express + Socket.IO server.
//
// Chat 1: tokens. Chat 2: adaptive AI. Chat 4: Supabase.
// Chat 5: Dojo stats sync. Chat 7: achievements.
// Chat 9: Supabase Auth migration (JWT middleware, identify,
//         migrateLegacyToken, deleteUserEverywhere).
// Chat 9b: avatars (getAvatars/createAvatar/updateAvatar/deleteAvatar/
//          selectAvatar), profiles-driven identify, snapshot avatars
//          at match start, dojo log, changeUsername receive log.
// Chat 9c: ES256-only JWT verification via Supabase JWKS (jose).
//          - Removed jsonwebtoken and SUPABASE_JWT_SECRET.
//          - HS256 and every other alg are rejected.
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
// jose caches keys internally and refreshes on demand.
// The apikey header is required by Supabase's auth gateway.
const SUPABASE_JWKS_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
  : null;

let jwks = null;
if (SUPABASE_JWKS_URL && SUPABASE_ANON_KEY) {
  jwks = createRemoteJWKSet(new URL(SUPABASE_JWKS_URL), {
    headers: { apikey: SUPABASE_ANON_KEY },
    // Cooldown between refresh attempts when a kid isn't found.
    cooldownDuration: 10_000,
    // Cache the JWKS in memory between refreshes.
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
const players = new Map();          // socketId → { room, name, username, userId, avatar }
const onlinePlayers = new Map();    // socketId → { userId, name, username, avatar, status, socketId, connectedAt }
const activeInvites = new Map();
const recentOpponents = new Map();

// ─── Constants ───
const WIN_TARGET = 30;
const DISCONNECT_TIMEOUT = 20000;
const INVITE_TIMEOUT = 5 * 60 * 1000;
const AVATAR_ROUND_DELAY = 2000;    // MUST stay 2000
const MAX_RECENT_MOVES = 5;

// ─── Small helpers ───

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
    winTarget: WIN_TARGET,
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

  // ── P1 history ──
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

  // ── P1 stats ──
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

  // ── P2 history ──
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

  // ── P2 stats ──
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

  // ── Avatar W/L ──
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

  // ── Achievements ──
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
    if (r.scores[p1] >= WIN_TARGET) matchWinner = p1;
    else if (r.scores[p2] >= WIN_TARGET) matchWinner = p2;

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
      winTarget: WIN_TARGET,
      recentMoves: buildRecentMovesPayload(r),
    });

    if (!r.matchOver) {
      r.avatarAutoTimer = setTimeout(runRound, AVATAR_ROUND_DELAY);
    } else {
      r.avatarAutoTimer = null;
    }
  };

  room.avatarAutoTimer = setTimeout(runRound, AVATAR_ROUND_DELAY);
  console.log('[AVATAR AUTO] Started for room', roomCode);
}

// ════════════════════════════════════════════════════════════
// JWT middleware — ES256-only via Supabase JWKS (jose)
// ════════════════════════════════════════════════════════════
//
// Flow:
//   1. Read auth.token from the handshake.
//   2. Decode the JWT header (no verification) to read `alg`.
//   3. Reject anything that isn't ES256 with a clear reason.
//   4. Verify ES256 against the cached Supabase JWKS.
//   5. Extract sub → socket.data.userId.
//
// Legacy migration: a socket that presents auth.legacyToken (and no
// auth.token) is allowed to connect with userId=null so it can run
// migrateLegacyToken.
//
// All other sockets must present a valid ES256 JWT or they're
// rejected at handshake time.

io.use(async (socket, next) => {
  const auth = socket.handshake.auth || {};
  const token = typeof auth.token === 'string' ? auth.token : null;
  const legacyToken =
    typeof auth.legacyToken === 'string' ? auth.legacyToken : null;

  // Legacy-only socket: allow connect, but userId stays null.
  if (!token && legacyToken) {
    socket.data.userId = null;
    socket.data.legacyOnly = true;
    return next();
  }

  if (!token) {
    // No auth at all. Allow the connect; handlers guard on userId.
    socket.data.userId = null;
    return next();
  }

  if (!jwks) {
    console.error('[JWT] reject: JWKS not configured');
    return next(new Error('jwks-not-configured'));
  }

  // 1. Peek at the header to decide the algorithm.
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

  // 2. Verify against the JWKS.
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
  // identify — uses profiles.username / profiles.avatar
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

  // ────────────────────────────────────────────────────────────
  // recordDojoMatch
  // ────────────────────────────────────────────────────────────
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
        winTarget: WIN_TARGET,
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
    };
    rooms.set(roomCode, room);

    const player = players.get(socket.id);
    if (player) {
      player.room = roomCode;
      if (data.name) player.name = data.name;
    }

    socket.join(roomCode);

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
      if (room.scores[p1] >= WIN_TARGET) matchWinner = p1;
      else if (room.scores[p2] >= WIN_TARGET) matchWinner = p2;

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
        winTarget: WIN_TARGET,
        recentMoves: buildRecentMovesPayload(room),
      });

      room.moves = {};
    }
  });

  socket.on('sendMessage', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;

    const message = {
      playerId: socket.id,
      playerName: player.name,
      text: data.text,
      timestamp: Date.now(),
    };

    io.to(player.room).emit('newMessage', message);
  });

  socket.on('playAgain', () => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;

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

  socket.on('leaveRoom', () => {
    handleLeave(socket.id, true);
  });

  socket.on('disconnect', () => {
    console.log('[DISCONNECT]', socket.id);
    handleDisconnect(socket.id);
  });
});

function handleDisconnect(socketId) {
  const player = players.get(socketId);
  if (!player) return;

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