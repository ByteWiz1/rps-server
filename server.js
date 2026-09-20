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

const WIN_TARGET = 30;
const DISCONNECT_TIMEOUT = 20000;
const INVITE_TIMEOUT = 5 * 60 * 1000;

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

io.on('connection', (socket) => {
  console.log('[CONNECT]', socket.id);
  players.set(socket.id, { room: null, name: 'Player', username: null, userId: null });

  socket.emit('connected', { playerId: socket.id });

  // ============================================
  // IDENTITY (persistent across sessions)
  // ============================================
  socket.on('registerIdentity', (data) => {
    const userId = (data.userId || '').trim();
    const username = (data.username || '').trim().slice(0, 15);
    const avatar = data.avatar || '🤖';

    if (!userId || username.length < 3) {
      socket.emit('identityError', { message: 'Invalid identity data' });
      return;
    }

    // Remove any stale sockets for this user
    for (const [existingSocketId, existingPlayer] of onlinePlayers) {
      if (existingPlayer.userId === userId && existingSocketId !== socket.id) {
        onlinePlayers.delete(existingSocketId);
        const oldPlayer = players.get(existingSocketId);
        if (oldPlayer) oldPlayer.userId = null;
      }
    }

    // Update player record
    const player = players.get(socket.id);
    if (player) {
      player.name = username;
      player.username = normalizeUsername(username);
      player.userId = userId;
    }

    // Register in online players
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

    console.log('[IDENTITY]', socket.id, '→', username, `(${userId})`);
  });

  // ============================================
  // USERNAME REGISTRATION (legacy — used by lobby)
  // ============================================
  socket.on('registerUsername', (data) => {
    const requestedName = (data.name || '').trim().slice(0, 15);

    if (requestedName.length < 3) {
      socket.emit('usernameError', { message: 'Name must be at least 3 characters' });
      return;
    }

    const finalName = isUsernameAvailable(requestedName)
      ? requestedName
      : generateUniqueUsername(requestedName);

    const player = players.get(socket.id);
    if (!player) return;

    player.name = finalName;
    player.username = normalizeUsername(finalName);

    // Update online players (preserving userId if exists)
    const existing = onlinePlayers.get(socket.id);
    onlinePlayers.set(socket.id, {
      userId: existing?.userId || null,
      name: finalName,
      username: normalizeUsername(finalName),
      avatar: existing?.avatar || '🤖',
      status: 'online',
      socketId: socket.id,
      connectedAt: existing?.connectedAt || Date.now(),
    });

    console.log('[REGISTER]', socket.id, '→', finalName);
    socket.emit('usernameRegistered', { name: finalName });
    broadcastOnlineUsers();
    broadcastOnlineCount();
  });

  // ============================================
  // ONLINE USERS LIST (request current list)
  // ============================================
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

  // ============================================
  // SEARCH PLAYER
  // ============================================
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

  // ============================================
  // INVITES
  // ============================================
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
    });

    socket.emit('inviteSent', {
      inviteId: invite.id,
      toName: targetPlayer.name,
    });

    console.log('[INVITE]', fromPlayer.name, '→', targetPlayer.name);
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
      });

      io.to(invite.toId).emit('inviteAccepted', {
        roomCode,
        playerId: invite.toId,
        playerName: toPlayerData?.name || 'Player',
        opponentName: fromPlayerData?.name || 'Player',
        opponentId: invite.fromId,
        players: playerList,
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
      broadcastOnlineUsers();

      console.log('[ACCEPT]', fromPlayerData?.name, 'vs', toPlayerData?.name, '→ room', roomCode);
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

  // ============================================
  // ROOM MANAGEMENT
  // ============================================
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
    });

    console.log('[CREATE ROOM]', socket.id, '→', roomCode);
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

    console.log('[JOIN ROOM]', socket.id, '→', code);
  });

  // ============================================
  // GAMEPLAY
  // ============================================
  socket.on('makeMove', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;
    if (room.matchOver) return;

    room.moves[socket.id] = data.move;

    socket.to(player.room).emit('playerMoved', { playerId: socket.id });

    const bothMoved =
      room.players.length === 2 && room.players.every((id) => room.moves[id]);

    if (bothMoved) {
      const [p1, p2] = room.players;
      const move1 = room.moves[p1];
      const move2 = room.moves[p2];

      let result = 'tie';
      if (move1 !== move2) {
        const rules = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
        result = rules[move1] === move2 ? 'p1' : 'p2';
      }

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

    resetRoomScores(room);

    io.to(player.room).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
    });

    broadcastRoomState(room);
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
      room.disconnectedPlayer = null;

      if (notify) {
        io.to(player.room).emit('playerLeft', { playerId: socketId });
      }

      room.players = room.players.filter((id) => id !== socketId);
      if (room.players.length === 0) rooms.delete(player.room);

      if (onlinePlayers.has(socketId)) {
        onlinePlayers.get(socketId).status = 'online';
        broadcastOnlineUsers();
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