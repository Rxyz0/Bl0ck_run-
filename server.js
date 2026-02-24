require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// DATABASE SETUP
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Init tables
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

            CREATE INDEX IF NOT EXISTS idx_scores_mode_type  ON scores(mode, score_type);
            CREATE INDEX IF NOT EXISTS idx_scores_player     ON scores(player_id);
            CREATE INDEX IF NOT EXISTS idx_players_name_lower ON players(name_lower);
        `);
        console.log('✅ Database tables ready');
    } catch (err) {
        console.error('❌ DB init error:', err.message);
    } finally {
        client.release();
    }
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// VALID MODES
// ============================================================
const VALID_MODES = ['egypt','day','night','snow','ocean','sakura','ramadan'];
const VALID_TYPES = ['jump','run'];

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ----------------------------------------------------------
// PLAYER NAME ROUTES
// ----------------------------------------------------------

// Check if name is available
app.get('/api/player/check/:name', async (req, res) => {
    const name = req.params.name.trim();
    if (!name || name.length < 2 || name.length > 16) {
        return res.json({ available: false, reason: 'Nama harus 2-16 karakter' });
    }
    try {
        const result = await pool.query(
            'SELECT id FROM players WHERE name_lower = $1',
            [name.toLowerCase()]
        );
        res.json({ available: result.rows.length === 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Register or update player name
// player_id = unique device ID generated client-side (stored in localStorage)
app.post('/api/player/register', async (req, res) => {
    const { player_id, name } = req.body;
    if (!player_id || !name) return res.status(400).json({ error: 'player_id dan name wajib diisi' });

    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 16) {
        return res.status(400).json({ error: 'Nama harus 2-16 karakter' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
        return res.status(400).json({ error: 'Nama hanya boleh huruf, angka, underscore' });
    }

    const client = await pool.connect();
    try {
        // Check if name taken by ANOTHER player
        const nameCheck = await client.query(
            'SELECT player_id FROM players WHERE name_lower = $1',
            [trimmed.toLowerCase()]
        );
        if (nameCheck.rows.length > 0 && nameCheck.rows[0].player_id !== player_id) {
            return res.status(409).json({ error: 'Nama sudah dipakai', code: 'NAME_TAKEN' });
        }

        // Upsert player
        const result = await client.query(`
            INSERT INTO players (player_id, name, name_lower)
            VALUES ($1, $2, $3)
            ON CONFLICT (player_id) DO UPDATE
                SET name = $2, name_lower = $3, updated_at = NOW()
            RETURNING *
        `, [player_id, trimmed, trimmed.toLowerCase()]);

        // Update player_name in scores too
        await client.query(
            'UPDATE scores SET player_name = $1 WHERE player_id = $2',
            [trimmed, player_id]
        );

        res.json({ success: true, player: result.rows[0] });
    } catch (err) {
        if (err.code === '23505') { // unique violation
            return res.status(409).json({ error: 'Nama sudah dipakai', code: 'NAME_TAKEN' });
        }
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Get player info by player_id
app.get('/api/player/:player_id', async (req, res) => {
    try {
        const player = await pool.query(
            'SELECT * FROM players WHERE player_id = $1',
            [req.params.player_id]
        );
        if (player.rows.length === 0) return res.json({ exists: false });
        res.json({ exists: true, player: player.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------
// SCORE ROUTES
// ----------------------------------------------------------

// Submit score (upsert — only update if new score is higher)
app.post('/api/scores', async (req, res) => {
    const { player_id, mode, score_type, score } = req.body;

    if (!player_id || !mode || !score_type || score === undefined) {
        return res.status(400).json({ error: 'player_id, mode, score_type, score wajib diisi' });
    }
    if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode tidak valid' });
    if (!VALID_TYPES.includes(score_type)) return res.status(400).json({ error: 'Score type tidak valid' });
    if (typeof score !== 'number' || score < 0) return res.status(400).json({ error: 'Score tidak valid' });

    try {
        // Get player name
        const playerRow = await pool.query(
            'SELECT name FROM players WHERE player_id = $1',
            [player_id]
        );
        if (playerRow.rows.length === 0) {
            return res.status(404).json({ error: 'Player belum terdaftar', code: 'NOT_REGISTERED' });
        }
        const playerName = playerRow.rows[0].name;

        // Upsert score — only update if new score is higher
        const result = await pool.query(`
            INSERT INTO scores (player_id, player_name, mode, score_type, score)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (player_id, mode, score_type) DO UPDATE
                SET score = GREATEST(scores.score, EXCLUDED.score),
                    player_name = EXCLUDED.player_name,
                    created_at = CASE
                        WHEN EXCLUDED.score > scores.score THEN NOW()
                        ELSE scores.created_at
                    END
            RETURNING *, (xmax = 0) AS is_new
        `, [player_id, playerName, mode, score_type, score]);

        res.json({ success: true, score: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get leaderboard for a mode + type (top 10)
app.get('/api/leaderboard/:mode/:type', async (req, res) => {
    const { mode, type } = req.params;
    if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode tidak valid' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Type tidak valid' });

    try {
        const result = await pool.query(`
            SELECT
                ROW_NUMBER() OVER (ORDER BY score DESC, created_at ASC) AS rank,
                player_name AS name,
                score,
                created_at
            FROM scores
            WHERE mode = $1 AND score_type = $2
            ORDER BY score DESC, created_at ASC
            LIMIT 10
        `, [mode, type]);

        res.json({ mode, type, entries: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get all scores for a player
app.get('/api/scores/:player_id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT mode, score_type, score FROM scores WHERE player_id = $1',
            [req.params.player_id]
        );
        // Format: { egypt: { jump: 0, run: 0 }, day: {...}, ... }
        const scores = {};
        VALID_MODES.forEach(m => { scores[m] = { jump: 0, run: 0 }; });
        result.rows.forEach(r => { scores[r.mode][r.score_type] = r.score; });
        res.json({ scores });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------
// SERVE GAME
// ----------------------------------------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'game.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'game.html')));

// ============================================================
// START
// ============================================================
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 bl0ck run server running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to init DB:', err);
    process.exit(1);
});
