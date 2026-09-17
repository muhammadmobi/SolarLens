-- Each SolisCloud relay's own report: is its login working, and when does it
-- run out.
--
-- A SolisCloud web login lasts exactly seven days and use does not extend it,
-- so a relay's login expiring is certain and its date is known in advance. A
-- relay reports both after every cycle. The id is a random one the relay made
-- for itself - never a computer name - and it stays in this table: the public
-- response names a relay by its nickname, or by its order.
CREATE TABLE IF NOT EXISTS relays (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  name             TEXT,
  state            TEXT NOT NULL,   -- 'ok' | 'login-expired' | 'error'
  login_expires_at INTEGER,         -- epoch seconds, from the portal's own login cookie
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  last_ok_at       INTEGER
);
