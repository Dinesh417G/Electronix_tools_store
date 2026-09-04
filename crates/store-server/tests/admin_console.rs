//! The console's write paths, and the two rules §11 puts around them.
//!
//! These endpoints existed only in `cloud/` until now — §11's table listed
//! `PATCH`/`DELETE /admin/operators/{id}` and machine and reason-code CRUD as
//! cloud-only, which meant the reference implementation could not do what the
//! deployed one does. §2 calls `crates/` the path back if the offline question
//! is ever answered "the store must work without internet"; a reference
//! implementation missing the console is not that path.
//!
//! The two rules being gated here:
//!
//!   * **Deactivate, never delete.** Operators, machines and reason codes all
//!     retire by `active = false`, because `stock_ledger` points at every one
//!     of them and §7's claim that the history still answers "who took the
//!     forty inserts, on which machine, and why" survives exactly as long as
//!     those rows do.
//!
//!   * **The last active ADMIN cannot leave through this API**, by either verb.
//!     §11 already notes the first admin cannot come from here; without the
//!     guard the last one can go through it, and a crib whose console nobody
//!     can open needs a Rust toolchain and the database password to recover.

mod harness;

use harness::{Harness, TABLET_A};
use rust_decimal_macros::dec;
use serde_json::json;
use uuid::Uuid;

/// An ADMIN with a PIN, and a token for them.
async fn admin(h: &Harness, emp_code: &str, pin: &str) -> (Uuid, String) {
    let id = h
        .operator(emp_code, &format!("zk-{emp_code}"), "The Admin", "ADMIN")
        .await;
    store_db::auth::set_pin(&h.pool, id, Some(pin))
        .await
        .expect("set pin");
    let token = h.login(emp_code, pin).await;
    (id, token)
}

