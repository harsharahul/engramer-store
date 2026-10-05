//! The server's response headers (its `onSend` hook) for a plain-http
//! loopback origin: the content security policy and its companions, on
//! every response.

use axum::http::header::{
    CONTENT_SECURITY_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue};

/// The server's policy for a plain-http origin at `host` (host:port), with
/// the sha256 sources of any inline scripts the served page carries.
pub fn csp_for(host: &str, script_hashes: &[String]) -> String {
    let hashes: String = script_hashes.iter().map(|h| format!(" '{h}'")).collect();
    [
        "default-src 'self'".to_string(),
        format!("script-src 'self' 'wasm-unsafe-eval'{hashes}"),
        "worker-src 'self' blob:".to_string(),
        format!("connect-src 'self' ws://{host}"),
        "img-src 'self' blob: data:".to_string(),
        "media-src 'self' blob: stream:".to_string(),
        "font-src 'self'".to_string(),
        "style-src 'self' 'unsafe-inline'".to_string(),
        "frame-src 'self' blob:".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'self'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

/// Sets every header the server sends on a response, for `host`.
pub fn apply(headers: &mut HeaderMap, host: &str) {
    if let Ok(csp) = HeaderValue::from_str(&csp_for(host, &[])) {
        headers.insert(CONTENT_SECURITY_POLICY, csp);
    }
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_is_the_servers_plain_http_policy() {
        assert_eq!(
            csp_for("127.0.0.1:38765", &[]),
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:38765; img-src 'self' blob: data:; media-src 'self' blob: stream:; font-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        );
        assert!(csp_for("h:1", &["sha256-abc".to_string()])
            .contains("'wasm-unsafe-eval' 'sha256-abc';"));
    }

    #[test]
    fn apply_sets_every_companion_header() {
        let mut headers = HeaderMap::new();
        apply(&mut headers, "127.0.0.1:1");
        for (name, value) in [
            ("x-content-type-options", "nosniff"),
            ("x-frame-options", "DENY"),
            ("referrer-policy", "no-referrer"),
            (
                "permissions-policy",
                "camera=(), microphone=(), geolocation=()",
            ),
            ("cross-origin-opener-policy", "same-origin"),
            ("cross-origin-resource-policy", "same-origin"),
        ] {
            assert_eq!(headers.get(name).unwrap(), value, "{name}");
        }
        assert!(headers.contains_key("content-security-policy"));
    }
}
