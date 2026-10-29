-- Where else the owner is told (3.0): ntfy, Telegram, Discord, or any webhook -
-- Home Assistant's, for one. Each row is one place that alerts, the weekly
-- summary, or both are posted to; see src/channels.ts.
--
-- `secret` is what posting there needs - a bot token, a webhook address, an
-- ntfy topic - as JSON sealed with AES-GCM under a key derived from API_TOKEN,
-- so a copy of the database cannot post as the owner. It is never served: the
-- Settings page is shown `label`, a hint with the secret parts left out.
-- `last_error` is a status and a few words, never the address.
--
-- Only adds, and a 2.10 Worker never reads it.
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,             -- 'ntfy' | 'telegram' | 'discord' | 'webhook'
  name          TEXT,
  label         TEXT NOT NULL,
  secret        TEXT NOT NULL,
  origin        TEXT NOT NULL,             -- the dashboard's own address, for the link in each message
  alerts        INTEGER NOT NULL DEFAULT 1,
  weekly        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_ok_at    INTEGER,
  last_error    TEXT,
  last_error_at INTEGER,
  failures      INTEGER NOT NULL DEFAULT 0
);
