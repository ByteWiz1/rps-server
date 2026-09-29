// rps-server/server.js
//
// RPS Arena — Node.js + Express + Socket.IO server.
//
// Chat 1: server-issued auth tokens, session replacement, status tied to
//         match-screen presence, roomReady, recentMoves, match history.
// Chat 2: adaptive AI engine wired into Avatar Arena, per-mode stats,
//         overall streaks, pull-based leaderboard.
// Chat 4: persistent state migrated from in-memory Maps to Supabase.
// Chat 5: Dojo stats sync (roadmap item #2).
// Chat 7: Achievements (roadmap item #4).
// Chat 9: Supabase Auth migration (Option A-lite).
//   - Removed: server-issued tokens, generateToken / generateUserId,
//     registerIdentity handler's legacy registration path.
//   - Added: JWT middleware. Verifies Supabase JWT from the socket
//     handshake (auth.token) with SUPABASE_JWT_SECRET, extracts `sub`
//     (the Supabase UID) and attaches to socket.data.userId.
//   - Added: 'identify' handler. Runs after JWT auth, ensures a
//     public.users row exists (via db.ensureUserRow), registers
//     presence in onlinePlayers, emits 'selfRegistered'.
//   - Added: 'migrateLegacyToken' handler. Accepts an old custom
//     token, migrates the user to a Supabase UID server-side, and
//     returns the new session tokens to the client.
//   - changeUsername now uses socket.data.userId and syncs
//     public.users + public.profiles + auth.users.user_metadata.
//   - deleteAccount now uses socket.data.userId and calls
//     db.deleteUserEverywhere (also removes the auth.users row).
//   - Session replacement kept. Emits 'sessionReplaced' to the older
//     socket for the same userId, then disconnects it.
//
// Preserved constants: AVATAR_ROUND_DELAY = 2000, WIN_TARGET = 30,
//   MAX_HISTORY = 20, MAX_RECENT_MOVES = 5, DISCONNECT_TIMEOUT = 20000,
//   INVITE_TIMEOUT = 5 min.

const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { createAdaptiveAI } = require('./aiEngine');
const db = require('./db');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ─── Env ───
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
if (!SUPABASE_JWT_SECRET) {
  console.error(
    '[SERVER] Missing SUPABASE_JWT_SECRET. Set it on Render ' +
    '(Supabase dashboard → Settings → API → JWT Secret).'
  );
}

// ─── In-memory state (ephemeral — survives only while the process is up) ───
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

// Username uniqueness scans BOTH live players AND stored accounts.
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

// ─── Status helper: the ONE way to change a player's status ───
function setPlayerStatus(socketId, status) {
  if (!socketId) return;
  const entry = onlinePlayers.get(socketId);
  if (!entry) return;
  if (entry.status === status) return;
  entry.status = status;
  broadcastOnlineUsers();
  console.log('[STATUS]', socketId, '→', status);
}

// ─── Recent moves helpers ───
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

// ─── Achievement emission helper (Chat 7) ───
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

