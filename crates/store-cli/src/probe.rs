//! `store-cli device-probe` — capture what a real terminal actually sends.
//!
//! §9 ends with a warning worth repeating here:
//!
//! > ⚠️ Firmware families vary in casing, parameter names and stamp semantics.
//! > At M2, run `store-cli device-probe --listen 8080`, point a real terminal
//! > at it, and dump every raw request to disk. Reconcile this spec against
//! > that capture and update this file if they differ. **Do not assume.**
//!
//! So this listener answers the terminal well enough to keep it talking, and
//! writes down everything it hears. §14: the capture becomes a CI fixture and
//! is replayed forever, so the next firmware change is found by a test rather
//! than by an operator.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::routing::any;
use axum::Router;
use chrono::Utc;
use store_adms::protocol::{attlog_ack, parse_attlog, DeviceQuery, HandshakeOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

#[derive(Clone)]
struct ProbeState {
    log: Arc<Mutex<tokio::fs::File>>,
    out_dir: PathBuf,
}

pub async fn run(port: u16, out_dir: PathBuf) -> Result<()> {
    tokio::fs::create_dir_all(&out_dir)
        .await
        .with_context(|| format!("could not create {}", out_dir.display()))?;

    let capture_path = out_dir.join(format!(
        "adms-capture-{}.log",
        Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let file = tokio::fs::File::create(&capture_path)
        .await
        .with_context(|| format!("could not create {}", capture_path.display()))?;

    let state = ProbeState {
        log: Arc::new(Mutex::new(file)),
        out_dir: out_dir.clone(),
    };

    // A single catch-all route: the point is to see requests we did *not*
    // anticipate, and a typed router would 404 exactly those.
    let app = Router::new().fallback(any(capture)).with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("could not bind port {port}"))?;

    println!("device-probe listening on 0.0.0.0:{port}");
    println!("capture: {}", capture_path.display());
    println!();
    println!("Point the terminal's ADMS server address at this machine and this port,");
    println!("then punch a few times. Ctrl-C when you have enough.");
    println!();

    axum::serve(listener, app).await?;
    Ok(())
}

async fn capture(
    State(state): State<ProbeState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> (StatusCode, String) {
    let body_text = String::from_utf8_lossy(&body).into_owned();
    let q = DeviceQuery::parse(query.as_deref().unwrap_or_default());

    // Everything, verbatim. Tabs are escaped so the log stays readable without
    // losing the field boundaries that matter.
    let mut record = String::new();
    record.push_str(&format!("=== {} ===\n", Utc::now().to_rfc3339()));
    record.push_str(&format!("{method} {uri}\n"));
    for (name, value) in &headers {
        record.push_str(&format!(
            "{name}: {}\n",
            value.to_str().unwrap_or("<binary>")
        ));
    }
    record.push_str(&format!("--- body ({} bytes) ---\n", body.len()));
    record.push_str(&body_text.replace('\t', "\\t"));
    if !body_text.ends_with('\n') {
        record.push('\n');
    }

    // Answer well enough to keep the device talking, so the capture keeps
    // filling up instead of stopping after one failed handshake.
    let path = uri.path();
    let serial = q.serial.clone().unwrap_or_else(|| "UNKNOWN".to_owned());

    let response = if path.contains("getrequest") {
        "OK".to_owned()
    } else if method == Method::POST {
        let (records, rejected) = parse_attlog(&body_text);
        record.push_str(&format!(
            "--- parsed: {} records, {} rejected ---\n",
            records.len(),
            rejected.len()
        ));
        for r in &records {
            record.push_str(&format!(
                "  user={} device_ts={:?} verify={:?} status={:?}\n",
                r.user_id, r.device_ts, r.verify_mode, r.status
            ));
        }
        for (line, err) in &rejected {
            // These are the lines that mean our understanding of the firmware
            // is wrong. They are the whole reason to run this.
            record.push_str(&format!("  REJECTED {line:?}: {err}\n"));
        }
        attlog_ack(records.len() + rejected.len())
    } else {
        HandshakeOptions::new(&serial).render()
    };

    record.push_str(&format!(
        "--- responded ---\n{}\n\n",
        response.replace('\t', "\\t")
    ));

    print!("{record}");

    let mut log = state.log.lock().await;
    if let Err(err) = log.write_all(record.as_bytes()).await {
        eprintln!("could not write capture: {err}");
    }
    let _ = log.flush().await;
    drop(log);

    // Raw bodies are also written individually, so an ATTLOG batch can be
    // replayed byte-for-byte as a test fixture.
    if !body.is_empty() {
        let name = format!(
            "body-{}-{}.txt",
            Utc::now().format("%H%M%S%3f"),
            path.trim_matches('/').replace('/', "_")
        );
        let _ = tokio::fs::write(state.out_dir.join(name), &body).await;
    }

    (StatusCode::OK, response)
}
