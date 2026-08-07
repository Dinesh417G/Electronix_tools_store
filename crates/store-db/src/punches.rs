//! Devices and the punches they push (CLAUDE.md §9).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use store_core::identity::IdentityEvent;
use uuid::Uuid;

use crate::error::{FoundExt, Result};

/// A recorded punch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PunchRow {
    pub id: Uuid,
    pub device_id: Uuid,
    pub zk_user_id: String,
    pub device_ts: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub verify_mode: Option<String>,
    pub claimed: bool,
}

/// Register a device, or refresh what we know about one.
///
/// Called on every ADMS handshake, so a terminal that is swapped or reflashed
/// shows up without an admin having to add it first.
pub async fn upsert_device(
    pool: &PgPool,
    serial_no: &str,
    firmware: Option<&str>,
    timezone_offset_min: Option<i32>,
) -> Result<Uuid> {
    let id = sqlx::query_scalar!(
        r#"
        insert into devices (serial_no, name, last_seen_at, firmware, timezone_offset_min)
        values ($1, $1, now(), $2, $3)
        on conflict (serial_no) do update
           set last_seen_at = now(),
               firmware = coalesce(excluded.firmware, devices.firmware),
               timezone_offset_min = coalesce(
                 excluded.timezone_offset_min, devices.timezone_offset_min)
        returning id
        "#,
        serial_no,
        firmware,
        timezone_offset_min,
    )
    .fetch_one(pool)
    .await?;

    Ok(id)
}

pub async fn touch_device(pool: &PgPool, serial_no: &str) -> Result<Uuid> {
    upsert_device(pool, serial_no, None, None).await
}

/// Persist one punch, deduplicating retries (§9.1).
///
/// The device retries on any non-`OK` response, so the same batch arrives more
/// than once as a matter of course. `ON CONFLICT DO NOTHING` against the
/// `punches_dedup` index makes a retried batch a no-op rather than a second
/// punch.
///
/// Returns `(punch_id, is_new)`. `is_new` is false for a duplicate, which lets
/// the caller skip opening a second session without having to guess.
pub async fn record(
    pool: &PgPool,
    device_id: Uuid,
    event: &IdentityEvent,
) -> Result<(Uuid, bool)> {
    let inserted = sqlx::query_scalar!(
        r#"
        insert into punches (device_id, zk_user_id, device_ts, verify_mode, raw)
        values ($1, $2, $3, $4, $5)
        on conflict (device_id, zk_user_id, device_ts) do nothing
        returning id
        "#,
        device_id,
        event.external_user_id,
        event.device_ts,
        event.verify_mode.as_str(),
        event.raw,
    )
    .fetch_optional(pool)
    .await?;

    if let Some(id) = inserted {
        return Ok((id, true));
    }

    // Lost the race, or a genuine retry: fetch the row that is already there.
    let existing = sqlx::query_scalar!(
        r#"
        select id from punches
         where device_id = $1 and zk_user_id = $2 and device_ts is not distinct from $3
        "#,
        device_id,
        event.external_user_id,
        event.device_ts,
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("punch")?;

    Ok((existing, false))
}

/// Punches whose `zk_user_id` matches no operator (§9.4).
///
/// Never dropped, always surfaced: an incomplete operator master is an admin
/// problem to fix, not a reason to lose the record that somebody opened the
/// door.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownUserPunch {
    pub punch_id: Uuid,
    pub zk_user_id: String,
    pub device_serial: String,
    pub received_at: DateTime<Utc>,
    pub occurrences: i64,
}

pub async fn unknown_user_punches(pool: &PgPool, limit: i64) -> Result<Vec<UnknownUserPunch>> {
    let rows = sqlx::query_as!(
        UnknownUserPunch,
        r#"
        select distinct on (p.zk_user_id)
               p.id          as "punch_id!",
               p.zk_user_id  as "zk_user_id!",
               d.serial_no   as "device_serial!",
               p.received_at as "received_at!",
               count(*) over (partition by p.zk_user_id) as "occurrences!"
          from punches p
          join devices d on d.id = p.device_id
         where not exists (
                 select 1 from operators o
                  where o.zk_user_id = p.zk_user_id and o.active)
         order by p.zk_user_id, p.received_at desc
         limit $1
        "#,
        limit.clamp(1, 500),
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Recent punches, newest first — the device diagnostics view.
pub async fn recent(pool: &PgPool, limit: i64) -> Result<Vec<PunchRow>> {
    let rows = sqlx::query_as!(
        PunchRow,
        r#"
        select id           as "id!",
               device_id    as "device_id!",
               zk_user_id   as "zk_user_id!",
               device_ts,
               received_at  as "received_at!",
               verify_mode,
               claimed      as "claimed!"
          from punches
         order by received_at desc
         limit $1
        "#,
        limit.clamp(1, 1000),
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// When each device was last heard from — feeds `/admin/health` (§11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceHealth {
    pub id: Uuid,
    pub serial_no: String,
    pub name: Option<String>,
    pub location: Option<String>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub firmware: Option<String>,
}

pub async fn device_health(pool: &PgPool) -> Result<Vec<DeviceHealth>> {
    let rows = sqlx::query_as!(
        DeviceHealth,
        r#"
        select id as "id!", serial_no as "serial_no!", name, location,
               last_seen_at, firmware
          from devices
         order by serial_no
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}
