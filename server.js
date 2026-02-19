const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));

// =====================
// ROOM MANAGEMENT
// =====================
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function getRoomBySocket(socketId) {
  for (const [code, room] of rooms) {
    if (room.players.some(p => p.id === socketId)) return { code, room };
  }
  return null;
}

// =====================
// SEEDED RANDOM (for deterministic obstacle generation)
// =====================
function createSeededRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// =====================
// GAME LOOP (server-side obstacle timing)
// =====================
function startServerGameLoop(code) {
  const room = rooms.get(code);
  if (!room) return;

  const seed = Date.now();
  room.seed = seed;
  room.frameCount = 0;
  room.gameRunning = true;
  room.rng = createSeededRng(seed);
  room.swapTimer = 0;        // frames until next swap (600 = 10s at 60fps)
  room.swapInterval = 600;
  room.playerStates = {};    // { socketId: { alive, respawnTimer, position: 'front'|'back' } }

  // Init player states
  const [p1, p2] = room.players;
  room.playerStates[p1.id] = { alive: true, respawnTimer: 0, position: 'front', lives: p1.lives || 1 };
  room.playerStates[p2.id] = { alive: true, respawnTimer: 0, position: 'back', lives: p2.lives || 1 };

  // Broadcast seed and initial positions
  io.to(code).emit('game_start', {
    seed,
    mode: room.mode,
    positions: {
      [p1.id]: 'front',
      [p2.id]: 'back'
    },
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      skin: p.skin,
      lives: p.lives || 1
    }))
  });

  // Tick at 60fps
  room.interval = setInterval(() => {
    if (!room.gameRunning) return;

    room.frameCount++;
    const fc = room.frameCount;

    // --- Obstacle spawn events ---
    const spawnRate = 90; // medium quality default
    const coinRate = 60;

    const events = [];

    if (fc % spawnRate === 0) {
      const rval = room.rng();
      events.push({ type: 'obstacle', rval, fc });
    }

    if (fc % 240 === 0 && room.mode === 'egypt') {
      events.push({ type: 'quicksand', fc });
    }

    if (fc % coinRate === 0 && room.rng() > 0.3) {
      const airborne = room.rng() > 0.5;
      events.push({ type: 'coin', airborne, fc });
    }

    // --- Swap position countdown ---
    room.swapTimer++;
    if (room.swapTimer >= room.swapInterval) {
      room.swapTimer = 0;
      // Swap positions
      for (const pid of Object.keys(room.playerStates)) {
        const ps = room.playerStates[pid];
        ps.position = ps.position === 'front' ? 'back' : 'front';
      }
      events.push({ type: 'swap', positions: { ...Object.fromEntries(Object.entries(room.playerStates).map(([id, s]) => [id, s.position])) } });
    }

    // --- Respawn timers ---
    for (const [pid, ps] of Object.entries(room.playerStates)) {
      if (!ps.alive && ps.respawnTimer > 0) {
        ps.respawnTimer--;
        if (ps.respawnTimer === 0) {
          ps.alive = true;
          events.push({ type: 'respawn', playerId: pid });
          io.to(code).emit('player_respawn', { playerId: pid });
        }
      }
    }

    // Emit tick
    if (events.length > 0) {
      io.to(code).emit('game_tick', { fc, events });
    }

    // Check game over (both dead)
    const allDead = Object.values(room.playerStates).every(ps => !ps.alive);
    if (allDead) {
      room.gameRunning = false;
      clearInterval(room.interval);
      io.to(code).emit('game_over_all', {});
    }

  }, 1000 / 60);
}

