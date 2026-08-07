drop table if exists reason_codes;
drop table if exists machines;
drop table if exists item_barcodes;
drop table if exists items;
drop table if exists item_categories;
drop table if exists operators;
drop function if exists set_updated_at();
-- pg_trgm is left in place: it is a database-level facility that other
-- migrations may also rely on, and dropping an extension somebody else
-- installed is not ours to do.
