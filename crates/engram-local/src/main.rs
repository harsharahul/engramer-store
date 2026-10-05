//! Runs the on-device backend as a standalone process, for tests and
//! development:
//!
//!   engram-local --data-dir <dir> [--port <n>] [--quota-bytes <n>]
//!
//! Prints `listening on 127.0.0.1:<port>` once it accepts connections and
//! runs until interrupted.

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use engram_local::server::{bind, start, AppState, ServerConfig};
use engram_local::store::{Store, DB_FILE};

const USAGE: &str = "usage: engram-local --data-dir <dir> [--port <n>] [--quota-bytes <n>]";
const DEFAULT_QUOTA_BYTES: u64 = 10 * 1024 * 1024 * 1024;

struct Args {
    data_dir: PathBuf,
    port: u16,
    quota_bytes: u64,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut data_dir = None;
    let mut port = 0u16;
    let mut quota_bytes = DEFAULT_QUOTA_BYTES;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--data-dir" => data_dir = Some(PathBuf::from(value)),
            "--port" => port = value.parse().map_err(|_| format!("bad port {value}"))?,
            "--quota-bytes" => {
                quota_bytes = value.parse().map_err(|_| format!("bad quota {value}"))?
            }
            other => return Err(format!("unknown flag {other}")),
        }
    }
    Ok(Args {
        data_dir: data_dir.ok_or("--data-dir is required")?,
        port,
        quota_bytes,
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
    if let Err(err) = std::fs::create_dir_all(&args.data_dir) {
        eprintln!(
            "engram-local: cannot create {}: {err}",
            args.data_dir.display()
        );
        return ExitCode::FAILURE;
    }
    let store = match Store::open(&args.data_dir.join(DB_FILE)) {
        Ok(store) => store,
        Err(err) => {
            eprintln!("engram-local: cannot open the vault: {err}");
            return ExitCode::FAILURE;
        }
    };
    let state = Arc::new(AppState {
        store,
        config: ServerConfig {
            data_dir: args.data_dir,
            quota_bytes: args.quota_bytes,
        },
    });
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
        ])
        .unwrap();
        assert_eq!(parsed.data_dir, PathBuf::from("/tmp/v"));
        assert_eq!(parsed.port, 38765);
        assert_eq!(parsed.quota_bytes, 524288);
    }

    #[test]
    fn defaults_to_any_port_and_the_server_quota() {
        let parsed = args(&["--data-dir", "/tmp/v"]).unwrap();
        assert_eq!(parsed.port, 0);
        assert_eq!(parsed.quota_bytes, DEFAULT_QUOTA_BYTES);
    }

    #[test]
    fn refuses_missing_and_unknown_flags() {
        assert!(args(&[]).is_err());
        assert!(args(&["--data-dir"]).is_err());
        assert!(args(&["--data-dir", "/tmp/v", "--verbose", "1"]).is_err());
    }
}
