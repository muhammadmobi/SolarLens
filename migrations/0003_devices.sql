-- Hardware inventory: the inverters, dataloggers and batteries behind the readings.
-- Populated by the relay agent (SolisCloud) and the providers (SolarMan); a device
-- row is what lets the dashboard say "the logger is offline" instead of showing a
-- frozen power figure and leaving the cause to guesswork.
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,   -- "{provider}:{kind}:{sn|vendor id}"
  provider        TEXT NOT NULL,      -- 'soliscloud' | 'solarman'
  plant_id        TEXT,
  kind            TEXT NOT NULL,      -- 'inverter' | 'datalogger' | 'battery' | 'meter'
  sn              TEXT,
  name            TEXT,
  model           TEXT,
  firmware        TEXT,
  rated_power_w   REAL,
  status          TEXT,               -- 'online' | 'offline' | 'alarm'
  signal_dbm      REAL,               -- datalogger RSSI
  upload_cycle_s  INTEGER,            -- how often the logger uploads
  commissioned_at INTEGER,
  warranty_until  INTEGER,
  last_seen       INTEGER,            -- vendor's own "last contact" timestamp
  strings         TEXT,               -- JSON [{index, powerW}] per-MPPT string
  updated_at      INTEGER NOT NULL,
  raw             TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_plant ON devices(provider, plant_id);
