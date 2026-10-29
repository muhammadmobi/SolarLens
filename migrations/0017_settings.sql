-- Settings the owner fills in (3.0): first, the tariff - what a kWh costs to
-- buy and earns when sold, whether exports are net-metered, and how much CO2 a
-- kWh from the grid stands for - from which the page works out money saved and
-- carbon avoided - and then the groups the owner sorts the systems into. One
-- JSON value per key; see src/settings.ts.
--
-- Only adds, and a 2.10 Worker never reads it.
CREATE TABLE IF NOT EXISTS app_settings (
  k           TEXT PRIMARY KEY,
  v           TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
