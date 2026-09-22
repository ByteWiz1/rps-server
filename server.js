const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const rooms = new Map();
const players = new Map();
const onlinePlayers = new Map();
const activeInvites = new Map();
const recentOpponents = new Map();
const matchHistory = new Map();
const playerStats = new Map();

const WIN_TARGET = 30;
const DISCONNECT_TIMEOUT = 20000;
const INVITE_TIMEOUT = 5 * 60 * 1000;
const AVATAR_ROUND_DELAY = 2000;
const MAX_HISTORY = 20;

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

function isUsernameAvailable(name) {
  const normalized = normalizeUsername(name);
  if (!normalized) return false;
  for (const [, player] of onlinePlayers) {
    if (player.username === normalized) return false;
  }
  return true;
}

function generateUniqueUsername(baseName) {
  let name = baseName;
  let counter = 1;
  while (!isUsernameAvailable(name)) {
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
  return room.players.map((id) => ({
    id,
    name: players.get(id)?.name || 'Player',
  }));
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
  room.players.forEach((id) => {
    if (onlinePlayers.has(id)) {
      onlinePlayers.get(id).status = 'online';
    }
  });
  broadcastOnlineUsers();
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

function recordMatchResult(room) {
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

  const baseMatch = {
    mode: room.battleMode,
    p1Score: room.scores[p1] || 0,
    p2Score: room.scores[p2] || 0,
    p1Ties: room.ties[p1] || 0,
    p2Ties: room.ties[p2] || 0,
    rounds: room.round,
    timestamp: Date.now(),
  };

  const p1History = matchHistory.get(p1UserId) || [];
  p1History.unshift({
    ...baseMatch,
    opponent: p2Name,
    opponentId: p2UserId,
    result: p1Won ? 'win' : 'loss',
    myScore: baseMatch.p1Score,
    theirScore: baseMatch.p2Score,
  });
  matchHistory.set(p1UserId, p1History.slice(0, MAX_HISTORY));

  const p1Stats = playerStats.get(p1UserId) || { wins: 0, losses: 0, ties: 0, total: 0 };
  if (p1Won) p1Stats.wins++;
  else p1Stats.losses++;
  p1Stats.total = p1Stats.wins + p1Stats.losses;
  playerStats.set(p1UserId, p1Stats);

  const p2History = matchHistory.get(p2UserId) || [];
  p2History.unshift({
    ...baseMatch,
    opponent: p1Name,
    opponentId: p1UserId,
    result: p2Won ? 'win' : 'loss',
    myScore: baseMatch.p2Score,
    theirScore: baseMatch.p1Score,
  });
  matchHistory.set(p2UserId, p2History.slice(0, MAX_HISTORY));

  const p2Stats = playerStats.get(p2UserId) || { wins: 0, losses: 0, ties: 0, total: 0 };
  if (p2Won) p2Stats.wins++;
  else p2Stats.losses++;
  p2Stats.total = p2Stats.wins + p2Stats.losses;
  playerStats.set(p2UserId, p2Stats);

  io.to(p1).emit('playerStats', { stats: playerStats.get(p1UserId) });
  io.to(p2).emit('playerStats', { stats: playerStats.get(p2UserId) });

  console.log('[MATCH RECORDED]', p1Name, 'vs', p2Name, '→ winner:', room.winner === p1 ? p1Name : p2Name);
}

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

  const runRound = () => {
    const r = rooms.get(roomCode);
    if (!r) return;
    if (r.matchOver) return;
    if (r.players.length < 2) return;

    const [p1, p2] = r.players;
    const moves = ['rock', 'paper', 'scissors'];
    const move1 = moves[Math.floor(Math.random() * moves.length)];
    const move2 = moves[Math.floor(Math.random() * moves.length)];

    io.to(roomCode).emit('playerMoved', { playerId: p1 });
    io.to(roomCode).emit('playerMoved', { playerId: p2 });

    const result = resolveRound(move1, move2);

    if (result === 'p1') r.scores[p1]++;
    else if (result === 'p2') r.scores[p2]++;
    else {
      r.ties[p1] = (r.ties[p1] || 0) + 1;
      r.ties[p2] = (r.ties[p2] || 0) + 1;
    }
    r.round++;

    let matchWinner = null;
    if (r.scores[p1] >= WIN_TARGET) matchWinner = p1;
    else if (r.scores[p2] >= WIN_TARGET) matchWinner = p2;

    if (matchWinner) {
      r.matchOver = true;
      r.winner = matchWinner;
      resetPlayersToOnline(r);
      recordMatchResult(r);
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

io.on('connection', (socket) => {
  console.log('[CONNECT]', socket.id);
  players.set(socket.id, { room: null, name: 'Player', username: null, userId: null });

  socket.emit('connected', { playerId: socket.id });

  socket.on('registerIdentity', (data) => {
    const userId = (data.userId || '').trim();
    const username = (data.username || '').trim().slice(0, 15);
    const avatar = data.avatar || '🤖';

    if (!userId || username.length < 3) {
      socket.emit('identityError', { message: 'Invalid identity data' });
      return;
    }

    for (const [existingSocketId, existingPlayer] of onlinePlayers) {
      if (existingPlayer.userId === userId && existingSocketId !== socket.id) {
        onlinePlayers.delete(existingSocketId);
        const oldPlayer = players.get(existingSocketId);
        if (oldPlayer) oldPlayer.userId = null;
      }
    }

    const player = players.get(socket.id);
    if (player) {
      player.name = username;
      player.username = normalizeUsername(username);
      player.userId = userId;
    }

    onlinePlayers.set(socket.id, {
      userId,
      name: username,
      username: normalizeUsername(username),
      avatar,
      status: 'online',
      socketId: socket.id,
      connectedAt: Date.now(),
    });

    broadcastOnlineUsers();
    broadcastOnlineCount();

    const existingStats = playerStats.get(userId) || { wins: 0, losses: 0, ties: 0, total: 0 };
    socket.emit('playerStats', { stats: existingStats });

    console.log('[IDENTITY]', socket.id, '→', username, `(${userId})`);
  });

  socket.on('changeUsername', (data) => {
    const newUsername = (data.newUsername || '').trim().slice(0, 15);
    const userId = (data.userId || '').trim();

    if (!userId || newUsername.length < 3) {
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

    let taken = false;
    for (const [socketId, player] of onlinePlayers) {
      if (socketId === socket.id) continue;
      if (player.username === normalized) {
        taken = true;
        break;
      }
    }

    if (taken) {
      socket.emit('changeUsernameResult', {
        success: false,
        message: 'That username is already taken',
      });
      return;
    }

    const player = players.get(socket.id);
    if (player) {
      player.name = newUsername;
      player.username = normalized;
    }

    if (onlinePlayers.has(socket.id)) {
      const entry = onlinePlayers.get(socket.id);
      entry.name = newUsername;
      entry.username = normalized;
    }

    broadcastOnlineUsers();

    socket.emit('changeUsernameResult', {
      success: true,
      username: newUsername,
      message: 'Username updated',
    });

    console.log('[CHANGE USERNAME]', socket.id, '→', newUsername);
  });

  socket.on('deleteAccount', () => {
    console.log('[DELETE ACCOUNT]', socket.id);

    const player = players.get(socket.id);
    const userId = player?.userId || onlinePlayers.get(socket.id)?.userId;

    if (player && player.room) {
      handleLeave(socket.id, true);
    }

    onlinePlayers.delete(socket.id);
    broadcastOnlineUsers();
    broadcastOnlineCount();

    players.delete(socket.id);

    if (userId) {
      matchHistory.delete(userId);
      playerStats.delete(userId);
    }

    socket.emit('deleteAccountResult', {
      success: true,
      message: 'Account deleted',
    });

    setTimeout(() => {
      socket.disconnect(true);
    }, 300);
  });

  socket.on('getMatchHistory', () => {
    const player = players.get(socket.id);
    const userId = player?.userId || onlinePlayers.get(socket.id)?.userId;
    if (!userId) {
      socket.emit('matchHistory', { matches: [] });
      return;
    }
    const matches = matchHistory.get(userId) || [];
    socket.emit('matchHistory', { matches });
  });

  socket.on('getPlayerStats', () => {
    const player = players.get(socket.id);
    const userId = player?.userId || onlinePlayers.get(socket.id)?.userId;
    if (!userId) {
      socket.emit('playerStats', { stats: { wins: 0, losses: 0, ties: 0, total: 0 } });
      return;
    }
    const stats = playerStats.get(userId) || { wins: 0, losses: 0, ties: 0, total: 0 };
    socket.emit('playerStats', { stats });
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
      battleMode: data.battleMode || 'human', // ← FIX: from client or default
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

      // ← FIX: invite's mode is the source of truth
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
      };
      rooms.set(roomCode, room);

      const fromPlayerData = players.get(invite.fromId);
      const toPlayerData = players.get(invite.toId);
      if (fromPlayerData) fromPlayerData.room = roomCode;
      if (toPlayerData) toPlayerData.room = roomCode;

      if (onlinePlayers.has(invite.fromId)) {
        onlinePlayers.get(invite.fromId).status = 'in-match';
      }
      if (onlinePlayers.has(invite.toId)) {
        onlinePlayers.get(invite.toId).status = 'in-match';
      }
      broadcastOnlineUsers();

      const fromSocket = io.sockets.sockets.get(invite.fromId);
      const toSocket = io.sockets.sockets.get(invite.toId);
      if (fromSocket) fromSocket.join(roomCode);
      if (toSocket) toSocket.join(roomCode);

      const playerList = getRoomPlayers(room);

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

      io.to(roomCode).emit('roomState', {
        players: playerList,
        scores: room.scores,
        ties: room.ties,
        round: room.round,
        matchOver: room.matchOver,
        winner: room.winner,
        winTarget: WIN_TARGET,
      });

      recordRecentOpponent(invite.fromId, invite.toId);
      recordRecentOpponent(invite.toId, invite.fromId);

      // ← FIX: auto-play with longer setup delay so both clients are ready
      if (room.battleMode === 'avatar') {
        console.log('[ACCEPT] Scheduling avatar auto-play for room', roomCode);
        setTimeout(() => startAvatarAutoPlay(roomCode), 2000);
      }

      console.log('[ACCEPT]', fromPlayerData?.name, 'vs', toPlayerData?.name, '→ room', roomCode, `(${room.battleMode})`);
    } else {
      invite.status = 'declined';
      io.to(invite.fromId).emit('inviteDeclined', { inviteId: invite.id });
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

    const player = players.get(socket.id);
    if (player) {
      player.room = code;
      if (data.name) player.name = data.name;
    }

    socket.join(code);

    if (onlinePlayers.has(socket.id)) {
      onlinePlayers.get(socket.id).status = 'in-match';
    }
    if (onlinePlayers.has(room.players[0])) {
      onlinePlayers.get(room.players[0]).status = 'in-match';
    }
    broadcastOnlineUsers();

    resetRoomScores(room);
    broadcastRoomState(room);

    io.to(code).emit('playerJoined', {
      players: getRoomPlayers(room),
      playerId: socket.id,
      playerName: player?.name || 'Player 2',
    });

    io.to(code).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
    });

    console.log('[JOIN ROOM]', socket.id, '→', code, `(${room.battleMode})`);
    console.log('[JOIN ROOM] battleMode:', room.battleMode, '| players:', room.players.length);

    // ← FIX: auto-play with setup delay
    if (room.battleMode === 'avatar' && room.players.length === 2) {
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

      let matchWinner = null;
      if (room.scores[p1] >= WIN_TARGET) matchWinner = p1;
      else if (room.scores[p2] >= WIN_TARGET) matchWinner = p2;

      if (matchWinner) {
        room.matchOver = true;
        room.winner = matchWinner;
        resetPlayersToOnline(room);
        recordMatchResult(room);
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

    resetRoomScores(room);
    resetPlayersToOnline(room);

    io.to(player.room).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
    });

    broadcastRoomState(room);

    if (room.battleMode === 'avatar' && room.players.length === 2) {
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
      resetPlayersToOnline(room);
      recordMatchResult(room);
      io.to(winnerId).emit('opponentTimedOut', {
        winnerId,
        loserId: disconnectedId,
      });
    }

    room.players = room.players.filter((id) => id !== disconnectedId);
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

      if (notify) {
        io.to(player.room).emit('playerLeft', { playerId: socketId });
      }

      room.players = room.players.filter((id) => id !== socketId);
      if (room.players.length === 0) rooms.delete(player.room);

      if (onlinePlayers.has(socketId)) {
        onlinePlayers.get(socketId).status = 'online';
      }
      if (room) {
        resetPlayersToOnline(room);
      }
    }
  }

  players.delete(socketId);
}

app.get('/', (req, res) => {
  res.send('RPS Arena Server is running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});