-- Fault history, and the vendors' own day, month and year totals.
--
-- Both come from the portals' web APIs. Neither is personal: an alarm is kept
-- as its code, message, severity, advice and times, and a period as energy
-- figures, with every owner field in the vendor record dropped before insert.

-- One row per alarm as the vendor raised it. The id is provider:plant:code:start,
-- so reading the same alarm again - active, then recovered - updates it in place.
CREATE TABLE IF NOT EXISTS alarms (
  id           TEXT PRIMARY KEY,
  inverter_id  TEXT NOT NULL,
  provider     TEXT NOT NULL,
  code         TEXT NOT NULL,
  message      TEXT,
  severity     TEXT,              -- 'info' | 'warning' | 'fault', or NULL when unmapped
  vendor_level INTEGER,           -- the vendor's own number, since part of the mapping is inferred
  advice       TEXT,
  begin_ts     INTEGER NOT NULL,
  end_ts       INTEGER,           -- NULL: still active, or a vendor that never records an end
  state        TEXT NOT NULL,     -- 'active' | 'recovered' | 'unknown'
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alarms_inverter_begin ON alarms(inverter_id, begin_ts DESC);

-- A vendor's own total for one day, month or year. The record SolarLens keeps
-- starts on the day it first polled; these reach back to the plant's first day,
-- so a month or a year can be shown whole instead of from part-way through.
CREATE TABLE IF NOT EXISTS vendor_periods (
  inverter_id   TEXT NOT NULL,
  period        TEXT NOT NULL,    -- 'day' | 'month' | 'year'
  key           TEXT NOT NULL,    -- 2026-09-01 | 2026-09 | 2026, in the plant's calendar
  yield_kwh     REAL,
  load_kwh      REAL,
  import_kwh    REAL,
  export_kwh    REAL,
  charge_kwh    REAL,
  discharge_kwh REAL,
  full_hours    REAL,
  source        TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (inverter_id, period, key)
);
