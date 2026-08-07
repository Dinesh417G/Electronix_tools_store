//! Stamps build metadata into the binary.
//!
//! The version itself comes from Cargo.toml — the DNC release model applies
//! here too: the tag is only the trigger, the committed manifest is the truth.
//! This only adds the two things Cargo does not know.

use std::process::Command;

fn main() {
    // Rebuild when the web bundle changes, so a UI-only edit does not silently
    // ship the previous bundle embedded in the binary.
    println!("cargo:rerun-if-changed=../store-web/dist");
    println!("cargo:rerun-if-changed=build.rs");

    let git_sha = Command::new("git")
        .args(["rev-parse", "--short=12", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_owned())
        // A release built from a source tarball has no git. Say so rather than
        // pretending to a SHA.
        .unwrap_or_else(|| "unknown".to_owned());

    println!("cargo:rustc-env=STORE_GIT_SHA={git_sha}");

    // SOURCE_DATE_EPOCH keeps a rebuild of the same commit byte-identical,
    // which is what makes the release pipeline's sha256 worth checking.
    let built_at = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(|secs| chrono::DateTime::from_timestamp(secs, 0))
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339();

    println!("cargo:rustc-env=STORE_BUILT_AT={built_at}");
}
