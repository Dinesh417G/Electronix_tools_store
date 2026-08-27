alter table printer_settings drop column if exists sheet_paper;
alter table items drop constraint if exists items_level_band_not_inverted;
alter table items drop column if exists max_level;
