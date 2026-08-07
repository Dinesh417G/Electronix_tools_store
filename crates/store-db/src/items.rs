//! Catalog reads and writes.
//!
//! The lookup path here is the one an operator feels: §11 budgets `<100 ms` for
//! resolving a scan. It is a single indexed query against `item_barcodes` and
//! `items`, joined to the cached `item_stock` — never a sum over the ledger.
//! That cache is exactly what §7 buys us.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use store_core::alert::AlertLevel;
use store_core::item::{validate_barcode, validate_item_code, BarcodeKind};
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

/// What the tablet needs after a scan: the item, where it lives, and how many
/// the system thinks are there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemView {
    pub id: Uuid,
    pub item_code: String,
    pub description: String,
    pub uom: String,
    pub category_id: Option<Uuid>,
    pub category_name: Option<String>,
    pub iso_code: Option<String>,
    pub grade: Option<String>,
    pub manufacturer: Option<String>,
    pub mfr_part_no: Option<String>,
    pub bin_location: Option<String>,
    pub unit_cost: Option<Decimal>,
    pub reorder_level: Decimal,
    pub reorder_qty: Option<Decimal>,
    pub allow_negative: bool,
    pub active: bool,
    pub on_hand: Decimal,
    pub alert_state: String,
}

impl ItemView {
    pub fn alert_level(&self) -> AlertLevel {
        self.alert_state.parse().unwrap_or(AlertLevel::Ok)
    }
}

/// Fields accepted when creating or updating a catalog item.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemInput {
    pub item_code: String,
    pub description: String,
    pub category_id: Option<Uuid>,
    pub uom: String,
    pub iso_code: Option<String>,
    pub grade: Option<String>,
    pub manufacturer: Option<String>,
    pub mfr_part_no: Option<String>,
    pub diameter_mm: Option<Decimal>,
    pub flutes: Option<i32>,
    pub reorder_level: Decimal,
    pub reorder_qty: Option<Decimal>,
    pub bin_location: Option<String>,
    pub unit_cost: Option<Decimal>,
    pub allow_negative: bool,
}

