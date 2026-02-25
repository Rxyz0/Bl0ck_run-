require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

// Simple password hashing using built-in crypto (no extra deps needed)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const hashVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === hashVerify;
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

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
          score_type  VARCHAR(8)  NOT NULL CHECK (score_type IN ('jump','run','coin')),
          score       INTEGER     NOT NULL DEFAULT 0,
          created_at  TIMESTAMP DEFAULT NOW(),
          UNIQUE (player_id, mode, score_type)
        );

        -- Daily scores: reset setiap hari — menyimpan score terbaik per hari
        CREATE TABLE IF NOT EXISTS daily_scores (
          id          SERIAL PRIMARY KEY,
          player_id   VARCHAR(64) NOT NULL,
          player_name VARCHAR(16) NOT NULL,
          mode        VARCHAR(16) NOT NULL,
          score_type  VARCHAR(8)  NOT NULL,
          score       INTEGER     NOT NULL DEFAULT 0,
          score_date  DATE        NOT NULL DEFAULT CURRENT_DATE,
          created_at  TIMESTAMP DEFAULT NOW(),
          UNIQUE (player_id, mode, score_type, score_date)
        );

        CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_scores(score_date, mode, score_type);

        CREATE TABLE IF NOT EXISTS accounts (
          id            SERIAL PRIMARY KEY,
          username      VARCHAR(16) UNIQUE NOT NULL,
          username_lower VARCHAR(16) UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          player_id     VARCHAR(64) UNIQUE NOT NULL,
          created_at    TIMESTAMP DEFAULT NOW(),
          updated_at    TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS auth_tokens (
          token       VARCHAR(128) PRIMARY KEY,
          player_id   VARCHAR(64) NOT NULL,
          created_at  TIMESTAMP DEFAULT NOW(),
          expires_at  TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
        );

        CREATE TABLE IF NOT EXISTS player_saves (
          player_id   VARCHAR(64) PRIMARY KEY,
          save_data   JSONB NOT NULL DEFAULT '{}',
          updated_at  TIMESTAMP DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_scores_mode_type ON scores(mode, score_type);
        CREATE INDEX IF NOT EXISTS idx_scores_player    ON scores(player_id);
        CREATE INDEX IF NOT EXISTS idx_tokens_player    ON auth_tokens(player_id);
        CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_scores(score_date, mode, score_type);

        -- Update constraint to allow 'coin' type (safe: drops old if exists, adds new)
        DO $$ BEGIN
          BEGIN
            ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_score_type_check;
          EXCEPTION WHEN undefined_object THEN NULL;
          END;
          BEGIN
            ALTER TABLE scores ADD CONSTRAINT scores_score_type_check CHECK (score_type IN ('jump','run','coin'));
          EXCEPTION WHEN duplicate_object THEN NULL;
          END;
        END $$;
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
const VALID_TYPES = ['jump','run','coin'];

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
  if (!pool) { req.player_id = 'offline'; return next(); }
  const token = req.headers['x-auth-token'] || req.body?.token;
  if (!token) return res.status(401).json({ error: 'Token tidak ada', code: 'NO_TOKEN' });
  try {
    const r = await pool.query(
      'SELECT player_id FROM auth_tokens WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (r.rows.length === 0) return res.status(401).json({ error: 'Token expired/invalid', code: 'INVALID_TOKEN' });
    req.player_id = r.rows[0].player_id;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ============================================================
// ACCOUNT API ROUTES
// ============================================================

// Register account baru
app.post('/api/auth/register', async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username dan password wajib' });
  const u = username.trim();
  if (u.length < 3 || u.length > 16)
    return res.status(400).json({ error: 'Username harus 3-16 karakter' });
  if (!/^[a-zA-Z0-9_]+$/.test(u))
    return res.status(400).json({ error: 'Hanya huruf, angka, underscore' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password minimal 6 karakter' });

  const client = await pool.connect();
  try {
    // Cek username sudah ada
    const check = await client.query('SELECT id FROM accounts WHERE username_lower=$1', [u.toLowerCase()]);
    if (check.rows.length > 0)
      return res.status(409).json({ error: 'Username sudah dipakai', code: 'USERNAME_TAKEN' });

    const player_id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8);
    const password_hash = hashPassword(password);

    // Buat account
    await client.query(
      'INSERT INTO accounts (username, username_lower, password_hash, player_id) VALUES ($1,$2,$3,$4)',
      [u, u.toLowerCase(), password_hash, player_id]
    );
    // Buat player record
    await client.query(
      'INSERT INTO players (name, name_lower, player_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [u, u.toLowerCase(), player_id]
    );
    // Buat save kosong
    await client.query(
      'INSERT INTO player_saves (player_id, save_data) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [player_id, JSON.stringify({})]
    );

    // Generate token
    const token = generateToken();
    await client.query(
      'INSERT INTO auth_tokens (token, player_id) VALUES ($1,$2)',
      [token, player_id]
    );

    res.json({ success: true, token, player_id, username: u });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username sudah dipakai', code: 'USERNAME_TAKEN' });
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username dan password wajib' });

  try {
    const r = await pool.query('SELECT * FROM accounts WHERE username_lower=$1', [username.toLowerCase().trim()]);
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Username atau password salah', code: 'WRONG_CREDENTIALS' });

    const acc = r.rows[0];
    if (!verifyPassword(password, acc.password_hash))
      return res.status(401).json({ error: 'Username atau password salah', code: 'WRONG_CREDENTIALS' });

    // Hapus token lama, buat yang baru
    await pool.query('DELETE FROM auth_tokens WHERE player_id=$1', [acc.player_id]);
    const token = generateToken();
    await pool.query('INSERT INTO auth_tokens (token, player_id) VALUES ($1,$2)', [token, acc.player_id]);

    // Ambil save data
    const saveR = await pool.query('SELECT save_data FROM player_saves WHERE player_id=$1', [acc.player_id]);
    const saveData = saveR.rows.length > 0 ? saveR.rows[0].save_data : {};

    res.json({ success: true, token, player_id: acc.player_id, username: acc.username, saveData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  if (!pool) return res.json({ success: true });
  try {
    await pool.query('DELETE FROM auth_tokens WHERE player_id=$1', [req.player_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify token (cek apakah masih valid + ambil save data)
app.get('/api/auth/me', requireAuth, async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  try {
    const accR = await pool.query('SELECT username FROM accounts WHERE player_id=$1', [req.player_id]);
    const saveR = await pool.query('SELECT save_data FROM player_saves WHERE player_id=$1', [req.player_id]);
    const saveData = saveR.rows.length > 0 ? saveR.rows[0].save_data : {};
    const username = accR.rows.length > 0 ? accR.rows[0].username : null;
    res.json({ success: true, player_id: req.player_id, username, saveData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ganti password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword)
    return res.status(400).json({ error: 'Password lama dan baru wajib diisi' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Password baru minimal 6 karakter' });
  try {
    const r = await pool.query('SELECT password_hash FROM accounts WHERE player_id=$1', [req.player_id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Account tidak ditemukan' });
    if (!verifyPassword(oldPassword, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Password lama salah', code: 'WRONG_PASSWORD' });
    const newHash = hashPassword(newPassword);
    await pool.query('UPDATE accounts SET password_hash=$1, updated_at=NOW() WHERE player_id=$2', [newHash, req.player_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save game data ke server
app.post('/api/save', requireAuth, async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  const { saveData } = req.body;
  if (!saveData) return res.status(400).json({ error: 'saveData wajib' });
  try {
    await pool.query(`
      INSERT INTO player_saves (player_id, save_data, updated_at)
      VALUES ($1,$2,NOW())
      ON CONFLICT (player_id) DO UPDATE
        SET save_data=$2, updated_at=NOW()
    `, [req.player_id, JSON.stringify(saveData)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Load game data dari server
app.get('/api/save', requireAuth, async (req, res) => {
  if (!pool) return res.json({ success: true, saveData: {}, offline: true });
  try {
    const r = await pool.query('SELECT save_data FROM player_saves WHERE player_id=$1', [req.player_id]);
    res.json({ success: true, saveData: r.rows.length > 0 ? r.rows[0].save_data : {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// Submit score (only update if higher) — support both old player_id and new auth token
app.post('/api/scores', async (req, res) => {
  if (!pool) return res.json({ success: true, offline: true });
  let { player_id, mode, score_type, score } = req.body;

  // Support new auth token
  const token = req.headers['x-auth-token'] || req.body?.token;
  if (token && !player_id) {
    try {
      const tr = await pool.query('SELECT player_id FROM auth_tokens WHERE token=$1 AND expires_at > NOW()', [token]);
      if (tr.rows.length > 0) player_id = tr.rows[0].player_id;
    } catch(e) {}
  }

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

    // Also save to daily_scores (best of today)
    await pool.query(`
      INSERT INTO daily_scores (player_id, player_name, mode, score_type, score, score_date)
      VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)
      ON CONFLICT (player_id, mode, score_type, score_date) DO UPDATE
        SET score = GREATEST(daily_scores.score, EXCLUDED.score),
            player_name = EXCLUDED.player_name
    `, [player_id, pr.rows[0].name, mode, score_type, score]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get leaderboard top 10 with optional period filter
app.get('/api/leaderboard/:mode/:type', async (req, res) => {
  if (!pool) return res.json({ mode: req.params.mode, type: req.params.type, entries: [] });
  const { mode, type } = req.params;
  const period = req.query.period || 'all'; // all, daily, weekly

  if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode tidak valid' });
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Type tidak valid' });

  try {
    let r;
    if (period === 'daily') {
      // Best score today per player
      r = await pool.query(`
        SELECT ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC) AS rank,
               player_name AS name, score
        FROM daily_scores
        WHERE mode=$1 AND score_type=$2 AND score_date = CURRENT_DATE
        ORDER BY score DESC, created_at ASC LIMIT 10
      `, [mode, type]);
    } else if (period === 'weekly') {
      // Best score this week per player
      r = await pool.query(`
        SELECT ROW_NUMBER() OVER (ORDER BY MAX(score) DESC) AS rank,
               player_name AS name, MAX(score) AS score
        FROM daily_scores
        WHERE mode=$1 AND score_type=$2
          AND score_date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY player_id, player_name
        ORDER BY score DESC LIMIT 10
      `, [mode, type]);
    } else {
      // All time
      r = await pool.query(`
        SELECT ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC) AS rank,
               player_name AS name, score
        FROM scores WHERE mode=$1 AND score_type=$2
        ORDER BY score DESC, created_at ASC LIMIT 10
      `, [mode, type]);
    }
    res.json({ mode, type, period, entries: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// LEADERBOARD API ROUTES
// ============================================================
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
