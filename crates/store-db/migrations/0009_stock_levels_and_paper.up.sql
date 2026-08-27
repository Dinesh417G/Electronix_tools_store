-- Two things the first real user asked for within an hour of using the console.
--
-- ── items.max_level ─────────────────────────────────────────────────────
--
-- §6 gave an item a `reorder_level` (when to worry) and a `reorder_qty` (how
-- many to buy). What a storekeeper actually thinks in is a band: "this bin
-- holds two to five". The bottom of that band is `reorder_level` and already
-- existed; the top had nowhere to live, so the console could not offer it and
-- the alert screen could not explain how much to order.
--
-- `max_level` is the order-up-to level: the quantity the bin should hold when
-- it is full. It is nullable because most of a 90-line catalog will never have
-- one set, and a NULL means "no ceiling stated", not zero.
--
-- Deliberately NOT enforced against on_hand. Stock above the maximum is a fact
-- about the bin, not an error — a bulk purchase or a return puts it there, and
-- §7 says the ledger records what happened rather than what should have. The
-- only rule worth a constraint is that a band cannot be inverted.
--
-- `reorder_qty` keeps its meaning and stays: with a band set, the suggested
-- order is `max_level - on_hand`, and reorder_qty is the override for items
-- that come in fixed pack sizes — a box of ten inserts is a box of ten.
--
-- ── printer_settings.sheet_paper ────────────────────────────────────────
--
-- The label HTML sized every page to the label with `@page`, which is right
-- for a roll-fed label printer and wrong for every office printer. Chrome on
-- Android ignores `@page size` outright, so a two-label batch printed as three
-- Letter pages with a stamp-sized label marooned in the middle of each. The
-- first user hit it on their first print.
--
-- The fix is a paper choice, and it belongs in settings rather than in the
-- request because it is a property of the printer in that store, not of the
-- batch: EXACT keeps the old one-label-per-page behaviour for label printers,
-- A4 and LETTER lay the labels out as a grid on office paper with cut guides.
-- A4 is the default because the plant this was built for is in India.

alter table items
  add column max_level numeric(12,3);

alter table items
  add constraint items_level_band_not_inverted
  check (max_level is null or max_level >= reorder_level);

comment on column items.max_level is
  'Order-up-to level: what the bin holds when full. NULL means no ceiling stated. '
  'Not enforced against on_hand — stock above it is a fact, not an error (§7).';

alter table printer_settings
  add column sheet_paper text not null default 'A4'
  check (sheet_paper in ('EXACT', 'A4', 'LETTER'));

comment on column printer_settings.sheet_paper is
  'EXACT = one label per page at label size, for roll-fed printers. A4/LETTER = '
  'a cut-guide grid on office paper, because browsers ignore @page size.';
