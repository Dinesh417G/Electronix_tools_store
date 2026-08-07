//! `store-cli update` — over-the-air updates for the server binary.
//!
//! Modelled on the ElectronIx DNC daemon updater, and for the same reasons:
//!
//! * **Verify before you swap.** The manifest carries a sha256 and it is
//!   checked before anything is moved. A truncated download must never become a
//!   running binary.
//! * **Keep the old one.** The previous binary is renamed to `.old` rather than
//!   deleted, so a rollback is one rename and a restart — under a minute, on a
//!   shop floor, without a network.
//! * **Never swap under load.** The caller stops the service first; this
//!   command refuses to guess.
//!
//! What this does *not* update is the web terminal — that needs no updater at
//! all. The bundle is embedded in the server binary, so replacing the server
//! replaces the UI, and every phone and tablet picks it up on its next load via
//! the service worker. That is the whole reason the terminal is a web app.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Where `store-cli update` looks unless told otherwise.
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/Dinesh417G/electronix-tool-store-releases/releases/latest/download/server.json";

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    pub platforms: std::collections::HashMap<String, Artifact>,
    #[serde(default)]
    pub cli: std::collections::HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
}

/// The platform key used in the manifest.
pub fn platform_key() -> String {
    let arch = std::env::consts::ARCH;
    let os = std::env::consts::OS;
    format!("{os}-{arch}")
}

/// Compare two `x.y.z` strings.
///
/// Deliberately strict: anything that is not plain semver is refused rather
/// than guessed at, because "is this newer?" is exactly the question you do not
/// want answered by a string comparison that happens to work most of the time.
pub fn is_newer(candidate: &str, current: &str) -> Result<bool> {
    fn parse(v: &str) -> Result<(u64, u64, u64)> {
        let mut parts = v.trim().trim_start_matches('v').split('.');
        let mut next = || -> Result<u64> {
            parts
                .next()
                .context("missing version component")?
                .parse::<u64>()
                .context("version component is not a number")
        };
        let triple = (next()?, next()?, next()?);
        if parts.next().is_some() {
            bail!("version {v:?} has more than three components");
        }
        Ok(triple)
    }

    Ok(
        parse(candidate).with_context(|| format!("candidate version {candidate:?}"))?
            > parse(current).with_context(|| format!("current version {current:?}"))?,
    )
}

