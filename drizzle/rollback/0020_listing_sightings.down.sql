-- Reverses 0020_listing_sightings.sql. The table is additive and only an index of listing numbers to events; dropping
-- it means a checkout link that carries only a listing number is asked about again. Run by hand; the migrator never
-- applies files in this folder.
DROP TABLE IF EXISTS "market_listing_sightings";
