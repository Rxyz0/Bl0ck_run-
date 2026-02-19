const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

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

function createSeededRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function startServerGameLoop(code) {
  const room = rooms.get(code);
  if (!room || room.players.length < 2) return;

  const seed = Date.now();
  room.seed = seed;
  room.frameCount = 0;
  room.gameRunning = true;
  room.rng = createSeededRng(seed);
  room.swapTimer = 0;
  room.swapInterval = 12 * 60; // 12 seconds at 60fps
  room.score = 0; // shared score
  room.sessionCoins = 0; // shared coins

  const [p1, p2] = room.players;
  room.playerStates = {
    [p1.id]: { alive: true, respawnTimer: 0, position: 'front', lives: p1.lives || 1 },
    [p2.id]: { alive: true, respawnTimer: 0, position: 'back', lives: p2.lives || 1 }
  };

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
      skinId: p.skinId,
      skinColor: p.skinColor,
      skinGradient: p.skinGradient,
      lives: p.lives || 1
    }))
  });

  room.interval = setInterval(() => {
    if (!room.gameRunning) return;

    room.frameCount++;
    const fc = room.frameCount;
    const events = [];

    // Obstacle spawning - sync with client's obstacleSpawnRate (90 frames)
    const spawnRate = 90;
    if (fc % spawnRate === 0) {
      const rval = room.rng();
      events.push({ type: 'obstacle', rval, fc });
    }

    // Quicksand (Egypt)
    if (fc % 240 === 0 && room.mode === 'egypt') {
      events.push({ type: 'quicksand', fc });
    }

    // Coin spawn - match client rate (60 frames)
    const coinRate = 60;
    if (fc % coinRate === 0 && room.rng() > 0.3) {
      const airborne = room.rng() > 0.5;
      events.push({ type: 'coin', airborne, fc });
    }

    // Swap countdown - every 12 seconds, reset on hit
    room.swapTimer++;
    const swapTimeLeft = room.swapInterval - room.swapTimer;
    
    // Broadcast swap countdown every second
    if (swapTimeLeft % 60 === 0 && swapTimeLeft > 0) {
      io.to(code).emit('swap_countdown', { seconds: swapTimeLeft / 60 });
    }

    if (room.swapTimer >= room.swapInterval) {
      doSwap(room, code, events, 'timer');
    }

    // Respawn timers
    for (const [pid, ps] of Object.entries(room.playerStates)) {
      if (!ps.alive && ps.respawnTimer > 0) {
        ps.respawnTimer--;
        if (ps.respawnTimer === 0) {
          ps.alive = true;
          ps.lives = 1;
          events.push({ type: 'respawn', playerId: pid });
          io.to(code).emit('player_respawn', { playerId: pid });
        }
      }
    }

    if (events.length > 0) {
      io.to(code).emit('game_tick', { fc, events });
    }

    // Check both dead
    const allDead = Object.values(room.playerStates).every(ps => !ps.alive);
    if (allDead) {
      room.gameRunning = false;
      clearInterval(room.interval);
      room.interval = null;
      io.to(code).emit('game_over_all', {});
    }

  }, 1000 / 60);
}