/// Fetch and parse the release manifest.
pub async fn fetch_manifest(url: &str) -> Result<Manifest> {
    let body = reqwest::Client::builder()
        .user_agent(concat!("store-cli/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("could not reach {url}"))?
        .error_for_status()
        .context("the releases server refused the request")?
        .text()
        .await?;

    serde_json::from_str(&body).context("the manifest is not valid JSON")
}

/// `store-cli update --check`
pub async fn check(manifest_url: &str, current: &str) -> Result<()> {
    let manifest = fetch_manifest(manifest_url).await?;
    let key = platform_key();

    println!("installed: {current}");
    println!("available: {}", manifest.version);
    if let Some(published) = &manifest.pub_date {
        println!("published: {published}");
    }

    match is_newer(&manifest.version, current) {
        Ok(true) => {
            println!();
            println!("An update is available. Apply it with:");
            println!("    store-cli update --apply");
            if let Some(notes) = &manifest.notes {
                println!("Release notes: {notes}");
            }
            if !manifest.platforms.contains_key(&key) {
                println!();
                println!("⚠ No server build for {key} in this release.");
            }
            // The CLI updates itself separately: a binary cannot reliably
            // replace the file it is executing from, so this is a manual step
            // rather than something pretended to be automatic.
            if let Some(cli) = manifest.cli.get(&key) {
                println!();
                println!("This release also ships a new store-cli:");
                println!("    curl -fL -o store-cli.new {}", cli.url);
                println!("    # verify: sha256sum store-cli.new  ->  {}", cli.sha256);
                println!("    chmod +x store-cli.new && mv store-cli.new \"$(command -v store-cli)\"");
            }
        }
        Ok(false) => println!("\nAlready up to date."),
        Err(err) => println!("\nCould not compare versions: {err:#}"),
    }

    Ok(())
}

/// `store-cli update --apply`
///
/// The order here is the important part, and it is the order DNC uses:
/// download → verify → write alongside → rename old aside → rename new in. Up
/// to the final rename, nothing is disturbed; after it, the previous binary is
/// still on disk under `.old`.
pub async fn apply(
    manifest_url: &str,
    current: &str,
    target: Option<PathBuf>,
    force: bool,
) -> Result<()> {
    let manifest = fetch_manifest(manifest_url).await?;
    let key = platform_key();

    if !force && !is_newer(&manifest.version, current).unwrap_or(false) {
        println!("Already on {current}; nothing to do. Use --force to reinstall.");
        return Ok(());
    }

    let artifact = manifest
        .platforms
        .get(&key)
        .with_context(|| format!("release {} has no build for {key}", manifest.version))?;

    let target = match target {
        Some(path) => path,
        None => default_server_path()?,
    };

    println!("Updating {} → {}", current, manifest.version);
    println!("  target:  {}", target.display());
    println!("  source:  {}", artifact.url);

    let bytes = download(&artifact.url).await?;
    println!("  fetched: {} bytes", bytes.len());

    // Verify BEFORE anything on disk is touched.
    let actual = hex(&Sha256::digest(&bytes));
    if !actual.eq_ignore_ascii_case(&artifact.sha256) {
        bail!(
            "sha256 mismatch — refusing to install.\n  expected {}\n  got      {}",
            artifact.sha256,
            actual
        );
    }
    println!("  sha256:  verified");

    swap_in(&target, &bytes)?;

    println!();
    println!("Installed {}.", manifest.version);
    println!("The previous binary is at {}.old", target.display());
    println!();
    println!("Restart the service to pick it up. If it does not come back:");
    println!(
        "    mv {p}.old {p}     # then start the service again",
        p = target.display()
    );
    println!();
    println!("Every phone and tablet gets the new terminal on its next load —");
    println!("the browser is offered a reload, so nobody is interrupted mid-issue.");

    Ok(())
}

async fn download(url: &str) -> Result<Vec<u8>> {
    let response = reqwest::Client::builder()
        .user_agent(concat!("store-cli/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(300))
        .build()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("could not download {url}"))?
        .error_for_status()
        .context("the download was refused")?;

    Ok(response.bytes().await?.to_vec())
}

/// Write the new binary next to the target, then rename it into place.
///
/// Both files are in the same directory so the renames are atomic — a rename
/// across filesystems is a copy, and a copy can be interrupted halfway, which
/// is precisely the failure this ordering exists to avoid.
fn swap_in(target: &Path, bytes: &[u8]) -> Result<()> {
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    let staged = dir.join(format!(
        ".{}.new",
        target.file_name().unwrap_or_default().to_string_lossy()
    ));

    {
        let mut file = std::fs::File::create(&staged)
            .with_context(|| format!("could not write {}", staged.display()))?;
        file.write_all(bytes)?;
        // Flush to disk before the rename: a power cut between the two must not
        // leave a zero-length binary in place of a working one.
        file.sync_all()?;
    }

    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
        .context("could not make the new binary executable")?;

    let backup = PathBuf::from(format!("{}.old", target.display()));
    if target.exists() {
        // Leave the previous version on disk. A rollback is one rename.
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(target, &backup)
            .with_context(|| format!("could not move {} aside", target.display()))?;
    }

    if let Err(err) = std::fs::rename(&staged, target) {
        // Put things back rather than leaving the shop with no binary at all.
        if backup.exists() {
            let _ = std::fs::rename(&backup, target);
        }
        let _ = std::fs::remove_file(&staged);
        return Err(err).with_context(|| format!("could not install {}", target.display()));
    }

    Ok(())
}

/// Where the running server most likely lives.
fn default_server_path() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("could not find our own path")?;
    let dir = exe.parent().context("executable has no parent directory")?;
    let candidate = dir.join("store-server");

    if candidate.exists() {
        return Ok(candidate);
    }

    bail!(
        "could not find store-server next to {}. Pass --target /path/to/store-server.",
        exe.display()
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut acc, b| {
            use std::fmt::Write;
            let _ = write!(acc, "{b:02x}");
            acc
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_recognised() {
        assert!(is_newer("0.2.0", "0.1.0").unwrap());
        assert!(is_newer("0.1.1", "0.1.0").unwrap());
        assert!(is_newer("1.0.0", "0.9.9").unwrap());
        // Numeric, not lexicographic: "0.10.0" > "0.9.0" is the case a string
        // comparison gets wrong, and it is the one that bites after ten releases.
        assert!(is_newer("0.10.0", "0.9.0").unwrap());
    }

    #[test]
    fn same_or_older_versions_are_not_newer() {
        assert!(!is_newer("0.1.0", "0.1.0").unwrap());
        assert!(!is_newer("0.1.0", "0.2.0").unwrap());
        assert!(!is_newer("0.9.0", "0.10.0").unwrap());
    }

    #[test]
    fn a_leading_v_is_tolerated() {
        assert!(is_newer("v0.2.0", "0.1.0").unwrap());
    }

    #[test]
    fn malformed_versions_are_refused_not_guessed_at() {
        assert!(is_newer("0.2", "0.1.0").is_err());
        assert!(is_newer("0.2.0-rc1", "0.1.0").is_err());
        assert!(is_newer("0.2.0.1", "0.1.0").is_err());
        assert!(is_newer("latest", "0.1.0").is_err());
    }

    #[test]
    fn the_platform_key_matches_the_manifest_shape() {
        let key = platform_key();
        assert!(key.contains('-'), "{key}");
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        assert_eq!(key, "linux-x86_64");
    }

    #[test]
    fn a_manifest_parses() {
        let json = r#"{
          "version": "0.2.0",
          "notes": "https://example.invalid/notes",
          "pub_date": "2026-08-07T10:00:00Z",
          "platforms": {
            "linux-x86_64": { "url": "https://example.invalid/s", "sha256": "abc" }
          },
          "cli": {
            "linux-x86_64": { "url": "https://example.invalid/c", "sha256": "def" }
          }
        }"#;

        let m: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(m.version, "0.2.0");
        assert_eq!(m.platforms["linux-x86_64"].sha256, "abc");
        assert_eq!(m.cli["linux-x86_64"].url, "https://example.invalid/c");
    }

    #[test]
    fn a_manifest_without_a_cli_section_still_parses() {
        // Older releases predate the CLI artifact; they must not break the
        // updater on a shop that has not updated in a while.
        let json = r#"{
          "version": "0.1.0",
          "platforms": {
            "linux-x86_64": { "url": "https://example.invalid/s", "sha256": "abc" }
          }
        }"#;
        let m: Manifest = serde_json::from_str(json).unwrap();
        assert!(m.cli.is_empty());
    }

    #[test]
    fn swapping_keeps_the_previous_binary() {
        let dir = std::env::temp_dir().join(format!("store-cli-swap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("store-server");
        std::fs::write(&target, b"old binary").unwrap();

        swap_in(&target, b"new binary").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new binary");
        assert_eq!(
            std::fs::read(dir.join("store-server.old")).unwrap(),
            b"old binary",
            "the rollback copy was not kept"
        );

        // And it is executable, or the swap would have bricked the service.
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "new binary is not executable");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn swapping_into_an_empty_directory_works() {
        // First install, or a target that was moved away by hand.
        let dir = std::env::temp_dir().join(format!("store-cli-fresh-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("store-server");

        swap_in(&target, b"fresh").unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"fresh");
        assert!(!dir.join("store-server.old").exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
