-- Running serial numbers, one per physical sticker, and the label printer
-- settings that produce them.
--
-- A serial identifies a *tool*, not a catalog line: forty identical inserts in
-- bin A-01-1 are one item and forty stickers, and the whole point of the
-- number is telling those forty apart.

create sequence tool_serial_seq start 1;

create table serial_settings (
  id         boolean primary key default true check (id),
  prefix     text not null default 'TC-',
  pad_width  integer not null default 6 check (pad_width between 1 and 12),
  updated_at timestamptz not null default now(),
  constraint serial_settings_singleton check (id)
);

insert into serial_settings (id) values (true) on conflict do nothing;

-- The next running number, formatted. Editable afterwards, so this is a
-- starting point rather than a permanent identity.
create or replace function next_tool_serial() returns text
language plpgsql as $$
declare
  v_prefix text;
  v_pad    integer;
begin
  select prefix, pad_width into v_prefix, v_pad from serial_settings where id;
  return v_prefix || lpad(nextval('tool_serial_seq')::text, v_pad, '0');
end;
$$;

create table tool_serials (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items (id) on delete restrict,
  -- The QR payload. Unique across the whole crib: the same number can never be
  -- assigned to two tools, which is the point of a serial.
  serial_no   text not null unique,
  -- Whether this number came from the running sequence or was typed by hand.
  -- A hand-edited serial is still unique, just not sequential.
  minted      boolean not null default true,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  note        text,
  -- Reprint accounting: a replacement sticker is the same number printed
  -- again, never a new number.
  print_count integer not null default 0 check (print_count >= 0),
  first_printed_at timestamptz,
  last_printed_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tool_serials_no_blank check (length(btrim(serial_no)) > 0)
);

create trigger tool_serials_set_updated_at
  before update on tool_serials
  for each row execute function set_updated_at();

create index tool_serials_item on tool_serials (item_id, serial_no);
create index tool_serials_active on tool_serials (status) where status = 'ACTIVE';
create index tool_serials_serial_trgm on tool_serials using gin (serial_no gin_trgm_ops);

-- Label printer. A singleton for now: one crib, one label printer.
--
-- mode matters because a browser cannot open a raw socket to a printer, and a
-- serverless function in the cloud has no route to a private LAN address:
--   BROWSER_PDF  the site renders a PDF and the operator prints it
--   LAN_AGENT    a small agent inside the plant polls for jobs and sends ZPL
--                to host:port itself
create table printer_settings (
  id            boolean primary key default true check (id),
  mode          text not null default 'BROWSER_PDF' check (mode in ('BROWSER_PDF', 'LAN_AGENT')),
  name          text,
  host          text,
  port          integer not null default 9100 check (port between 1 and 65535),
  dpi           integer not null default 203 check (dpi in (203, 300, 600)),
  label_width_mm  numeric(6,2) not null default 50 check (label_width_mm > 0),
  label_height_mm numeric(6,2) not null default 25 check (label_height_mm > 0),
  agent_token_hash text,
  last_seen_at  timestamptz,
  updated_at    timestamptz not null default now(),
  constraint printer_settings_singleton check (id),
  constraint printer_settings_lan_needs_host check (
    mode <> 'LAN_AGENT' or (host is not null and length(btrim(host)) > 0)
  )
);

insert into printer_settings (id) values (true) on conflict do nothing;

-- Print jobs. A LAN agent polls this; BROWSER_PDF rows are marked done as soon
-- as the PDF is handed to the browser.
create table print_jobs (
  id           uuid primary key default gen_random_uuid(),
  serial_id    uuid references tool_serials (id) on delete cascade,
  item_id      uuid references items (id) on delete cascade,
  copies       integer not null default 1 check (copies between 1 and 500),
  kind         text not null check (kind in ('SERIAL_QR', 'BIN_LABEL')),
  status       text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'DONE', 'FAILED')),
  error        text,
  requested_by uuid references operators (id) on delete set null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz,
  constraint print_jobs_target check (serial_id is not null or item_id is not null)
);

create index print_jobs_queue on print_jobs (created_at) where status = 'QUEUED';
