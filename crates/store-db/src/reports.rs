//! Consumption reporting (CLAUDE.md §11, M8).
//!
//! Every report here reads `created_at` — what the server observed — and never
//! `device_ts` (§9.3). A terminal whose clock has drifted off +05:30 must not
//! be able to move a transaction into the wrong month.
//!
//! "Consumption" means stock that left: `ISSUE` and `SCRAP`. Reversals net
//! themselves out automatically, because a reversal is a real row with the
//! opposite sign — which is the whole point of §7.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::error::Result;

/// How to bucket a consumption report (§11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    Item,
    Machine,
    Operator,
    Category,
    Month,
}

impl GroupBy {
    pub const fn as_str(self) -> &'static str {
        match self {
            GroupBy::Item => "item",
            GroupBy::Machine => "machine",
            GroupBy::Operator => "operator",
            GroupBy::Category => "category",
            GroupBy::Month => "month",
        }
    }
}

impl std::str::FromStr for GroupBy {
    type Err = crate::DbError;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "item" => Ok(GroupBy::Item),
            "machine" => Ok(GroupBy::Machine),
            "operator" => Ok(GroupBy::Operator),
            "category" => Ok(GroupBy::Category),
            "month" => Ok(GroupBy::Month),
            other => Err(crate::DbError::Invalid(format!(
                "unknown group_by {other:?}"
            ))),
        }
    }
}

/// One row of a consumption report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsumptionRow {
    /// Stable key for the bucket — an id, or a month in `YYYY-MM`.
    pub bucket_key: String,
    /// What a human reads.
    pub bucket_label: String,
    /// Positive magnitude of stock consumed.
    pub qty: Decimal,
    /// Value at the cost snapshot taken when each movement was booked.
    pub value: Decimal,
    pub txn_count: i64,
}

#[derive(Debug, Clone, Default)]
pub struct ConsumptionFilter {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

/// Consumption grouped as asked.
///
/// One query per grouping rather than dynamic SQL: compile-time checked queries
/// (§2) are worth more here than the duplication costs, and each variant gets to
/// label its "unassigned" bucket in words that make sense for it.
pub async fn consumption(
    pool: &PgPool,
    group_by: GroupBy,
    filter: &ConsumptionFilter,
) -> Result<Vec<ConsumptionRow>> {
    let (from, to) = (filter.from, filter.to);

    let rows = match group_by {
        GroupBy::Item => {
            sqlx::query_as!(
                ConsumptionRow,
                r#"
                select i.id::text                                  as "bucket_key!",
                       (i.item_code || ' — ' || i.description)      as "bucket_label!",
                       sum(-l.delta_qty)                            as "qty!",
                       coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)
                                                                    as "value!",
                       count(*)                                     as "txn_count!"
                  from stock_ledger l
                  join items i on i.id = l.item_id
                 where l.txn_type in ('ISSUE', 'SCRAP')
                   and ($1::timestamptz is null or l.created_at >= $1)
                   and ($2::timestamptz is null or l.created_at < $2)
                 group by i.id, i.item_code, i.description
                having sum(-l.delta_qty) <> 0
                 order by sum(-l.delta_qty) desc
                "#,
                from,
                to
            )
            .fetch_all(pool)
            .await?
        }
        GroupBy::Machine => {
            sqlx::query_as!(
                ConsumptionRow,
                r#"
                select coalesce(m.id::text, 'unassigned')           as "bucket_key!",
                       coalesce(m.code, '(no machine recorded)')    as "bucket_label!",
                       sum(-l.delta_qty)                            as "qty!",
                       coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)
                                                                    as "value!",
                       count(*)                                     as "txn_count!"
                  from stock_ledger l
                  left join machines m on m.id = l.machine_id
                 where l.txn_type in ('ISSUE', 'SCRAP')
                   and ($1::timestamptz is null or l.created_at >= $1)
                   and ($2::timestamptz is null or l.created_at < $2)
                 group by m.id, m.code
                having sum(-l.delta_qty) <> 0
                 order by sum(-l.delta_qty) desc
                "#,
                from,
                to
            )
            .fetch_all(pool)
            .await?
        }
        GroupBy::Operator => {
            sqlx::query_as!(
                ConsumptionRow,
                r#"
                select o.id::text                                   as "bucket_key!",
                       (o.emp_code || ' — ' || o.full_name)         as "bucket_label!",
                       sum(-l.delta_qty)                            as "qty!",
                       coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)
                                                                    as "value!",
                       count(*)                                     as "txn_count!"
                  from stock_ledger l
                  join operators o on o.id = l.operator_id
                 where l.txn_type in ('ISSUE', 'SCRAP')
                   and ($1::timestamptz is null or l.created_at >= $1)
                   and ($2::timestamptz is null or l.created_at < $2)
                 group by o.id, o.emp_code, o.full_name
                having sum(-l.delta_qty) <> 0
                 order by sum(-l.delta_qty) desc
                "#,
                from,
                to
            )
            .fetch_all(pool)
            .await?
        }
        GroupBy::Category => {
            sqlx::query_as!(
                ConsumptionRow,
                r#"
                select coalesce(c.id::text, 'uncategorised')        as "bucket_key!",
                       coalesce(c.name, '(uncategorised)')          as "bucket_label!",
                       sum(-l.delta_qty)                            as "qty!",
                       coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)
                                                                    as "value!",
                       count(*)                                     as "txn_count!"
                  from stock_ledger l
                  join items i on i.id = l.item_id
                  left join item_categories c on c.id = i.category_id
                 where l.txn_type in ('ISSUE', 'SCRAP')
                   and ($1::timestamptz is null or l.created_at >= $1)
                   and ($2::timestamptz is null or l.created_at < $2)
                 group by c.id, c.name
                having sum(-l.delta_qty) <> 0
                 order by sum(-l.delta_qty) desc
                "#,
                from,
                to
            )
            .fetch_all(pool)
            .await?
        }
        GroupBy::Month => {
            sqlx::query_as!(
                ConsumptionRow,
                r#"
                select to_char(date_trunc('month', l.created_at), 'YYYY-MM') as "bucket_key!",
                       to_char(date_trunc('month', l.created_at), 'Mon YYYY') as "bucket_label!",
                       sum(-l.delta_qty)                            as "qty!",
                       coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)
                                                                    as "value!",
                       count(*)                                     as "txn_count!"
                  from stock_ledger l
                 where l.txn_type in ('ISSUE', 'SCRAP')
                   and ($1::timestamptz is null or l.created_at >= $1)
                   and ($2::timestamptz is null or l.created_at < $2)
                 group by date_trunc('month', l.created_at)
                having sum(-l.delta_qty) <> 0
                 order by date_trunc('month', l.created_at) desc
                "#,
                from,
                to
            )
            .fetch_all(pool)
            .await?
        }
    };

    Ok(rows)
}

