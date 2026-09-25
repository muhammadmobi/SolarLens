-- Everything a datalogger reports, and how its link has behaved over time.
--
-- Only adds: a Worker rolled back to 2.10 runs against this schema unchanged.

-- What a logger says about itself beyond status and signal - its link type,
-- signal bars, time since restart and in total, when it was made - as JSON
-- (LoggerDetail in src/providers/types.ts). Published with the device row.
ALTER TABLE devices ADD COLUMN logger TEXT;

-- Its network handles: mobile operator and cell, or MAC address (LoggerNetwork).
-- Either can place a logger or tie it to one household, so they are for the
-- owner only - and they live in a table of their own rather than a column on
-- devices. A Worker rolled back to 2.10 answers /api/devices from
-- SELECT * FROM devices and strips only the columns it knew about, so a column
-- added here would be served by it to anyone. A separate table it has never
-- heard of cannot be.
CREATE TABLE IF NOT EXISTS device_network (
  device_id   TEXT PRIMARY KEY,
  network     TEXT NOT NULL,     -- JSON LoggerNetwork
  updated_at  INTEGER NOT NULL
);

-- Status and signal as they were over time, for the link history on the
-- Devices tab. A row is written when either changes, and at least hourly
-- while nothing does, so a week of a steady logger is about 170 rows rather
-- than two thousand; see recordDeviceSample in src/db.ts. Kept 90 days.
CREATE TABLE IF NOT EXISTS device_samples (
  device_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  status      TEXT,
  signal_dbm  REAL,
  signal_pct  REAL,
  PRIMARY KEY (device_id, ts)
);
CREATE INDEX IF NOT EXISTS device_samples_ts ON device_samples (ts);
