-- Battery and BMS detail from the inverter's own page. One JSON column rather
-- than ten sparse ones: only hybrids report any of it, and the field set
-- differs between vendors.
ALTER TABLE devices ADD COLUMN battery TEXT;
