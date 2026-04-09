const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows.length > 0 ? rows[0] : null;
}

async function initDB() {
  // Accounts table already exists from JorgeChat — we just use it.
  // But we create it IF NOT EXISTS in case JorgeGram deploys first.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      username      TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      color         TEXT NOT NULL DEFAULT '#000000',
      token         TEXT,
      bio           TEXT DEFAULT '',
      pfp           TEXT,
      tags          TEXT[] DEFAULT '{}',
      badges        TEXT[] DEFAULT '{}',
      theme         TEXT DEFAULT 'xp-blue',
      last_display_change BIGINT DEFAULT 0,
      last_seen     BIGINT DEFAULT 0,
      created_at    BIGINT DEFAULT 0,
      is_admin      BOOLEAN DEFAULT false
    )
  `);
  // Safe column additions for existing databases
  const cols = [
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS badges TEXT[] DEFAULT '{}'",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'xp-blue'",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false",
  ];
  for (const c of cols) { try { await pool.query(c); } catch(e) {} }

  // Posts — the core content
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL REFERENCES accounts(username),
      text        TEXT NOT NULL DEFAULT '',
      image_url   TEXT,
      gif_url     TEXT,
      reply_to    TEXT,
      repost_of   TEXT,
      like_count  INT DEFAULT 0,
      repost_count INT DEFAULT 0,
      reply_count INT DEFAULT 0,
      deleted     BOOLEAN DEFAULT false,
      created_at  BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_user ON posts (username, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_time ON posts (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts (reply_to)`);

  // Likes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      created_at BIGINT DEFAULT 0,
      PRIMARY KEY (post_id, username)
    )
  `);

  // Reposts
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reposts (
      post_id  TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      username TEXT NOT NULL REFERENCES accounts(username),
      created_at BIGINT DEFAULT 0,
      PRIMARY KEY (post_id, username)
    )
  `);

  // Follows (separate from JorgeChat friends)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      follower  TEXT NOT NULL REFERENCES accounts(username),
      following TEXT NOT NULL REFERENCES accounts(username),
      created_at BIGINT DEFAULT 0,
      PRIMARY KEY (follower, following)
    )
  `);

  console.log('[JorgeGram DB] All tables ready');
}

module.exports = { pool, query, queryOne, initDB };
