-- Where each system is, and the weather it has had (3.0).
--
-- Only adds. Neither table is one a 2.10 Worker reads, so a rollback cannot
-- serve what is in them.

-- Each system's position, as its vendor reports it. The owner's alone: served
-- only to a signed-in owner (the site map), and sent nowhere else except,
-- rounded to about a kilometre, to the weather service. A table of its own, not
-- a column on inverters, for the reason migrations/0014 gives: an older Worker
-- serves every column of the tables it knows.
CREATE TABLE IF NOT EXISTS plant_location (
  inverter_id  TEXT PRIMARY KEY,
  lat          REAL NOT NULL,
  lng          REAL NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The weather at each system, hour by hour, from Open-Meteo: sunlight on the
-- ground (the average over the hour ending at ts, W/m2), air temperature and
-- cloud cover. What the expected-output line and the underperformance alert
-- are measured against. Kept 400 days, so a year's comparisons have it.
CREATE TABLE IF NOT EXISTS weather_hourly (
  inverter_id  TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  ghi_wm2      REAL,
  temp_c       REAL,
  cloud_pct    REAL,
  PRIMARY KEY (inverter_id, ts)
);
CREATE INDEX IF NOT EXISTS weather_hourly_ts ON weather_hourly (ts);