/// Render a consumption report as CSV (§11: `/reports/consumption.csv`).
///
/// Hand-rolled rather than pulled in as a dependency because the shape is four
/// known columns. Fields are quoted and inner quotes doubled, which is all
/// RFC 4180 asks for — item descriptions contain commas often enough that
/// skipping this would corrupt the file within a week.
pub fn to_csv(group_by: GroupBy, rows: &[ConsumptionRow]) -> String {
    fn escape(field: &str) -> String {
        format!("\"{}\"", field.replace('"', "\"\""))
    }

    let mut out = String::with_capacity(rows.len() * 64 + 64);
    out.push_str(&format!("{},qty,value,txn_count\n", group_by.as_str()));
    for row in rows {
        out.push_str(&escape(&row.bucket_label));
        out.push(',');
        out.push_str(&row.qty.to_string());
        out.push(',');
        out.push_str(&row.value.to_string());
        out.push(',');
        out.push_str(&row.txn_count.to_string());
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn csv_quotes_fields_containing_commas_and_quotes() {
        let rows = vec![ConsumptionRow {
            bucket_key: "1".into(),
            bucket_label: r#"CNMG120408, grade "TN2000""#.into(),
            qty: dec!(40),
            value: dec!(4820.00),
            txn_count: 7,
        }];
        let csv = to_csv(GroupBy::Item, &rows);
        assert_eq!(
            csv,
            "item,qty,value,txn_count\n\"CNMG120408, grade \"\"TN2000\"\"\",40,4820.00,7\n"
        );
    }

    #[test]
    fn group_by_round_trips_through_its_token() {
        for g in [
            GroupBy::Item,
            GroupBy::Machine,
            GroupBy::Operator,
            GroupBy::Category,
            GroupBy::Month,
        ] {
            assert_eq!(g.as_str().parse::<GroupBy>().unwrap(), g);
        }
        assert!("shift".parse::<GroupBy>().is_err());
    }
}
