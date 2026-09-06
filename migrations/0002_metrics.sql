-- Extended per-reading metrics captured from the vendor apps (generation by
-- month/year, grid import/export, battery charge/discharge, self-consumption).
-- Kept as one JSON column so adding a field never needs another migration; the
-- headline live values stay as real columns for fast querying.
ALTER TABLE readings ADD COLUMN metrics TEXT;
