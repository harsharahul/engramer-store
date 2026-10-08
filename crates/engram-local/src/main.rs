//! Runs the on-device backend as a standalone process, for tests and
//! development:
//!
//!   engram-local --data-dir <dir> [--port <n>] [--quota-bytes <n>]
//!                [--events-heartbeat-ms <n>] [--max-versions <n>]
//!                [--web-dist <dir>]
//!
//! Prints `listening on 127.0.0.1:<port>` once it accepts connections and
//! runs until interrupted.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use engram_local::server::{bind, start, AppState, ServerConfig};

const USAGE: &str = "usage: engram-local --data-dir <dir> [--port <n>] [--quota-bytes <n>] [--events-heartbeat-ms <n>] [--max-versions <n>] [--web-dist <dir>]";
const DEFAULT_QUOTA_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const DEFAULT_EVENTS_HEARTBEAT_MS: u64 = 25_000;
/// The server's defaults: ten versions per file, blobs up to 20 GiB.
const DEFAULT_MAX_VERSIONS: usize = 10;
const MAX_BLOB_BYTES: u64 = 20 * 1024 * 1024 * 1024;

struct Args {
    data_dir: PathBuf,
    port: u16,
    quota_bytes: u64,
    events_heartbeat_ms: u64,
    max_versions: usize,
    web_dist: Option<PathBuf>,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut data_dir = None;
    let mut port = 0u16;
    let mut quota_bytes = DEFAULT_QUOTA_BYTES;
    let mut events_heartbeat_ms = DEFAULT_EVENTS_HEARTBEAT_MS;
    let mut max_versions = DEFAULT_MAX_VERSIONS;
    let mut web_dist = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--port" => port = value.parse().map_err(|_| format!("bad port {value}"))?,
            "--quota-bytes" => {
                quota_bytes = value.parse().map_err(|_| format!("bad quota {value}"))?
            }
            "--events-heartbeat-ms" => {
                events_heartbeat_ms = value
                    .parse()
                    .map_err(|_| format!("bad heartbeat {value}"))?
            }
            "--max-versions" => {
                max_versions = value
                    .parse()
                    .map_err(|_| format!("bad version count {value}"))?
            }
            "--web-dist" => web_dist = Some(PathBuf::from(value)),
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(Args {
        data_dir: data_dir.ok_or("--data-dir is required")?,
        port,
        quota_bytes,
        events_heartbeat_ms,
        max_versions,
        web_dist,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("engram-local: {err}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let state = match AppState::open(ServerConfig {
        data_dir: args.data_dir,
        quota_bytes: args.quota_bytes,
        events_heartbeat_ms: args.events_heartbeat_ms,
        max_versions: args.max_versions,
        max_blob_bytes: MAX_BLOB_BYTES,
        web_dist: args.web_dist,
    }) {
        Ok(state) => Arc::new(state),
        Err(err) => {
            eprintln!("engram-local: {err}");
            return ExitCode::FAILURE;
        }
    };
    let bound = match bind(args.port) {
        Ok(listener) => match start(listener, state).await {
            Ok(bound) => bound,
            Err(err) => {
                eprintln!("engram-local: cannot serve: {err}");
                return ExitCode::FAILURE;
            }
        },
        Err(err) => {
            eprintln!("engram-local: cannot bind: {err}");
            return ExitCode::FAILURE;
        }
    };
    println!("listening on 127.0.0.1:{}", bound.port);
    let _ = std::io::stdout().flush();
    let _ = tokio::signal::ctrl_c().await;
    bound.stop().await;
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Result<Args, String> {
        parse(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_every_flag() {
        let parsed = args(&[
            "--data-dir",
            "/tmp/v",
            "--port",
            "38765",
            "--quota-bytes",
            "524288",
            "--events-heartbeat-ms",
            "200",
            "--max-versions",
            "3",
            "--web-dist",
            "/tmp/core",
        ])
        .unwrap();
        assert_eq!(parsed.data_dir, PathBuf::from("/tmp/v"));
        assert_eq!(parsed.port, 38765);
        assert_eq!(parsed.quota_bytes, 524288);
        assert_eq!(parsed.events_heartbeat_ms, 200);
        assert_eq!(parsed.max_versions, 3);
        assert_eq!(parsed.web_dist, Some(PathBuf::from("/tmp/core")));
    }

    #[test]
    fn defaults_to_any_port_and_the_server_quota() {
        let parsed = args(&["--data-dir", "/tmp/v"]).unwrap();
        assert_eq!(parsed.port, 0);
        assert_eq!(parsed.quota_bytes, DEFAULT_QUOTA_BYTES);
        assert_eq!(parsed.events_heartbeat_ms, DEFAULT_EVENTS_HEARTBEAT_MS);
        assert_eq!(parsed.max_versions, DEFAULT_MAX_VERSIONS);
    }

    #[test]
    fn refuses_missing_and_unknown_flags() {
        assert!(args(&[]).is_err());
        assert!(args(&["--data-dir"]).is_err());
        assert!(args(&["--data-dir", "/tmp/v", "--verbose", "1"]).is_err());
    }
}
