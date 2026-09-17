const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map();
const players = new Map();

const WIN_TARGET = 30;
const DISCONNECT_TIMEOUT = 20000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getRoomPlayers(room) {
  return room.players.map((id) => ({
    id,
    name: players.get(id)?.name || 'Player',
  }));
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  players.set(socket.id, { room: null, name: 'Player', disconnected: false });

  socket.emit('connected', { playerId: socket.id });

  socket.on('createRoom', (data) => {
    const roomCode = generateRoomCode();
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
    players.get(socket.id).room = roomCode;
    players.get(socket.id).name = data.name || 'Player 1';

    socket.join(roomCode);

    socket.emit('roomCreated', {
      code: roomCode,
      playerId: socket.id,
      playerName: data.name,
    });
  });

  socket.on('joinRoom', (data) => {
  const room = rooms.get(data.code);
  if (!room) {
    socket.emit('error', { message: 'Room not found' });
    return;
  }
  if (room.players.length >= 2) {
    socket.emit('error', { message: 'Room is full' });
    return;
  }

  room.players.push(socket.id);
  room.scores[socket.id] = 0;
  room.ties[socket.id] = 0;
  players.get(socket.id).room = data.code;
  players.get(socket.id).name = data.name || 'Player 2';

  socket.join(data.code);

  const playerList = getRoomPlayers(room);

  // Notify the host that someone joined
  io.to(data.code).emit('playerJoined', {
    players: playerList,
    playerId: socket.id,
    playerName: data.name,
  });

  // Send full room state to the joiner
  socket.emit('roomState', {
    players: playerList,
    playerId: socket.id,
  });
});

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

      const p1Score = room.scores[p1];
      const p2Score = room.scores[p2];

      let matchWinner = null;
      if (p1Score >= WIN_TARGET) matchWinner = p1;
      else if (p2Score >= WIN_TARGET) matchWinner = p2;

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
        matchWinner: matchWinner,
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

    room.moves = {};
    room.round = 0;
    room.matchOver = false;
    room.winner = null;
    room.players.forEach((id) => {
      room.scores[id] = 0;
      room.ties[id] = 0;
    });

    io.to(player.room).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
    });
  });

  socket.on('resetGame', () => {
    const player = players.get(socket.id);
    if (!player || !player.room) return;

    const room = rooms.get(player.room);
    if (!room) return;

    room.moves = {};
    room.round = 0;
    room.matchOver = false;
    room.winner = null;
    room.players.forEach((id) => {
      room.scores[id] = 0;
      room.ties[id] = 0;
    });

    io.to(player.room).emit('gameReset', {
      scores: room.scores,
      ties: room.ties,
    });
  });

  socket.on('leaveRoom', () => {
    handleLeave(socket.id, true);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    handleDisconnect(socket.id);
  });
});

function handleDisconnect(socketId) {
  const player = players.get(socketId);
  if (!player) return;

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
        winnerId: winnerId,
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
    }
  }

  players.delete(socketId);
  socket && players.delete(socketId);
}

app.get('/', (req, res) => {
  res.send('RPS Arena Server is running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});