-- Electrical detail from the inverter's own page: per-phase AC, grid frequency,
-- power factor, DC bus and heatsink temperature. Per-string voltage and current
-- are folded into the existing `strings` JSON alongside the power figure.
ALTER TABLE devices ADD COLUMN ac_phases TEXT;      -- JSON [{index, voltageV, currentA}]
ALTER TABLE devices ADD COLUMN frequency_hz REAL;
ALTER TABLE devices ADD COLUMN power_factor REAL;
ALTER TABLE devices ADD COLUMN temp_c REAL;
ALTER TABLE devices ADD COLUMN dc_bus_v REAL;
