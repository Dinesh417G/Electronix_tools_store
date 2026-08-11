//! `store-cli operator` — create and manage people, from the server PC.
//!
//! This exists to solve a bootstrap that has no other answer. §11 puts operator
//! CRUD behind `/api/v1/admin/operators`, which requires an `ADMIN` token,
//! which requires an `ADMIN` operator with a PIN. On a fresh production
//! database there are none, so the admin console cannot be reached at all and
//! nothing can create the person who would fix that.
//!
//! `store-cli seed` does produce an admin, but it also inserts a demo catalog
//! and four fictional people. Nobody wants to commission a real store by
//! deleting a fake one.
//!
//! Whoever can run this already holds `DATABASE_URL`, and therefore already
//! owns every row in the database. So there is no privilege here that the
//! caller did not already have — this is a seam, not a back door.

use anyhow::{bail, Context, Result};
use sqlx::PgPool;
use store_db::operators::OperatorInput;

/// Roles §6 allows. Kept here rather than imported so a typo in a migration
/// cannot silently widen what the CLI will write.
const ROLES: [&str; 3] = ["OPERATOR", "STOREKEEPER", "ADMIN"];

pub struct NewOperator {
    pub emp_code: String,
    pub name: String,
    pub role: String,
    pub zk_user_id: Option<String>,
    pub department: Option<String>,
    pub pin: Option<String>,
}

pub async fn add(pool: &PgPool, input: NewOperator) -> Result<()> {
    let role = normalise_role(&input.role)?;

    // An ADMIN or STOREKEEPER with no PIN cannot log in, which makes creating
    // one a silent no-op. Better to say so than to leave somebody clicking.
    let pin = match input.pin {
        Some(pin) => Some(pin),
        None if role == "OPERATOR" => None,
        None => Some(read_pin_from_stdin(&role)?),
    };

    if let Some(pin) = pin.as_deref() {
        check_pin(pin)?;
    }

    let pin_hash = match pin.as_deref() {
        Some(pin) => Some(store_db::auth::hash_pin(pin)?),
        None => None,
    };

    let id = store_db::operators::create(
        pool,
        &OperatorInput {
            emp_code: input.emp_code.trim().to_owned(),
            full_name: input.name.trim().to_owned(),
            zk_user_id: input.zk_user_id.map(|z| z.trim().to_owned()),
            role: role.clone(),
            department: input.department,
        },
        pin_hash.as_deref(),
    )
    .await
    .context("could not create the operator")?;

    println!("created {} ({role})  id {id}", input.emp_code.trim());

    if role != "OPERATOR" {
        println!();
        println!("Sign in at http://<this-machine>:8080 → ⚙ → Admin");
        println!("  employee code  {}", input.emp_code.trim());
    }

    Ok(())
}

pub async fn set_pin(pool: &PgPool, emp_code: &str, pin: Option<String>) -> Result<()> {
    // Deliberately the active-only lookup: re-enabling somebody is a decision,
    // and quietly setting a PIN on a deactivated account would hide it.
    let operator = store_db::operators::credentials_by_emp_code(pool, emp_code)
        .await?
        .with_context(|| format!("no active operator with employee code {emp_code}"))?
        .operator;

    let pin = match pin {
        Some(pin) => pin,
        None => read_pin_from_stdin(&operator.role)?,
    };
    check_pin(&pin)?;

    store_db::auth::set_pin(pool, operator.id, Some(&pin)).await?;
    println!("PIN set for {} ({})", operator.emp_code, operator.full_name);

    Ok(())
}

pub async fn list(pool: &PgPool) -> Result<()> {
    let operators = store_db::operators::list(pool, true).await?;

    if operators.is_empty() {
        println!("No operators yet.");
        println!();
        println!("Nobody can sign in to the admin console until there is one:");
        println!("  store-cli operator add --emp-code E9001 --name 'S. Rao' --role ADMIN");
        return Ok(());
    }

    println!(
        "{:<12} {:<24} {:<12} {:<10} STATE",
        "EMP CODE", "NAME", "ROLE", "DOOR ID"
    );
    for op in &operators {
        println!(
            "{:<12} {:<24} {:<12} {:<10} {}",
            op.emp_code,
            op.full_name,
            op.role,
            op.zk_user_id.as_deref().unwrap_or("—"),
            if op.active { "active" } else { "inactive" },
        );
    }

    // The door only knows people by their terminal user id. Somebody with no
    // zk_user_id can still work — via the manual-identity path (§10) — but
    // their punch will never match, and that is worth saying out loud.
    let unlinked = operators
        .iter()
        .filter(|o| o.active && o.zk_user_id.is_none())
        .count();
    if unlinked > 0 {
        println!();
        println!(
            "{unlinked} active operator(s) have no door id. Their punches cannot be \
             matched — they will have to use \"Enter manually\"."
        );
    }

    Ok(())
}

fn normalise_role(role: &str) -> Result<String> {
    let upper = role.trim().to_uppercase();
    if ROLES.contains(&upper.as_str()) {
        Ok(upper)
    } else {
        bail!("role must be one of {}", ROLES.join(", "))
    }
}

/// A PIN short enough to shoulder-surf is the point — these are typed on a
/// shop floor — but four digits is the floor, and an empty one would lock
/// nothing.
fn check_pin(pin: &str) -> Result<()> {
    if pin.trim().len() < 4 {
        bail!("a PIN must be at least 4 characters");
    }
    if pin.trim() != pin {
        bail!(
            "a PIN cannot start or end with a space — it will not be typed back the same way"
        );
    }
    Ok(())
}

/// Read a PIN from stdin rather than the command line.
///
/// `--pin 1234` puts the PIN in shell history and in the process list, where
/// anyone on the machine can read it. Piping avoids both.
fn read_pin_from_stdin(role: &str) -> Result<String> {
    use std::io::{BufRead, IsTerminal, Write};

    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        // No hidden input without another dependency, so say so rather than
        // let somebody believe a PIN they typed was not shown.
        print!("PIN for this {role} (it will be visible): ");
        std::io::stdout().flush().ok();
    }

    let mut line = String::new();
    stdin
        .lock()
        .read_line(&mut line)
        .context("could not read a PIN from stdin")?;

    let pin = line.trim_end_matches(['\r', '\n']).to_owned();
    if pin.is_empty() {
        bail!("no PIN given (pass --pin, or pipe one in)");
    }
    Ok(pin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_accepted_in_any_casing_and_nothing_else_is() {
        assert_eq!(normalise_role("admin").unwrap(), "ADMIN");
        assert_eq!(normalise_role("  StoreKeeper ").unwrap(), "STOREKEEPER");
        assert!(normalise_role("SUPERUSER").is_err());
        assert!(normalise_role("").is_err());
    }

    #[test]
    fn a_pin_has_to_be_typeable_back_exactly() {
        assert!(check_pin("1234").is_ok());
        assert!(check_pin("123").is_err(), "too short");
        assert!(check_pin("").is_err());
        assert!(check_pin(" 1234").is_err(), "leading space");
        assert!(check_pin("1234 ").is_err(), "trailing space");
    }
}