// =====================
// SOCKET EVENTS
// =====================
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // --- CREATE ROOM ---
  socket.on('create_room', ({ name, skin }) => {
    const code = generateRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name, skin, ready: false, lives: 1 }],
      host: socket.id,
      mode: null,
      gameRunning: false,
      seed: null,
      frameCount: 0,
      interval: null,
      playerStates: {}
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_created', { code, playerId: socket.id });
    console.log(`Room ${code} created by ${name}`);
  });

  // --- JOIN ROOM ---
  socket.on('join_room', ({ code, name, skin }) => {
    const room = rooms.get(code);
    if (!room) {
      socket.emit('join_error', { msg: 'Room tidak ditemukan!' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('join_error', { msg: 'Room sudah penuh!' });
      return;
    }
    if (room.gameRunning) {
      socket.emit('join_error', { msg: 'Game sudah berjalan!' });
      return;
    }

    room.players.push({ id: socket.id, name, skin, ready: false, lives: 1 });
    socket.join(code);

    // Notify both players
    socket.emit('room_joined', {
      code,
      playerId: socket.id,
      players: room.players
    });

    // Notify host that someone joined
    io.to(room.host).emit('player_joined', {
      players: room.players
    });
    console.log(`${name} joined room ${code}`);
  });

  // --- UPDATE SKIN (in lobby) ---
  socket.on('update_skin', ({ skin }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.skin = skin;
      io.to(code).emit('lobby_update', { players: room.players });
    }
  });

  // --- PLAYER READY ---
  socket.on('player_ready', ({ lives }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = true;
      player.lives = lives || 1;
      io.to(code).emit('lobby_update', { players: room.players });

      // Both ready → go to map select (host picks)
      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        io.to(room.host).emit('pick_map', {});
        io.to(code).emit('all_ready', {});
      }
    }
  });

  // --- HOST PICKS MAP ---
  socket.on('select_map', ({ mode }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    if (socket.id !== room.host) return;
    room.mode = mode;

    // Reset ready states
    room.players.forEach(p => p.ready = false);

    io.to(code).emit('map_selected', { mode });

    // Start game after short delay
    setTimeout(() => {
      if (rooms.has(code)) startServerGameLoop(code);
    }, 1000);
  });

  // --- PLAYER DIED ---
  socket.on('player_died', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const ps = room.playerStates[socket.id];
    if (!ps || !ps.alive) return;

    ps.alive = false;
    ps.respawnTimer = 25 * 60; // 25 seconds at 60fps

    // Notify other player
    socket.to(code).emit('opponent_died', { playerId: socket.id, respawnIn: 25 });
    socket.emit('you_died', { respawnIn: 25 });

    console.log(`Player ${socket.id} died in room ${code}`);
  });

  // --- SCORE UPDATE ---
  socket.on('score_update', ({ scoreRun, scoreJump }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code } = result;
    socket.to(code).emit('opponent_score', { playerId: socket.id, scoreRun, scoreJump });
  });

  // --- SKILL USED (relay to opponent for visual) ---
  socket.on('skill_used', ({ skillId }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code } = result;
    socket.to(code).emit('opponent_skill', { playerId: socket.id, skillId });
  });

  // --- PLAYER UNREADY (cancel ready in lobby) ---
  socket.on('player_unready', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = false;
      io.to(code).emit('lobby_update', { players: room.players });
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;

    const disconnected = room.players[playerIdx];
    room.players.splice(playerIdx, 1);

    console.log(`${disconnected.name} disconnected from room ${code}`);

    if (room.gameRunning) {
      // Game continues, notify remaining player
      socket.to(code).emit('opponent_disconnected', { name: disconnected.name });
      // Stop game loop tracking for disconnected player
      if (room.playerStates[socket.id]) {
        room.playerStates[socket.id].alive = false;
      }
    } else {
      // In lobby, notify remaining player
      socket.to(code).emit('player_left', { players: room.players });
    }

    // If room empty, clean up
    if (room.players.length === 0) {
      if (room.interval) clearInterval(room.interval);
      rooms.delete(code);
      console.log(`Room ${code} deleted`);
    } else if (room.host === socket.id && room.players.length > 0) {
      // Transfer host
      room.host = room.players[0].id;
      io.to(code).emit('host_changed', { newHost: room.host });
    }
  });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 bl0ck run multiplayer server running on port ${PORT}`);
  console.log(`   Open: http://localhost:${PORT}/game.html`);
});
