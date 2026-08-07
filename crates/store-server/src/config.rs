//! Server configuration.

use std::env;

/// The shared secret a tablet types once during setup (§11).
///
/// Defaulting is deliberate but noisy: a store that has not set one still works
/// on day one, and the log makes it obvious that it should be set before the
/// tablets go on the wall.
pub fn enrolment_secret() -> String {
    env::var("STORE_ENROLMENT_SECRET").unwrap_or_else(|_| {
        tracing::warn!(
            "STORE_ENROLMENT_SECRET is not set; using the development default. \
             Set it before putting tablets on the shop floor."
        );
        "electronix-dev-enrolment".to_owned()
    })
}
