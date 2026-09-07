-- A tiny expiring key/value shelf. First use: the site weather lookup, which is
-- billed per call and so must not run once per inverter per poll.
CREATE TABLE IF NOT EXISTS kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
