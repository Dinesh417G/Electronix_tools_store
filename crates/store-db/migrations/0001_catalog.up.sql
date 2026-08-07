-- People, catalog and reference data (CLAUDE.md §6).
--
-- Conventions used throughout, stated once here:
--   * all timestamps are timestamptz
--   * all money is numeric(12,2)
--   * all quantities are numeric(12,3) — inserts are whole numbers, coolant and
--     bar stock are not
--   * closed sets (role, uom, kind) are text with a check constraint rather
--     than a Postgres enum, because adding a value to an enum is a migration
--     and adding one to a check is a smaller migration

create extension if not exists pg_trgm;

-- ── Shared helper: keep updated_at honest ────────────────────────────────
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── People ──────────────────────────────────────────────────────────────
create table operators (
  id          uuid primary key default gen_random_uuid(),
  emp_code    text unique not null,
  full_name   text not null,
  -- The PIN/user id programmed into the door terminal. Nullable: a storekeeper
  -- who only ever uses the fallback path has no enrolment on the door.
  zk_user_id  text unique,
  -- argon2, for the ManualPinSource fallback path only (§8). Never the primary
  -- means of identification.
  pin_hash    text,
  role        text not null check (role in ('OPERATOR', 'STOREKEEPER', 'ADMIN')),
  department  text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint operators_emp_code_not_blank check (length(btrim(emp_code)) > 0),
  constraint operators_full_name_not_blank check (length(btrim(full_name)) > 0)
);

create trigger operators_set_updated_at
  before update on operators
  for each row execute function set_updated_at();

-- ── Catalog ─────────────────────────────────────────────────────────────
create table item_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null,
  sort_order integer not null default 0
);

create table items (
  id            uuid primary key default gen_random_uuid(),
  -- Our internal code, and the payload printed on the bin label. store-core's
  -- validate_item_code() is the authority on what may go in here.
  item_code     text unique not null,
  description   text not null,
  category_id   uuid references item_categories (id) on delete set null,
  uom           text not null check (uom in ('NOS', 'SET', 'BOX', 'LTR', 'KG')),

  -- tooling-specific, all nullable: a tin of coolant has none of these
  iso_code      text,
  grade         text,
  manufacturer  text,
  mfr_part_no   text,
  diameter_mm   numeric(8, 3),
  flutes        integer check (flutes is null or flutes > 0),

  -- stock control
  reorder_level  numeric(12, 3) not null default 0 check (reorder_level >= 0),
  reorder_qty    numeric(12, 3) check (reorder_qty is null or reorder_qty > 0),
  bin_location   text,
  unit_cost      numeric(12, 2) check (unit_cost is null or unit_cost >= 0),
  -- When true, an ISSUE may drive on_hand below zero (§7).
  allow_negative boolean not null default false,
  active         boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint items_item_code_not_blank check (length(btrim(item_code)) > 0),
  constraint items_description_not_blank check (length(btrim(description)) > 0)
);

create trigger items_set_updated_at
  before update on items
  for each row execute function set_updated_at();

-- Typeahead across item_code, description, iso_code and grade (§11).
-- Trigram indexes because operators search by fragment ("cnmg 1204", "tn20"),
-- not by prefix.
create index items_item_code_trgm   on items using gin (item_code gin_trgm_ops);
create index items_description_trgm on items using gin (description gin_trgm_ops);
create index items_iso_code_trgm    on items using gin (iso_code gin_trgm_ops)
  where iso_code is not null;
create index items_grade_trgm       on items using gin (grade gin_trgm_ops)
  where grade is not null;
create index items_category         on items (category_id) where active;
create index items_bin_location     on items (bin_location) where bin_location is not null;

-- Alternate barcodes. Lets a vendor's printed barcode resolve to our item,
-- which is the difference between scanning the box as it arrives and
-- re-labelling every box.
create table item_barcodes (
  id      uuid primary key default gen_random_uuid(),
  item_id uuid not null references items (id) on delete cascade,
  code    text unique not null,
  kind    text not null check (kind in ('OWN', 'MFR_EAN', 'VENDOR')),

  constraint item_barcodes_code_not_blank check (length(btrim(code)) > 0)
);

create index item_barcodes_item on item_barcodes (item_id);

-- ── Reference data ──────────────────────────────────────────────────────
create table machines (
  id     uuid primary key default gen_random_uuid(),
  code   text unique not null,
  name   text,
  active boolean not null default true
);

create table reason_codes (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,
  label      text not null,
  -- Which direction this reason belongs to, so the tablet never offers
  -- BREAKAGE on a PUT IN screen.
  applies_to text not null check (applies_to in ('ISSUE', 'RECEIPT')),
  sort_order integer not null default 0,
  active     boolean not null default true
);

create index reason_codes_applies_to on reason_codes (applies_to, sort_order)
  where active;
