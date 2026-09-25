-- The owner login (3.0): who may sign in, which devices are signed in, and
-- what is shared. See src/auth/ for how each table is used.
--
-- Only adds. A Worker rolled back to 2.10 never reads these tables, and every
-- secret in them is a hash, so nothing here is served by any version.

-- The one owner. A single row: SolarLens has one owner, and the id is pinned to
-- 1 so a second can never be made. `password` is the stored form made by
-- hashPassword (PBKDF2, then keyed with a Worker secret), or null when the
-- owner signs in only with passkeys. `require_sign_in` is the switch the owner
-- turns on in Settings once a way to sign in exists: until then, reads stay
-- open as they were in 2.x.
CREATE TABLE IF NOT EXISTS auth_owner (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  password         TEXT,
  require_sign_in  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);

-- The owner's passkeys: the public half only, which signs nobody in by itself.
CREATE TABLE IF NOT EXISTS auth_passkeys (
  id            TEXT PRIMARY KEY,   -- the credential id, base64url
  public_key    TEXT NOT NULL,      -- JSON {alg, jwk}
  sign_count    INTEGER NOT NULL DEFAULT 0,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

-- Every signed-in browser: the owner's phone, laptop and TV, and anyone who
-- opened a share link. A device holds a refresh token; only its hash is here,
-- with the one before it, so a copied token used after the real one has moved
-- on is recognised - and the device signed out. `share_id` ties a viewer to the
-- link it came through, so revoking the link signs them all out.
CREATE TABLE IF NOT EXISTS auth_devices (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL,      -- 'owner' | 'viewer'
  share_id      TEXT,
  label         TEXT,               -- "Chrome on Android", from the browser's own description
  refresh_hash  TEXT NOT NULL,
  prev_hash     TEXT,
  rotated_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS auth_devices_share ON auth_devices (share_id);

-- View-only links the owner hands out. The link's secret is hashed like a
-- refresh token; `expires_at` null means until revoked.
CREATE TABLE IF NOT EXISTS auth_shares (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);

-- Passkey challenges in flight: made when a ceremony starts, used once, and
-- good for five minutes.
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- 'register' | 'login'
  created_at  INTEGER NOT NULL
);

-- Failed sign-ins, per caller and across all callers, for the lockout.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key           TEXT PRIMARY KEY,   -- 'ip:<hash>' or 'all'
  fails         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  locked_until  INTEGER
);
