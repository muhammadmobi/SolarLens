-- The array's own UTC offset in seconds, as the vendor reports it.
--
-- A solar day ends at the panels' midnight. Until now the daily history split
-- every day at the *viewer's* midnight, which is right only while you are in
-- the same country as the plant: read from another timezone, every day's yield
-- was a blend of two. NULL keeps the old behaviour for a plant whose vendor
-- says nothing, and the caller's offset is used as before.
ALTER TABLE inverters ADD COLUMN tz_offset_sec INTEGER;
