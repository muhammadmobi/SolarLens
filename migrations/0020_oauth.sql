-- The apps the owner connects to SolarLens's MCP server (3.0), through OAuth:
-- see src/oauth.ts. As everywhere in SolarLens, only hashes of tokens and
-- codes are stored, so a copy of the database connects nobody.
--
-- Only adds, and a 2.10 Worker never reads it.

-- An app that registered itself (RFC 7591). Public clients only: they prove
-- who they are with PKCE, not a secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id             TEXT PRIMARY KEY,         -- the client_id
  name           TEXT NOT NULL,            -- as the app gave it: shown to the owner, never trusted
  redirect_uris  TEXT NOT NULL,            -- JSON array
  created_at     INTEGER NOT NULL
);

-- An approval, waiting to be swapped for tokens: single use, ten minutes.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  challenge      TEXT NOT NULL,            -- the PKCE S256 challenge
  scope          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0,
  grant_id       TEXT                      -- the connection it made, revoked if the code comes back
);

-- A connected app: approved once, and connected until the owner disconnects
-- it. Its refresh token renews on use and rotates, the one before remembered
-- so a copy is caught - as with a signed-in browser.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  scope          TEXT NOT NULL,
  refresh_hash   TEXT NOT NULL,
  prev_hash      TEXT,
  rotated_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER
);

-- Access tokens, an hour each.
CREATE TABLE IF NOT EXISTS oauth_access (
  token_hash     TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_access_grant ON oauth_access(grant_id);
