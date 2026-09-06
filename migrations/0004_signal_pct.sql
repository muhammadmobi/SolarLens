-- Vendors report link quality on different scales: SolisCloud gives the
-- datalogger's RSSI in dBm (negative), SolarMan gives a 0-100 percentage.
-- Keeping them apart avoids rendering "86 dBm", which would be nonsense.
ALTER TABLE devices ADD COLUMN signal_pct REAL;