// ─── Chat 7 tracking helpers ───
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

  // ── P1: history ──
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

  // ── P1: stats ──
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

  await db.saveStats(p1UserId, p1Stats);

  // ── P2: history ──
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

  // ── P2: stats ──
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

  await db.saveStats(p2UserId, p2Stats);

  io.to(p1).emit('playerStats', { stats: p1Stats });
  io.to(p2).emit('playerStats', { stats: p2Stats });

  console.log('[MATCH RECORDED]', p1Name, 'vs', p2Name, '→ winner:', room.winner === p1 ? p1Name : p2Name, `(${mode})`);

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

  await db.saveStats(userId, stats);

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

  return { stats, unlocked };
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
// Socket.IO JWT middleware — Chat 9
// ════════════════════════════════════════════════════════════
// Reads socket.handshake.auth.token, verifies it with
// SUPABASE_JWT_SECRET, extracts `sub` (the Supabase UID) and attaches
// it to socket.data.userId.
//
// Migration path: if the client sends an old custom token via
// auth.legacyToken instead of a JWT, we DON'T reject — we leave
// socket.data.userId null and let the 'migrateLegacyToken' handler
// run. This is the only socket that can be un-authenticated.
//
// All OTHER sockets must present a valid JWT or they're rejected
// at handshake time.
io.use((socket, next) => {
  const auth = socket.handshake.auth || {};
  const token = typeof auth.token === 'string' ? auth.token : null;
  const legacyToken =
    typeof auth.legacyToken === 'string' ? auth.legacyToken : null;

  // Legacy-only socket: allow connect, but socket.data.userId stays null.
  if (!token && legacyToken) {
    socket.data.userId = null;
    socket.data.legacyOnly = true;
    return next();
  }

  if (!token) {
    // No auth at all. Allow the connect but mark as anonymous-unauthed.
    // Server handlers guard on socket.data.userId so this is safe.
    socket.data.userId = null;
    return next();
  }

  try {
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (!decoded?.sub) {
      return next(new Error('invalid-jwt-no-sub'));
    }
    socket.data.userId = String(decoded.sub);
    socket.data.jwtPayload = decoded;
    return next();
  } catch (e) {
    // Invalid / expired token → reject handshake. Client must refresh.
    console.error('[JWT] verify failed:', e?.message);
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
  // identify  (Chat 9)
  //   Called by the client immediately after socket connect.
  //   Ensures a public.users row exists for socket.data.userId,
  //   registers presence, emits 'selfRegistered'.
  //
  //   Payload: { username?, avatar? }
  //   Emits:   selfRegistered { userId, username, avatar, isPremium, email, isAnonymous }
  // ────────────────────────────────────────────────────────────
  socket.on('identify', async (data) => {
    const uid = socket.data.userId;
    if (!uid) {
      // Legacy-only or unauthenticated socket. Wait for migrateLegacyToken
      // or the client to sign in. Don't error — migration is a valid flow.
      if (socket.data.legacyOnly) return;
      socket.emit('identifyError', { message: 'Not authenticated' });
      return;
    }

    const rawUsername = (data?.username || '').trim().slice(0, 15);
    const incomingAvatar = data?.avatar || null;

    // Normalize + uniqueness-check only if a username was supplied.
    let finalUsername = null;
    if (rawUsername && rawUsername.length >= 3) {
      const normalized = normalizeUsername(rawUsername);
      if (normalized && normalized.length >= 3) {
        finalUsername = await generateUniqueUsername(normalized, uid);
      }
    }

    // Ensure the row exists.
    const user = await db.ensureUserRow(uid, {
      username: finalUsername,
      avatar: incomingAvatar,
    });

    if (!user) {
      socket.emit('identifyError', { message: 'Registration failed' });
      return;
    }

    // Profile (is_premium, email state).
    const profile = await db.getProfile(uid);

    // Session replacement: if another socket already has this userId,
    // kick the OLD one. Last connect wins.
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

    // Populate players + onlinePlayers.
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

    // Decode email/isAnonymous from the JWT payload.
    // Supabase JWTs carry the auth user's email and role; anonymous
    // users have no email and is_anonymous=true in user_metadata.
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
  // migrateLegacyToken  (Chat 9)
  //   Payload: { token }
  //   Emits:   legacyMigrationResult {
  //              success, userId?, access_token?, refresh_token?, message?
  //            }
  //
  //   Old clients that still have a custom token use this to migrate
  //   in-place. Server creates a Supabase user, rewrites all rows,
  //   returns fresh session tokens. Client calls
  //   supabase.auth.setSession({ access_token, refresh_token }).
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

      // Delete the legacy token row — this client is now on Supabase Auth.
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
  // changeUsername — authenticated via socket.data.userId.
  // Syncs public.users, public.profiles, and auth.users.user_metadata.
  // ────────────────────────────────────────────────────────────
  socket.on('changeUsername', async (data) => {
    const uid = socket.data.userId;
    const newUsername = (data?.newUsername || '').trim().slice(0, 15);

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

    // Sync profile + auth metadata (best-effort — public.users is
    // the canonical game-data store; drift is a known risk).
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

    console.log('[CHANGE USERNAME]', socket.id, '→', newUsername);
  });

  // ────────────────────────────────────────────────────────────
  // deleteAccount — authenticated via socket.data.userId.
  // Deletes public.users (cascades game data) AND auth.users
  // (cascades profiles).
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
  // getAchievements / getAchievementCatalog
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

  // ─── Pull-based leaderboard ───
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

  // ─── Match screen presence ───
  socket.on('enterMatchScreen', () => {
    setPlayerStatus(socket.id, 'in-match');
  });

  socket.on('leaveMatchScreen', () => {
    setPlayerStatus(socket.id, 'online');
  });

  socket.on('searchPlayer', (data) => {
    const target = normalizeUsername(data.username || '');
    if (!target) {
      socket.emit('searchResult', { found: false, message: 'Enter a username' });
      return;
    }

    let found = null;
    for (const [socketId, player] of onlinePlayers) {
      if (socketId === socket.id) continue;
      if (player.username === target) {
        found = { socketId, ...player };
        break;
      }
    }

    if (found) {
      socket.emit('searchResult', {
        found: true,
        player: {
          id: found.socketId,
          name: found.name,
          status: found.status,
        },
      });
    } else {
      socket.emit('searchResult', {
        found: false,
        message: 'Player not found or offline',
      });
    }
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

  socket.on('respondToInvite', (data) => {
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

  socket.on('joinRoom', (data) => {
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