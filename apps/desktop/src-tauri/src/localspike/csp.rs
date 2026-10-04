//! CSP for the loopback origin. Filled in by Task 2.

pub fn inline_script_hashes(_html: &str) -> Vec<String> {
    Vec::new()
}

pub fn csp_for(host: &str, _hashes: &[String]) -> String {
    format!("default-src 'self'; connect-src 'self' ws://{host}")
}
