-- Daylight saving, done properly.
--
-- A plant's UTC offset was stored as a number on the inverter and refreshed on
-- every poll, so every day of history was cut using whatever the offset happens
-- to be today. In a zone that observes daylight saving, that moves every summer
-- day of a winter-read history by an hour - and for the five minutes around the
-- switch itself, the current day was cut wrong too.
--
-- Two columns fix it. The zone's own name, where the vendor states one, is the
-- only thing that stays true through a switch; and each reading now carries the
-- offset that was in force at its own timestamp, so a day's rows keep the
-- boundary they were recorded under, whatever the clocks do afterwards.

ALTER TABLE inverters ADD COLUMN tz_name TEXT;
ALTER TABLE readings ADD COLUMN tz_offset_sec INTEGER;
