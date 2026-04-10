const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});
async function query(text, params) { return (await pool.query(text, params)).rows; }
async function queryOne(text, params) { const r = await query(text, params); return r.length > 0 ? r[0] : null; }

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#000000', token TEXT, bio TEXT DEFAULT '', pfp TEXT,
    tags TEXT[] DEFAULT '{}', badges TEXT[] DEFAULT '{}', theme TEXT DEFAULT 'xp-blue',
    last_display_change BIGINT DEFAULT 0, last_seen BIGINT DEFAULT 0,
    created_at BIGINT DEFAULT 0, is_admin BOOLEAN DEFAULT false
  )`);
  const cols = [
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS badges TEXT[] DEFAULT '{}'",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'xp-blue'",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false",
  ];
  for (const c of cols) { try { await pool.query(c); } catch(e) {} }

  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username),
    text TEXT NOT NULL DEFAULT '', image_url TEXT, gif_url TEXT,
    reply_to TEXT, repost_of TEXT, quote_of TEXT, quote_text TEXT,
    like_count INT DEFAULT 0, repost_count INT DEFAULT 0, reply_count INT DEFAULT 0,
    view_count INT DEFAULT 0, deleted BOOLEAN DEFAULT false, edited BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL
  )`);
  const pcols = [
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_of TEXT",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_text TEXT",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0",
    "ALTER TABLE posts ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false",
  ];
  for (const c of pcols) { try { await pool.query(c); } catch(e) {} }

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_user ON posts (username, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_time ON posts (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts (reply_to)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS post_likes (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES accounts(username),
    created_at BIGINT DEFAULT 0, PRIMARY KEY (post_id, username)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS post_reposts (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES accounts(username),
    created_at BIGINT DEFAULT 0, PRIMARY KEY (post_id, username)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS follows (
    follower TEXT NOT NULL REFERENCES accounts(username),
    following TEXT NOT NULL REFERENCES accounts(username),
    created_at BIGINT DEFAULT 0, PRIMARY KEY (follower, following)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS bookmarks (
    username TEXT NOT NULL REFERENCES accounts(username),
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at BIGINT DEFAULT 0, PRIMARY KEY (username, post_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username),
    type TEXT NOT NULL, from_user TEXT, post_id TEXT,
    read BOOLEAN DEFAULT false, created_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (username, created_at DESC)`);

  await pool.query(`CREATE TABLE IF NOT EXISTS post_views (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    username TEXT NOT NULL, created_at BIGINT DEFAULT 0,
    PRIMARY KEY (post_id, username)
  )`);

  // Polls
  await pool.query(`CREATE TABLE IF NOT EXISTS polls (
    post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    options TEXT[] NOT NULL, votes JSONB DEFAULT '{}',
    ends_at BIGINT DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS poll_votes (
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES accounts(username),
    option_idx INT NOT NULL, created_at BIGINT DEFAULT 0,
    PRIMARY KEY (post_id, username)
  )`);

  // Blocks and mutes
  await pool.query(`CREATE TABLE IF NOT EXISTS blocks (
    blocker TEXT NOT NULL REFERENCES accounts(username),
    blocked TEXT NOT NULL REFERENCES accounts(username),
    created_at BIGINT DEFAULT 0, PRIMARY KEY (blocker, blocked)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mutes (
    muter TEXT NOT NULL REFERENCES accounts(username),
    muted TEXT NOT NULL REFERENCES accounts(username),
    created_at BIGINT DEFAULT 0, PRIMARY KEY (muter, muted)
  )`);

  // Drafts
  await pool.query(`CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES accounts(username),
    text TEXT DEFAULT '', image_url TEXT, gif_url TEXT,
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
  )`);

  // Banner color for profiles
  try { await pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS banner_color TEXT DEFAULT '#0a246a'"); } catch(e) {}

  // Edit history
  await pool.query(`CREATE TABLE IF NOT EXISTS post_edits (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    old_text TEXT, new_text TEXT, edited_at BIGINT NOT NULL
  )`);

  // Pinned posts on profiles
  try { await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false"); } catch(e) {}

  // Reports
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    reporter TEXT NOT NULL REFERENCES accounts(username),
    post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
    reason TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at BIGINT NOT NULL
  )`);

  // Scheduled posts
  await pool.query(`CREATE TABLE IF NOT EXISTS scheduled_posts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES accounts(username),
    text TEXT DEFAULT '',
    image_url TEXT, gif_url TEXT,
    send_at BIGINT NOT NULL,
    sent BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL
  )`);

  // Multiple images per post (carousel)
  await pool.query(`CREATE TABLE IF NOT EXISTS post_images (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    position INT DEFAULT 0
  )`);

  // User lists (like Twitter lists)
  await pool.query(`CREATE TABLE IF NOT EXISTS user_lists (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL REFERENCES accounts(username),
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    private BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS list_members (
    list_id TEXT NOT NULL REFERENCES user_lists(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES accounts(username),
    added_at BIGINT DEFAULT 0,
    PRIMARY KEY (list_id, username)
  )`);

  // Post templates
  await pool.query(`CREATE TABLE IF NOT EXISTS post_templates (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES accounts(username),
    name TEXT NOT NULL,
    text TEXT DEFAULT '',
    created_at BIGINT NOT NULL
  )`);

  // Comments (threaded, separate from replies)
  await pool.query(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    parent_id TEXT,
    username TEXT NOT NULL REFERENCES accounts(username),
    text TEXT NOT NULL,
    like_count INT DEFAULT 0,
    deleted BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS comment_likes (
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    username TEXT NOT NULL REFERENCES accounts(username),
    PRIMARY KEY (comment_id, username)
  )`);

  // Quote of the day
  await pool.query(`CREATE TABLE IF NOT EXISTS daily_quotes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    author TEXT DEFAULT '',
    added_by TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`);

  console.log('[JorgeGram DB] All tables ready');
}

module.exports = { pool, query, queryOne, initDB };