function doSwap(room, code, events, reason) {
  room.swapTimer = 0; // always reset timer on swap
  const ids = Object.keys(room.playerStates);
  for (const pid of ids) {
    const ps = room.playerStates[pid];
    ps.position = ps.position === 'front' ? 'back' : 'front';
  }
  const positions = {};
  for (const [pid, ps] of Object.entries(room.playerStates)) {
    positions[pid] = ps.position;
  }
  events.push({ type: 'swap', positions, reason });
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ name, skinId, skinColor, skinGradient, lives }) => {
    const code = generateRoomCode();
    rooms.set(code, {
      code,
      players: [{ id: socket.id, name, skinId, skinColor, skinGradient, ready: false, lives: lives || 1 }],
      host: socket.id,
      mode: null,
      gameRunning: false,
      playerStates: {}
    });
    socket.join(code);
    socket.emit('room_created', { code, playerId: socket.id });
  });

  socket.on('join_room', ({ code, name, skinId, skinColor, skinGradient, lives }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('join_error', { msg: 'Room tidak ditemukan!' }); return; }
    if (room.players.length >= 2) { socket.emit('join_error', { msg: 'Room sudah penuh!' }); return; }
    if (room.gameRunning) { socket.emit('join_error', { msg: 'Game sudah berjalan!' }); return; }

    room.players.push({ id: socket.id, name, skinId, skinColor, skinGradient, ready: false, lives: lives || 1 });
    socket.join(code);

    socket.emit('room_joined', { code, playerId: socket.id, players: room.players });
    io.to(room.host).emit('player_joined', { players: room.players });
  });

  socket.on('update_skin', ({ skinId, skinColor, skinGradient, lives }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.skinId = skinId;
      player.skinColor = skinColor;
      player.skinGradient = skinGradient;
      player.lives = lives || 1;
      io.to(code).emit('lobby_update', { players: room.players });
    }
  });

  socket.on('player_ready', ({ lives, skinId, skinColor, skinGradient }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = true;
      player.lives = lives || 1;
      if (skinId) { player.skinId = skinId; player.skinColor = skinColor; player.skinGradient = skinGradient; }
      io.to(code).emit('lobby_update', { players: room.players });

      if (room.players.length === 2 && room.players.every(p => p.ready)) {
        // Countdown then start
        io.to(code).emit('all_ready', {});
        let count = 3;
        const cd = setInterval(() => {
          io.to(code).emit('start_countdown', { count });
          count--;
          if (count < 0) {
            clearInterval(cd);
            if (rooms.has(code) && room.mode) startServerGameLoop(code);
          }
        }, 1000);
      }
    }
  });

  socket.on('player_unready', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    if (player) { player.ready = false; io.to(code).emit('lobby_update', { players: room.players }); }
  });

  socket.on('select_map', ({ mode }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    if (socket.id !== room.host) return;
    room.mode = mode;
    room.players.forEach(p => p.ready = false);
    io.to(code).emit('map_selected', { mode });
  });

  // Player state sync (position, jumping, ducking for rendering opponent)
  socket.on('player_state', ({ y, isJumping, isDucking, x }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code } = result;
    socket.to(code).emit('opponent_state', { playerId: socket.id, y, isJumping, isDucking, x });
  });

  // Ability used — client emits 'use_ability' (fix event name mismatch)
  socket.on('use_ability', ({ abilityType, abilityId }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    socket.to(code).emit('opponent_ability', { 
      playerId: socket.id, 
      abilityType, 
      abilityId,
      name: player ? player.name : '???'
    });
  });

  // Also keep old name for backward compat
  socket.on('ability_used', ({ abilityType, abilityId }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const player = room.players.find(p => p.id === socket.id);
    socket.to(code).emit('opponent_ability', { 
      playerId: socket.id, 
      abilityType, 
      abilityId,
      name: player ? player.name : '???'
    });
  });

  // Obstacle destroyed by player/ability - sync to opponent
  // Server broadcasts to BOTH so both screens stay in sync
  socket.on('obstacle_destroyed', ({ obstacleIndex, reason }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code } = result;
    // Relay to opponent only (destroyer already removed it locally)
    socket.to(code).emit('sync_obstacle_destroy', { obstacleIndex, reason });
  });

  // Player hit by obstacle (front position) → swap
  socket.on('player_hit_front', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    if (!room.gameRunning) return;
    const ps = room.playerStates[socket.id];
    if (!ps || ps.position !== 'front') return;

    // Do immediate swap, reset timer
    const events = [];
    doSwap(room, code, events, 'hit');
    io.to(code).emit('game_tick', { fc: room.frameCount, events });
    io.to(code).emit('swap_countdown_reset', { seconds: 12 });
  });

  // Score/coin sync (server is source of truth for shared values)
  socket.on('coin_collected', ({ index }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    room.sessionCoins++;
    // Tell both players to collect this coin and update count
    io.to(code).emit('sync_coin_collect', { index, totalCoins: room.sessionCoins });
  });

  socket.on('score_update', ({ scoreRun, scoreJump }) => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    // Use max score as shared score (both should have same but just in case)
    room.score = Math.max(room.score || 0, scoreRun);
    socket.to(code).emit('opponent_score', { scoreRun, scoreJump });
  });

  // Player died
  socket.on('player_died', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;
    const ps = room.playerStates[socket.id];
    if (!ps || !ps.alive) return;

    ps.alive = false;
    ps.respawnTimer = 5 * 60; // 5 seconds at 60fps (was 25 - too long!)
    ps.lives = 0;

    socket.to(code).emit('opponent_died', { playerId: socket.id, respawnIn: 5 });
    socket.emit('you_died', { respawnIn: 5 });
  });

  socket.on('disconnect', () => {
    const result = getRoomBySocket(socket.id);
    if (!result) return;
    const { code, room } = result;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const disconnected = room.players[idx];
    room.players.splice(idx, 1);

    if (room.gameRunning) {
      socket.to(code).emit('opponent_disconnected', { name: disconnected.name });
      if (room.playerStates[socket.id]) room.playerStates[socket.id].alive = false;
      // Stop game loop since opponent disconnected
      room.gameRunning = false;
      if (room.interval) { clearInterval(room.interval); room.interval = null; }
    } else {
      socket.to(code).emit('player_left', { players: room.players });
    }

    if (room.players.length === 0) {
      if (room.interval) clearInterval(room.interval);
      rooms.delete(code);
    } else if (room.host === socket.id) {
      room.host = room.players[0].id;
      io.to(code).emit('host_changed', { newHost: room.host });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 bl0ck run multiplayer server v2 running on port ${PORT}`);
});
