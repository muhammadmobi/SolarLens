-- 3.0: two indexes put right, from a review of what each query reads.
--
-- The new-fault alert (src/push.ts pushEvents) asks every five minutes for the
-- alarms first seen in the last six hours. With no index on first_seen, that
-- was a pass over every alarm ever kept - and alarms are kept for good, so the
-- cost grew with every fault. With one, it reads the few it wants.
CREATE INDEX IF NOT EXISTS idx_alarms_first_seen ON alarms(first_seen);

-- The readings table's primary key is (inverter_id, ts, source), and the index
-- SQLite keeps for it already answers every lookup by system and time, newest
-- first included. idx_readings_inv_ts, on (inverter_id, ts DESC), repeated it:
-- one more index row written with every reading, and nothing it answered that
-- the key does not. A Worker rolled back to 2.x runs on without it, as it only
-- ever used what the key provides.
DROP INDEX IF EXISTS idx_readings_inv_ts;
