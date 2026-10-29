-- What the agents found (3.0): the weekly report, and each system's health
-- check - whether it is slowly making less for its sunlight. One row per report
-- per week; see src/agents.ts. Kept a year.
--
-- `flagged` marks a health check that found a decline: the alerts
-- (src/push.ts pushEvents) tell it once, like any other condition.
--
-- Only adds, and a 2.10 Worker never reads it.
CREATE TABLE IF NOT EXISTS agent_reports (
  id           TEXT PRIMARY KEY,           -- kind:week, or health:week:system
  kind         TEXT NOT NULL,              -- 'weekly' | 'health'
  week         INTEGER NOT NULL,           -- the day number of the Monday it was made for
  inverter_id  TEXT,                       -- the system a health check is about; NULL for the weekly report
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  data         TEXT,                       -- the figures it was made from, as JSON
  worded       TEXT NOT NULL,              -- 'model' | 'solarlens'
  flagged      INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_reports_kind_week ON agent_reports(kind, week DESC);
