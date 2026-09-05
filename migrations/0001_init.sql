-- SolarLens schema. Both vendors collapse into one normalised `readings` table
-- so the UI never needs to know which cloud a number came from.

CREATE TABLE IF NOT EXISTS inverters (
  id            TEXT PRIMARY KEY,   -- "{provider}:{vendor_id}"
  provider      TEXT NOT NULL,      -- 'soliscloud' | 'solarman' | 'local'
  vendor_id     TEXT NOT NULL,      -- id as the vendor knows it
  serial        TEXT,               -- dedupe key across providers
  name          TEXT,
  plant_id      TEXT,
  plant_name    TEXT,
  capacity_w    REAL,
  display_order INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inverters_serial ON inverters(serial);

CREATE TABLE IF NOT EXISTS readings (
  inverter_id     TEXT NOT NULL,
  ts              INTEGER NOT NULL,  -- epoch seconds, vendor timestamp when given
  source          TEXT NOT NULL,     -- 'soliscloud' | 'solarman' | 'local'
  ac_power_w      REAL,
  dc_power_w      REAL,
  today_kwh       REAL,
  total_kwh       REAL,
  battery_soc     REAL,              -- percent
  battery_power_w REAL,              -- + charging, - discharging
  grid_power_w    REAL,              -- + import, - export
  load_power_w    REAL,
  temp_c          REAL,
  status          TEXT,
  raw             TEXT,              -- untouched vendor JSON, for later backfill
  PRIMARY KEY (inverter_id, ts, source)
);

CREATE INDEX IF NOT EXISTS idx_readings_inv_ts ON readings(inverter_id, ts DESC);

CREATE TABLE IF NOT EXISTS tokens (
  provider     TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_log (
  ts       INTEGER NOT NULL,
  provider TEXT NOT NULL,
  ok       INTEGER NOT NULL,
  detail   TEXT
);

CREATE INDEX IF NOT EXISTS idx_poll_log_ts ON poll_log(ts DESC);
