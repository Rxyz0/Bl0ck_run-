require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// DATABASE (PostgreSQL - Railway)
// ============================================================
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  async function initDB() {
    const client = await pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS players (
          id          SERIAL PRIMARY KEY,
          name        VARCHAR(16) UNIQUE NOT NULL,
          name_lower  VARCHAR(16) UNIQUE NOT NULL,
          player_id   VARCHAR(64) UNIQUE NOT NULL,
          created_at  TIMESTAMP DEFAULT NOW(),
          updated_at  TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS scores (
          id          SERIAL PRIMARY KEY,
          player_id   VARCHAR(64) NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
          player_name VARCHAR(16) NOT NULL,
          mode        VARCHAR(16) NOT NULL,
          score_type  VARCHAR(8)  NOT NULL CHECK (score_type IN ('jump','run')),
          score       INTEGER     NOT NULL DEFAULT 0,
          created_at  TIMESTAMP DEFAULT NOW(),
          UNIQUE (player_id, mode, score_type)
        );

        CREATE INDEX IF NOT EXISTS idx_scores_mode_type ON scores(mode, score_type);
        CREATE INDEX IF NOT EXISTS idx_scores_player    ON scores(player_id);
      `);
      console.log('✅ Database ready');
    } catch (err) {
      console.error('❌ DB init error:', err.message);
    } finally {
      client.release();
    }
  }
  initDB();
} else {
  console.warn('⚠️  DATABASE_URL not set — leaderboard disabled, multiplayer still works');
}

const VALID_MODES = ['egypt','day','night','snow','ocean','sakura','ramadan'];
const VALID_TYPES = ['jump','run'];

// ============================================================
// LEADERBOARD API ROUTES
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: !!pool });
});

// Check name availability
app.get('/api/player/check/:name', async (req, res) => {
  if (!pool) return res.json({ available: true });
  const name = req.params.name.trim();
  if (!name || name.length < 2 || name.length > 16)
    return res.json({ available: false, reason: 'Nama harus 2-16 karakter' });
  try {
    const r = await pool.query('SELECT player_id FROM players WHERE name_lower=$1', [name.toLowerCase()]);
    res.json({ available: r.rows.length === 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Register / rename player
app.post('/api/player/register', async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { player_id, name } = req.body;
  if (!player_id || !name) return res.status(400).json({ error: 'player_id dan name wajib' });
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 16)
    return res.status(400).json({ error: 'Nama harus 2-16 karakter' });
  if (!/^[a-zA-Z0-9_]+$/.test(trimmed))
    return res.status(400).json({ error: 'Hanya huruf, angka, underscore' });

  const client = await pool.connect();
  try {
    // Cek nama dipakai player LAIN
    const check = await client.query(
      'SELECT player_id FROM players WHERE name_lower=$1', [trimmed.toLowerCase()]
    );
    if (check.rows.length > 0 && check.rows[0].player_id !== player_id)
      return res.status(409).json({ error: 'Nama sudah dipakai', code: 'NAME_TAKEN' });

    await client.query(`
      INSERT INTO players (player_id, name, name_lower)
      VALUES ($1,$2,$3)
      ON CONFLICT (player_id) DO UPDATE
        SET name=$2, name_lower=$3, updated_at=NOW()
    `, [player_id, trimmed, trimmed.toLowerCase()]);

    // Sync name ke tabel scores
    await client.query('UPDATE scores SET player_name=$1 WHERE player_id=$2', [trimmed, player_id]);

    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Nama sudah dipakai', code: 'NAME_TAKEN' });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Submit score (only update if higher)
app.post('/api/scores', async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { player_id, mode, score_type, score } = req.body;
  if (!player_id || !mode || !score_type || score === undefined)
    return res.status(400).json({ error: 'Field tidak lengkap' });
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode tidak valid' });
  if (!VALID_TYPES.includes(score_type)) return res.status(400).json({ error: 'Type tidak valid' });
  if (typeof score !== 'number' || score < 0) return res.status(400).json({ error: 'Score tidak valid' });

  try {
    const pr = await pool.query('SELECT name FROM players WHERE player_id=$1', [player_id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Player belum register', code: 'NOT_REGISTERED' });

    await pool.query(`
      INSERT INTO scores (player_id, player_name, mode, score_type, score)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (player_id, mode, score_type) DO UPDATE
        SET score = GREATEST(scores.score, EXCLUDED.score),
            player_name = EXCLUDED.player_name,
            created_at = CASE WHEN EXCLUDED.score > scores.score THEN NOW() ELSE scores.created_at END
    `, [player_id, pr.rows[0].name, mode, score_type, score]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get leaderboard top 10
app.get('/api/leaderboard/:mode/:type', async (req, res) => {
  if (!pool) return res.json({ mode: req.params.mode, type: req.params.type, entries: [] });
  const { mode, type } = req.params;
  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode tidak valid' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Type tidak valid' });

  try {
    const r = await pool.query(`
      SELECT ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC) AS rank,
             player_name AS name, score
      FROM scores WHERE mode=$1 AND score_type=$2
      ORDER BY score DESC, created_at ASC LIMIT 10
    `, [mode, type]);
    res.json({ mode, type, entries: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// ROOM MANAGEMENT (Multiplayer - tidak diubah)
// ============================================================
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
  if (!room) return;

  const seed = Date.now();
  room.seed = seed;
  room.frameCount = 0;
  room.gameRunning = true;
  room.rng = createSeededRng(seed);
  room.swapTimer = 0;
  room.swapInterval = 600;
  room.playerStates = {};

  const [p1, p2] = room.players;
  room.playerStates[p1.id] = { alive: true, respawnTimer: 0, position: 'front', lives: p1.lives || 1 };
  room.playerStates[p2.id] = { alive: true, respawnTimer: 0, position: 'back', lives: p2.lives || 1 };

  io.to(code).emit('game_start', {
    seed, mode: room.mode,
    positions: { [p1.id]: 'front', [p2.id]: 'back' },
    players: room.players.map(p => ({ id: p.id, name: p.name, skin: p.skin, lives: p.lives || 1 }))
  });

  room.interval = setInterval(() => {
    if (!room.gameRunning) return;
    room.frameCount++;
    room.swapTimer++;
    const events = [];

    if (room.swapTimer % 60 === 0) {
      const secondsLeft = Math.ceil((room.swapInterval - room.swapTimer) / 60);
      if (secondsLeft > 0 && secondsLeft <= 5)
        io.to(code).emit('swap_countdown', { seconds: secondsLeft });
    }

    if (room.swapTimer >= room.swapInterval) {
      room.swapTimer = 0;
      for (const ps of Object.values(room.playerStates))
        ps.position = ps.position === 'front' ? 'back' : 'front';
      events.push({ type: 'swap', positions: Object.fromEntries(
        Object.entries(room.playerStates).map(([id, s]) => [id, s.position])
      )});
    }

    for (const [pid, ps] of Object.entries(room.playerStates)) {
      if (!ps.alive && ps.respawnTimer > 0) {
        ps.respawnTimer--;
        if (ps.respawnTimer === 0) { ps.alive = true; events.push({ type: 'respawn', playerId: pid }); }
      }
    }

    if (events.length > 0) io.to(code).emit('game_tick', { fc: room.frameCount, events });

    if (Object.values(room.playerStates).every(ps => !ps.alive)) {
      room.gameRunning = false;
      clearInterval(room.interval);
      io.to(code).emit('game_over_all', {});
    }
  }, 1000 / 60);
}

// ============================================================
// SOCKET EVENTS (tidak diubah)
// ============================================================
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('create_room', ({ name, skin }) => {
    const code = generateRoomCode();
    rooms.set(code, {
      code, players: [{ id: socket.id, name, skin, ready: false, lives: 1 }],
      host: socket.id, mode: null, gameRunning: false,
      seed: null, frameCount: 0, interval: null, playerStates: {}
    });
    socket.join(code);
    socket.emit('room_created', { code, playerId: socket.id });
  });

  socket.on('join_room', ({ code, name, skin }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('join_error', { msg: 'Room tidak ditemukan!' }); return; }
    if (room.players.length >= 2) { socket.emit('join_error', { msg: 'Room sudah penuh!' }); return; }
    if (room.gameRunning) { socket.emit('join_error', { msg: 'Game sudah berjalan!' }); return; }
    room.players.push({ id: socket.id, name, skin, ready: false, lives: 1 });
    socket.join(code);
    socket.emit('room_joined', { code, playerId: socket.id, players: room.players });
    io.to(room.host).emit('player_joined', { players: room.players });
  });

  socket.on('update_skin', ({ skin }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const p = r.room.players.find(p => p.id === socket.id);
    if (p) { p.skin = skin; io.to(r.code).emit('lobby_update', { players: r.room.players }); }
  });

  socket.on('player_ready', ({ lives }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const { code, room } = r;
    const p = room.players.find(p => p.id === socket.id);
    if (!p) return;
    p.ready = true; p.lives = lives || 1;
    io.to(code).emit('lobby_update', { players: room.players });
    if (room.players.length === 2 && room.players.every(p => p.ready) && room.mode) {
      io.to(code).emit('all_ready', {});
      let count = 3;
      const cd = setInterval(() => {
        io.to(code).emit('start_countdown', { count });
        count--;
        if (count < 0) { clearInterval(cd); if (rooms.has(code)) startServerGameLoop(code); }
      }, 1000);
    } else if (room.players.length === 2 && room.players.every(p => p.ready) && !room.mode) {
      io.to(code).emit('all_ready', {});
      io.to(room.host).emit('pick_map', {});
    }
  });

  socket.on('select_map', ({ mode }) => {
    const r = getRoomBySocket(socket.id);
    if (!r || socket.id !== r.room.host) return;
    r.room.mode = mode;
    io.to(r.code).emit('map_selected', { mode });
  });

  socket.on('player_died', () => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const ps = r.room.playerStates[socket.id];
    if (!ps || !ps.alive) return;
    ps.alive = false; ps.respawnTimer = 25 * 60;
    socket.to(r.code).emit('opponent_died', { playerId: socket.id, respawnIn: 25 });
    socket.emit('you_died', { respawnIn: 25 });
  });

  socket.on('score_update', ({ scoreRun, scoreJump }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    socket.to(r.code).emit('opponent_score', { playerId: socket.id, scoreRun, scoreJump });
  });

  socket.on('use_ability', ({ abilityType }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const p = r.room.players.find(p => p.id === socket.id);
    socket.to(r.code).emit('opponent_ability', { playerId: socket.id, abilityType, name: p?.name || '???' });
  });

  socket.on('player_state', ({ y, x, isJumping, isDucking }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    socket.to(r.code).emit('opponent_state', { playerId: socket.id, y, x, isJumping, isDucking });
  });

  socket.on('obstacle_destroyed', ({ obstacleIndex, reason }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    socket.to(r.code).emit('sync_obstacle_destroy', { obstacleIndex, reason });
  });

  socket.on('coin_collected', ({ index }) => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    if (!r.room.sessionCoins) r.room.sessionCoins = 0;
    r.room.sessionCoins++;
    io.to(r.code).emit('sync_coin_collect', { index, totalCoins: r.room.sessionCoins });
  });

  socket.on('player_unready', () => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const p = r.room.players.find(p => p.id === socket.id);
    if (p) { p.ready = false; io.to(r.code).emit('lobby_update', { players: r.room.players }); }
  });

  socket.on('disconnect', () => {
    const r = getRoomBySocket(socket.id);
    if (!r) return;
    const { code, room } = r;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const disc = room.players.splice(idx, 1)[0];
    if (room.gameRunning) {
      socket.to(code).emit('opponent_disconnected', { name: disc.name });
      if (room.playerStates[socket.id]) room.playerStates[socket.id].alive = false;
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

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 bl0ck run server running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}/game.html`);
});
