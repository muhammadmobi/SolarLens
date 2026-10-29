-- 3.0: SolarMan readings of a battery charging, put the right way round.
--
-- SolarMan's station snapshot sends chargePower as a negative number while the
-- battery charges (and dischargePower as a positive one while it discharges).
-- Until 3.0 the normaliser took chargePower as it came, so every reading of a
-- battery charging was stored as discharging: -99 W while the charge climbed.
-- src/providers/solarman.ts now takes the sizes; this puts right what was
-- stored before.
--
-- Only a reading the snapshot itself says was charging is touched - its raw
-- chargePower below zero - and only while it is still stored below zero, so
-- running this twice changes nothing the second time. Nothing is added or
-- dropped: a Worker rolled back to 2.10 reads the corrected rows as before.
UPDATE readings
SET battery_power_w = -battery_power_w
WHERE battery_power_w < 0
  AND inverter_id IN (SELECT id FROM inverters WHERE provider = 'solarman')
  AND json_extract(raw, '$.chargePower') < 0;
