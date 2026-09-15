const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();
const clients = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function sendToClient(clientId, data) {
  const client = clients.get(clientId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

function broadcastToRoom(roomCode, data, excludeClientId = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.forEach(playerId => {
    if (playerId !== excludeClientId) {
      sendToClient(playerId, data);
    }
  });
}

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).substring(2, 10);
  clients.set(clientId, { ws, room: null, name: 'Player' });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(clientId, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    handleDisconnect(clientId);
  });

  sendToClient(clientId, { type: 'connected', clientId });
});

function handleMessage(clientId, data) {
  const client = clients.get(clientId);
  if (!client) return;

  switch (data.type) {
    case 'createRoom': {
      const roomCode = generateRoomCode();
      const room = {
        code: roomCode,
        players: [clientId],
        moves: {},
        scores: { [clientId]: 0 },
        round: 0,
      };
      rooms.set(roomCode, room);
      client.room = roomCode;
      client.name = data.name || 'Player 1';

      sendToClient(clientId, {
        type: 'roomCreated',
        code: roomCode,
        playerId: clientId,
        playerName: client.name,
      });
      break;
    }

    case 'joinRoom': {
      const room = rooms.get(data.code);
      if (!room) {
        sendToClient(clientId, { type: 'error', message: 'Room not found' });
        return;
      }
      if (room.players.length >= 2) {
        sendToClient(clientId, { type: 'error', message: 'Room is full' });
        return;
      }

      room.players.push(clientId);
      room.scores[clientId] = 0;
      client.room = data.code;
      client.name = data.name || 'Player 2';

      broadcastToRoom(data.code, {
        type: 'playerJoined',
        players: room.players.map(id => ({
          id,
          name: clients.get(id)?.name || 'Player',
        })),
        playerId: clientId,
        playerName: client.name,
      });
      break;
    }

    case 'makeMove': {
      const room = rooms.get(client.room);
      if (!room) return;

      room.moves[clientId] = data.move;

      broadcastToRoom(client.room, {
        type: 'playerMoved',
        playerId: clientId,
      }, clientId);

      const bothMoved = room.players.length === 2 && room.players.every(id => room.moves[id]);

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
        room.round++;

        broadcastToRoom(client.room, {
          type: 'roundResult',
          moves: { [p1]: move1, [p2]: move2 },
          result,
          scores: room.scores,
          round: room.round,
        });

        room.moves = {};
      }
      break;
    }

    case 'resetGame': {
      const room = rooms.get(client.room);
      if (!room) return;

      room.moves = {};
      room.round = 0;
      room.players.forEach(id => {
        room.scores[id] = 0;
      });

      broadcastToRoom(client.room, {
        type: 'gameReset',
        scores: room.scores,
      });
      break;
    }

    case 'leaveRoom': {
      handleDisconnect(clientId);
      break;
    }
  }
}

function handleDisconnect(clientId) {
  const client = clients.get(clientId);
  if (!client) return;

  if (client.room) {
    const room = rooms.get(client.room);
    if (room) {
      broadcastToRoom(client.room, {
        type: 'playerLeft',
        playerId: clientId,
      }, clientId);

      room.players = room.players.filter(id => id !== clientId);
      if (room.players.length === 0) {
        rooms.delete(client.room);
      }
    }
  }

  clients.delete(clientId);
}

app.get('/', (req, res) => {
  res.send('RPS Arena Server is running');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});