async fn role_and_active(h: &Harness, id: Uuid) -> (String, bool) {
    let row = sqlx::query!("select role, active from operators where id = $1", id)
        .fetch_one(&h.pool)
        .await
        .expect("operator row still exists");
    (row.role, row.active)
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_last_admin_cannot_leave_through_the_api(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (admin_id, token) = admin(&h, "E9", "1111").await;

    // Three ways out of the room, all locked while this is the only admin.
    let (status, body) = h
        .delete_raw(&token, &format!("/api/v1/admin/operators/{admin_id}"))
        .await;
    assert_eq!(status, 409, "DELETE answered {status}: {body}");
    assert_eq!(body["code"], "LAST_ADMIN");

    let (status, body) = h
        .patch_raw(
            &token,
            &format!("/api/v1/admin/operators/{admin_id}"),
            json!({ "role": "OPERATOR" }),
        )
        .await;
    assert_eq!(status, 409, "demotion answered {status}: {body}");
    assert_eq!(body["code"], "LAST_ADMIN");

    let (status, body) = h
        .patch_raw(
            &token,
            &format!("/api/v1/admin/operators/{admin_id}"),
            json!({ "active": false }),
        )
        .await;
    assert_eq!(status, 409, "switching off answered {status}: {body}");
    assert_eq!(body["code"], "LAST_ADMIN");

    // Each refusal took its own edit back with it. This is the assertion that
    // the guard runs inside the transaction rather than after it: a guard that
    // fired on a committed row would answer 409 and still have demoted them.
    assert_eq!(
        role_and_active(&h, admin_id).await,
        ("ADMIN".to_owned(), true),
        "three refusals later, the console must still be reachable"
    );

    // With somebody else able to administer, the first one may retire.
    let (status, created) = h
        .call_with_token(
            "POST",
            &token,
            "/api/v1/admin/operators",
            Some(json!({
                "emp_code": "E10",
                "full_name": "The Other Admin",
                "role": "ADMIN",
                "zk_user_id": "zk-E10",
                "pin": "2222",
            })),
        )
        .await;
    assert_eq!(
        status, 201,
        "creating a second admin answered {status}: {created}"
    );

    let (status, body) = h
        .delete_raw(&token, &format!("/api/v1/admin/operators/{admin_id}"))
        .await;
    assert_eq!(status, 200, "DELETE answered {status}: {body}");

    // Deactivated, not deleted — §7 needs the row that the ledger points at.
    assert_eq!(
        role_and_active(&h, admin_id).await,
        ("ADMIN".to_owned(), false),
        "the operator row must survive, active = false"
    );

    // And the retired admin's token stops working on the next request, without
    // anything having revoked it: `authenticate` joins `operators`, so `active`
    // is read live rather than frozen into the token at login.
    let (status, _) = h.get_raw("unused", &token, "/api/v1/admin/operators").await;
    assert_eq!(status, 401, "a retired admin's token must stop working");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_patch_leaves_alone_what_it_does_not_mention(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (admin_id, token) = admin(&h, "E9", "1111").await;
    // A second admin, so the guard is not what any of this is measuring.
    admin(&h, "E10", "2222").await;

    let operator = h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;
    store_db::auth::set_pin(&h.pool, operator, Some("4271"))
        .await
        .expect("set pin");

    // Renaming somebody must not lock them out. The PIN and the door enrolment
    // are the two things a rename can silently take away, and both are
    // nullable, so "absent" has to mean "leave it alone".
    let (status, body) = h
        .patch_raw(
            &token,
            &format!("/api/v1/admin/operators/{operator}"),
            json!({ "full_name": "R. Kumar (nights)" }),
        )
        .await;
    assert_eq!(status, 200, "rename answered {status}: {body}");
    assert_eq!(body["full_name"], "R. Kumar (nights)");
    assert_eq!(body["zk_user_id"], "1042", "the door enrolment was cleared");

    let session = h
        .post_json(
            TABLET_A,
            "/api/v1/sessions/manual",
            json!({ "emp_code": "E1042", "pin": "4271", "tablet_id": TABLET_A }),
        )
        .await;
    assert_eq!(
        session["state"], "ACTIVE",
        "the PIN stopped working after a rename"
    );

    // An explicit null is the other instruction, and it does clear the field.
    let (status, body) = h
        .patch_raw(
            &token,
            &format!("/api/v1/admin/operators/{operator}"),
            json!({ "zk_user_id": null, "pin": null }),
        )
        .await;
    assert_eq!(status, 200, "clearing answered {status}: {body}");
    assert!(body["zk_user_id"].is_null(), "zk_user_id should be cleared");

    let (status, _) = h
        .post_raw(
            TABLET_A,
            "/api/v1/sessions/manual",
            json!({ "emp_code": "E1042", "pin": "4271", "tablet_id": TABLET_A }),
        )
        .await;
    assert_eq!(status, 401, "a cleared PIN must stop working");

    // A PATCH with nothing in it is a mistake worth naming rather than a
    // successful no-op.
    let (status, _) = h
        .patch_raw(
            &token,
            &format!("/api/v1/admin/operators/{admin_id}"),
            json!({}),
        )
        .await;
    assert_eq!(status, 400, "an empty PATCH should be refused");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn machines_retire_out_of_the_picker_and_stay_in_the_console(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (_, token) = admin(&h, "E9", "1111").await;
    let operator = h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("CNMG120408-TN2000", dec!(10)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let (status, created) = h
        .call_with_token(
            "POST",
            &token,
            "/api/v1/admin/machines",
            Some(json!({ "code": "VMC-07", "name": "Haas VF-2" })),
        )
        .await;
    assert_eq!(
        status, 201,
        "creating a machine answered {status}: {created}"
    );
    let machine_id = created["id"].as_str().expect("machine id").to_owned();

    // A duplicate code is a conflict, not a second machine: the history is
    // attached to the first one, so the remedy is to reactivate it.
    let (status, _) = h
        .call_with_token(
            "POST",
            &token,
            "/api/v1/admin/machines",
            Some(json!({ "code": "VMC-07" })),
        )
        .await;
    assert_eq!(status, 409, "a duplicate machine code should conflict");

    // Book something to it, so the console's usage count has something to say.
    let session = h.punch_and_claim("1042", TABLET_A).await;
    h.post_json(
        TABLET_A,
        "/api/v1/txn/issue",
        json!({
            "session_id": session,
            "item_id": item,
            "qty": 2,
            "machine_id": machine_id,
        }),
    )
    .await;

    let console = h
        .get_json_with_token(&token, "/api/v1/admin/machines")
        .await;
    let row = console
        .as_array()
        .expect("a machine list")
        .iter()
        .find(|m| m["id"] == created["id"])
        .expect("the machine we just made");
    assert_eq!(
        row["txn_count"], 1,
        "the console shows what is attached: {row}"
    );

    // Retire it. The picker loses it, the console keeps it, the row survives.
    let (status, retired) = h
        .delete_raw(&token, &format!("/api/v1/admin/machines/{machine_id}"))
        .await;
    assert_eq!(status, 200, "retiring answered {status}: {retired}");
    assert_eq!(retired["active"], false);

    let picker = h.get_json(TABLET_A, "/api/v1/machines").await;
    assert!(
        !picker
            .as_array()
            .expect("a picker list")
            .iter()
            .any(|m| m["id"] == created["id"]),
        "a retired machine must leave the terminal's picker (§12.6)"
    );

    let console = h
        .get_json_with_token(&token, "/api/v1/admin/machines")
        .await;
    assert!(
        console
            .as_array()
            .expect("a machine list")
            .iter()
            .any(|m| m["id"] == created["id"]),
        "and stay in the console, so it can be brought back"
    );

    // The ledger row still names it. This is the whole reason for retiring
    // rather than deleting.
    let ledger = h.get_json(TABLET_A, "/api/v1/ledger?limit=1").await;
    assert_eq!(ledger[0]["machine_code"], "VMC-07");

    // PUT brings it back, which is what the conflict message tells the
    // storekeeper to do.
    let (status, revived) = h
        .put_raw(
            &token,
            &format!("/api/v1/admin/machines/{machine_id}"),
            json!({ "code": "VMC-07", "name": "Haas VF-2", "active": true }),
        )
        .await;
    assert_eq!(status, 200, "reactivating answered {status}: {revived}");
    assert_eq!(revived["active"], true);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn reason_codes_are_validated_and_retired_not_deleted(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (_, token) = admin(&h, "E9", "1111").await;

    // The code is read in a CSV export and typed into a filter; the label is
    // what an operator sees. Mixing the two up is the mistake being refused.
    for bad in [
        json!({ "code": "new job", "label": "New job", "applies_to": "ISSUE" }),
        json!({ "code": "NEW_JOB", "label": "", "applies_to": "ISSUE" }),
        json!({ "code": "NEW_JOB", "label": "New job", "applies_to": "SIDEWAYS" }),
    ] {
        let (status, body) = h
            .call_with_token(
                "POST",
                &token,
                "/api/v1/admin/reason-codes",
                Some(bad.clone()),
            )
            .await;
        assert_eq!(
            status, 400,
            "{bad} should be refused, answered {status}: {body}"
        );
    }

    let (status, created) = h
        .call_with_token(
            "POST",
            &token,
            "/api/v1/admin/reason-codes",
            Some(json!({
                "code": "SETUP_TRIAL",
                "label": "Setting up a trial",
                "applies_to": "ISSUE",
                "sort_order": 60,
            })),
        )
        .await;
    assert_eq!(
        status, 201,
        "creating a reason answered {status}: {created}"
    );
    let reason_id = created["id"].as_str().expect("reason id").to_owned();

    let (status, _) = h
        .call_with_token(
            "POST",
            &token,
            "/api/v1/admin/reason-codes",
            Some(json!({ "code": "SETUP_TRIAL", "label": "Again", "applies_to": "ISSUE" })),
        )
        .await;
    assert_eq!(status, 409, "a duplicate reason code should conflict");

    // Retiring drops it from the terminal's chips and leaves the past legible.
    let (status, retired) = h
        .delete_raw(&token, &format!("/api/v1/admin/reason-codes/{reason_id}"))
        .await;
    assert_eq!(status, 200, "retiring answered {status}: {retired}");
    assert_eq!(retired["active"], false);

    let chips = h.get_json(TABLET_A, "/api/v1/reason-codes").await;
    assert!(
        !chips
            .as_array()
            .expect("a chip list")
            .iter()
            .any(|r| r["id"] == created["id"]),
        "a retired reason must leave the terminal's chips (§12.6)"
    );

    let console = h
        .get_json_with_token(&token, "/api/v1/admin/reason-codes")
        .await;
    let row = console
        .as_array()
        .expect("a reason list")
        .iter()
        .find(|r| r["id"] == created["id"])
        .expect("the retired reason is still in the console");
    assert_eq!(row["txn_count"], 0);

    // 0004 seeds both vocabularies; the console sees them whichever direction
    // they belong to, because that is where they are edited.
    let issue_reasons = console
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["applies_to"] == "ISSUE")
        .count();
    let receipt_reasons = console
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["applies_to"] == "RECEIPT")
        .count();
    assert!(
        issue_reasons > 1 && receipt_reasons > 0,
        "expected the seeded ISSUE and RECEIPT reasons: {console}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_console_is_gated_by_role(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (admin_id, _) = admin(&h, "E9", "1111").await;

    let operator = h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;
    store_db::auth::set_pin(&h.pool, operator, Some("4271"))
        .await
        .expect("set pin");
    let operator_token = h.login("E1042", "4271").await;

    let keeper = h.operator("E5", "5", "S. Keeper", "STOREKEEPER").await;
    store_db::auth::set_pin(&h.pool, keeper, Some("5555"))
        .await
        .expect("set pin");
    let keeper_token = h.login("E5", "5555").await;

    // An operator reaches none of it.
    for (method, path) in [
        ("GET", "/api/v1/admin/operators".to_owned()),
        ("GET", "/api/v1/admin/machines".to_owned()),
        ("GET", "/api/v1/admin/reason-codes".to_owned()),
        ("DELETE", format!("/api/v1/admin/operators/{admin_id}")),
    ] {
        let (status, body) = h
            .call_with_token(method, &operator_token, &path, None)
            .await;
        assert_eq!(status, 403, "{method} {path} answered {status}: {body}");
    }

    // A storekeeper owns the shop-floor reference data — machines and reasons
    // are things they add on a Tuesday — but not who may sign in.
    let (status, _) = h
        .get_raw("unused", &keeper_token, "/api/v1/admin/machines")
        .await;
    assert_eq!(status, 200, "a storekeeper edits machines");

    let (status, _) = h
        .get_raw("unused", &keeper_token, "/api/v1/admin/reason-codes")
        .await;
    assert_eq!(status, 200, "and reason codes");

    let (status, _) = h
        .get_raw("unused", &keeper_token, "/api/v1/admin/operators")
        .await;
    assert_eq!(status, 403, "but not people");

    // A tablet token is not a console login at all, whatever it is asked.
    let (status, _) = h
        .get_raw("unused", &h.tablet_token, "/api/v1/admin/machines")
        .await;
    assert_eq!(status, 403, "a tablet token must not reach the console");
}

/// Two admins demoting each other at the same moment.
///
/// The guard is a count inside the transaction that made the change, and that
/// alone does not cover this: the two writers touch two *different* rows, so
/// nothing conflicts, and at READ COMMITTED each counts the other as still
/// active until it commits. Both would see one admin left and both would
/// commit. `ADMIN_SET_LOCK` is what makes the count exact.
///
/// Nondeterministic on its own — a broken build can win this race — which is
/// why the test below it holds the lock and proves the writers wait for it.
#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn two_admins_cannot_demote_each_other_at_once(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (a, _) = admin(&h, "E9", "1111").await;
    let (b, _) = admin(&h, "E8", "2222").await;

    let (first, second) = tokio::join!(
        store_db::operators::deactivate(&h.pool, a),
        store_db::operators::deactivate(&h.pool, b),
    );

    let committed = [first.is_ok(), second.is_ok()]
        .into_iter()
        .filter(|ok| *ok)
        .count();
    assert_eq!(
        committed, 1,
        "exactly one demotion may commit, got {committed}          (first={first:?}, second={second:?})"
    );

    let left = sqlx::query_scalar!(
        r#"select count(*) as "n!" from operators where active and role = 'ADMIN'"#
    )
    .fetch_one(&h.pool)
    .await
    .expect("count admins");
    assert_eq!(left, 1, "the crib must still have somebody who can open it");
}

/// The deterministic half: hold `ADMIN_SET_LOCK` and watch the writers wait.
///
/// This is the assertion that fails on a build without the lock — the race
/// above can be won by luck, this cannot. Both verbs are checked, because the
/// guard is only as good as the writer that remembers to take it.
#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn every_admin_write_waits_for_the_lock(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (a, _) = admin(&h, "E9", "1111").await;
    let (b, _) = admin(&h, "E8", "2222").await;

    let mut holder = h.pool.begin().await.expect("begin the holding transaction");
    sqlx::query!(
        "select pg_advisory_xact_lock($1)",
        store_db::operators::ADMIN_SET_LOCK
    )
    .execute(&mut *holder)
    .await
    .expect("hold ADMIN_SET_LOCK");

    let wait = std::time::Duration::from_millis(750);

    let blocked = tokio::time::timeout(wait, store_db::operators::deactivate(&h.pool, a)).await;
    assert!(
        blocked.is_err(),
        "deactivate finished while ADMIN_SET_LOCK was held: {blocked:?}"
    );

    let patch = store_db::operators::OperatorPatch {
        role: Some("OPERATOR".to_owned()),
        ..Default::default()
    };
    let blocked =
        tokio::time::timeout(wait, store_db::operators::update(&h.pool, a, &patch, None)).await;
    assert!(
        blocked.is_err(),
        "update finished while ADMIN_SET_LOCK was held: {blocked:?}"
    );

    holder.rollback().await.expect("release the lock");

    // And once it is free, the same call goes straight through — so what the
    // two assertions above measured was the lock and not a broken writer.
    store_db::operators::deactivate(&h.pool, b)
        .await
        .expect("a demotion leaving one admin behind is allowed");
}