/// Resolve a scanned barcode to an item.
///
/// Checks `items.item_code` first (our own labels, the common case) and then
/// `item_barcodes` (manufacturer and vendor labels). Returns `None` rather than
/// an error: an unknown barcode is an ordinary event on the shop floor, not a
/// failure.
pub async fn lookup_by_barcode(pool: &PgPool, raw_code: &str) -> Result<Option<ItemView>> {
    let code = validate_barcode(raw_code)?;

    let row = sqlx::query_as!(
        ItemView,
        r#"
        select i.id                as "id!",
               i.item_code         as "item_code!",
               i.description       as "description!",
               i.uom               as "uom!",
               i.category_id,
               c.name              as "category_name?",
               i.iso_code,
               i.grade,
               i.manufacturer,
               i.mfr_part_no,
               i.bin_location,
               i.unit_cost,
               i.reorder_level     as "reorder_level!",
               i.reorder_qty,
               i.allow_negative    as "allow_negative!",
               i.active            as "active!",
               coalesce(s.on_hand, 0)        as "on_hand!",
               coalesce(s.alert_state, 'OK') as "alert_state!"
          from items i
          left join item_categories c on c.id = i.category_id
          left join item_stock s      on s.item_id = i.id
         where i.item_code = $1
            or exists (select 1 from item_barcodes b
                        where b.item_id = i.id and b.code = $1)
         limit 1
        "#,
        code
    )
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Typeahead across item_code, description, iso_code and grade (§11).
///
/// Ranked so an exact or prefix match on the item code beats a description
/// fragment — an operator who types a code wants that code, not everything
/// mentioning it.
pub async fn search(pool: &PgPool, q: &str, limit: i64) -> Result<Vec<ItemView>> {
    let needle = q.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{}%", needle.to_uppercase());
    let prefix = format!("{}%", needle.to_uppercase());

    let rows = sqlx::query_as!(
        ItemView,
        r#"
        select i.id                as "id!",
               i.item_code         as "item_code!",
               i.description       as "description!",
               i.uom               as "uom!",
               i.category_id,
               c.name              as "category_name?",
               i.iso_code,
               i.grade,
               i.manufacturer,
               i.mfr_part_no,
               i.bin_location,
               i.unit_cost,
               i.reorder_level     as "reorder_level!",
               i.reorder_qty,
               i.allow_negative    as "allow_negative!",
               i.active            as "active!",
               coalesce(s.on_hand, 0)        as "on_hand!",
               coalesce(s.alert_state, 'OK') as "alert_state!"
          from items i
          left join item_categories c on c.id = i.category_id
          left join item_stock s      on s.item_id = i.id
         where i.active
           and (upper(i.item_code) like $1
             or upper(i.description) like $1
             or upper(i.iso_code) like $1
             or upper(i.grade) like $1)
         order by case
                    when upper(i.item_code) = upper($3) then 0
                    when upper(i.item_code) like $2 then 1
                    when upper(i.iso_code) like $2 then 2
                    else 3
                  end,
                  i.item_code
         limit $4
        "#,
        pattern,
        prefix,
        needle,
        limit.clamp(1, 100)
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Fetch one item by id.
pub async fn get(pool: &PgPool, id: Uuid) -> Result<ItemView> {
    sqlx::query_as!(
        ItemView,
        r#"
        select i.id                as "id!",
               i.item_code         as "item_code!",
               i.description       as "description!",
               i.uom               as "uom!",
               i.category_id,
               c.name              as "category_name?",
               i.iso_code,
               i.grade,
               i.manufacturer,
               i.mfr_part_no,
               i.bin_location,
               i.unit_cost,
               i.reorder_level     as "reorder_level!",
               i.reorder_qty,
               i.allow_negative    as "allow_negative!",
               i.active            as "active!",
               coalesce(s.on_hand, 0)        as "on_hand!",
               coalesce(s.alert_state, 'OK') as "alert_state!"
          from items i
          left join item_categories c on c.id = i.category_id
          left join item_stock s      on s.item_id = i.id
         where i.id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("item")
}

/// Stock view filters (§11: `GET /api/v1/stock`).
#[derive(Debug, Clone, Default)]
pub struct StockFilter {
    /// Only items at or below their reorder level.
    pub low: bool,
    /// Only items at zero (or below).
    pub empty: bool,
    pub category_id: Option<Uuid>,
    pub bin_location: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

/// The stock dashboard query.
pub async fn stock(pool: &PgPool, filter: &StockFilter) -> Result<Vec<ItemView>> {
    let rows = sqlx::query_as!(
        ItemView,
        r#"
        select i.id                as "id!",
               i.item_code         as "item_code!",
               i.description       as "description!",
               i.uom               as "uom!",
               i.category_id,
               c.name              as "category_name?",
               i.iso_code,
               i.grade,
               i.manufacturer,
               i.mfr_part_no,
               i.bin_location,
               i.unit_cost,
               i.reorder_level     as "reorder_level!",
               i.reorder_qty,
               i.allow_negative    as "allow_negative!",
               i.active            as "active!",
               s.on_hand           as "on_hand!",
               s.alert_state       as "alert_state!"
          from items i
          join item_stock s           on s.item_id = i.id
          left join item_categories c on c.id = i.category_id
         where i.active
           and (not $1::bool or s.alert_state in ('LOW', 'EMPTY'))
           and (not $2::bool or s.alert_state = 'EMPTY')
           and ($3::uuid is null or i.category_id = $3)
           and ($4::text is null or i.bin_location = $4)
         order by case s.alert_state when 'EMPTY' then 0 when 'LOW' then 1 else 2 end,
                  i.item_code
         limit $5 offset $6
        "#,
        filter.low,
        filter.empty,
        filter.category_id,
        filter.bin_location,
        filter.limit.clamp(1, 1000),
        filter.offset.max(0),
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Create a catalog item.
///
/// The `item_code` is validated through `store-core` first, because the code is
/// also the Code128 payload printed on the bin label (§6) — a code we cannot
/// print is a code we must not accept.
pub async fn create(pool: &PgPool, input: &ItemInput) -> Result<Uuid> {
    let item_code = validate_item_code(&input.item_code)?;
    let uom: store_core::Uom = input.uom.parse()?;

    let id = sqlx::query_scalar!(
        r#"
        insert into items (
            item_code, description, category_id, uom,
            iso_code, grade, manufacturer, mfr_part_no, diameter_mm, flutes,
            reorder_level, reorder_qty, bin_location, unit_cost, allow_negative
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        returning id
        "#,
        item_code,
        input.description.trim(),
        input.category_id,
        uom.as_str(),
        input.iso_code.as_deref(),
        input.grade.as_deref(),
        input.manufacturer.as_deref(),
        input.mfr_part_no.as_deref(),
        input.diameter_mm,
        input.flutes,
        input.reorder_level,
        input.reorder_qty,
        input.bin_location.as_deref(),
        input.unit_cost,
        input.allow_negative,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "item code"))?;

    Ok(id)
}

/// Update a catalog item in place.
///
/// Note that nothing here touches stock. Changing `reorder_level` re-evaluates
/// the alert state, but that happens in a trigger (`0003_ledger.up.sql`), not
/// here — one rule, one place.
pub async fn update(pool: &PgPool, id: Uuid, input: &ItemInput) -> Result<()> {
    let item_code = validate_item_code(&input.item_code)?;
    let uom: store_core::Uom = input.uom.parse()?;

    let result = sqlx::query!(
        r#"
        update items
           set item_code = $2, description = $3, category_id = $4, uom = $5,
               iso_code = $6, grade = $7, manufacturer = $8, mfr_part_no = $9,
               diameter_mm = $10, flutes = $11,
               reorder_level = $12, reorder_qty = $13, bin_location = $14,
               unit_cost = $15, allow_negative = $16
         where id = $1
        "#,
        id,
        item_code,
        input.description.trim(),
        input.category_id,
        uom.as_str(),
        input.iso_code.as_deref(),
        input.grade.as_deref(),
        input.manufacturer.as_deref(),
        input.mfr_part_no.as_deref(),
        input.diameter_mm,
        input.flutes,
        input.reorder_level,
        input.reorder_qty,
        input.bin_location.as_deref(),
        input.unit_cost,
        input.allow_negative,
    )
    .execute(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "item code"))?;

    crate::expect_one(result, "item")
}

/// Retire an item without deleting it. Deleting would orphan ledger history.
pub async fn deactivate(pool: &PgPool, id: Uuid) -> Result<()> {
    let result = sqlx::query!("update items set active = false where id = $1", id)
        .execute(pool)
        .await?;
    crate::expect_one(result, "item")
}

/// Attach an alternate barcode (a manufacturer's EAN, a distributor's label).
pub async fn add_barcode(
    pool: &PgPool,
    item_id: Uuid,
    raw_code: &str,
    kind: BarcodeKind,
) -> Result<Uuid> {
    let code = validate_barcode(raw_code)?;

    let id = sqlx::query_scalar!(
        "insert into item_barcodes (item_id, code, kind) values ($1, $2, $3) returning id",
        item_id,
        code,
        kind.as_str(),
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "barcode"))?;

    Ok(id)
}

/// Items due for a label print run (§11: `POST /api/v1/admin/labels/print`).
pub async fn for_label_batch(pool: &PgPool, ids: &[Uuid]) -> Result<Vec<ItemView>> {
    let rows = sqlx::query_as!(
        ItemView,
        r#"
        select i.id                as "id!",
               i.item_code         as "item_code!",
               i.description       as "description!",
               i.uom               as "uom!",
               i.category_id,
               c.name              as "category_name?",
               i.iso_code,
               i.grade,
               i.manufacturer,
               i.mfr_part_no,
               i.bin_location,
               i.unit_cost,
               i.reorder_level     as "reorder_level!",
               i.reorder_qty,
               i.allow_negative    as "allow_negative!",
               i.active            as "active!",
               coalesce(s.on_hand, 0)        as "on_hand!",
               coalesce(s.alert_state, 'OK') as "alert_state!"
          from items i
          left join item_categories c on c.id = i.category_id
          left join item_stock s      on s.item_id = i.id
         where i.id = any($1)
         order by i.bin_location nulls last, i.item_code
        "#,
        ids
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}
