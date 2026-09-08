-- Indexes for the two range scans the dashboard runs on every refresh.
--
-- `series` filters readings by timestamp alone, and the only index on the
-- table was (inverter_id, ts) - useless for that, so every call read the whole
-- table. `daily` groups the same range. Both become range scans with this.
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);

-- poll_log is read newest-first and, until this migration's companion change,
-- was also grouped by provider. Keeping the composite means either shape is
-- answered from an index rather than a scan.
CREATE INDEX IF NOT EXISTS idx_poll_log_provider_ts ON poll_log(provider, ts DESC);
