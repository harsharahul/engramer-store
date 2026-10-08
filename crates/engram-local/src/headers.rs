//! The server's response headers (its `onSend` hook) for a plain-http
//! loopback origin: the content security policy and its companions on
//! every response, and the relaxed policy the sandboxed office editor
//! tree under `/office/` needs to run at all.

use axum::http::header::{
    ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_SECURITY_POLICY, REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS,
    X_FRAME_OPTIONS,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue};

/// The path prefix of the vendored office editors, which run in a
/// sandboxed frame with an opaque origin.
pub const OFFICE_PREFIX: &str = "/office/";

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

/// The server's policy for the office editor tree: the editor runs in an
/// opaque origin, so `'self'` matches nothing and the host is named
/// instead; the relaxed script policy is what the editor needs to run,
/// and the frame holds no key, no session and no storage to reach.
pub fn office_csp(host: &str) -> String {
    let own = format!("http://{host}");
    [
        format!("default-src {own}"),
        format!("script-src {own} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"),
        format!("worker-src {own} blob:"),
        format!("connect-src {own} blob:"),
        format!("img-src {own} blob: data:"),
        format!("media-src {own} blob:"),
        format!("font-src {own} data:"),
        format!("style-src {own} 'unsafe-inline'"),
        format!("frame-src {own} blob:"),
        "object-src 'none'".to_string(),
        format!("base-uri {own}"),
        "form-action 'none'".to_string(),
        "frame-ancestors 'self'".to_string(),
    ]
    .join("; ")
}

/// Sets every header the server sends on a response, for `host`, with the
/// inline script hashes of the served page.
pub fn apply(headers: &mut HeaderMap, host: &str, script_hashes: &[String]) {
    if let Ok(csp) = HeaderValue::from_str(&csp_for(host, script_hashes)) {
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

/// The headers the server sends on an office editor response: the relaxed
/// policy, and the cross-origin allowances the opaque frame needs to fetch
/// its own assets.
pub fn apply_office(headers: &mut HeaderMap, host: &str) {
    if let Ok(csp) = HeaderValue::from_str(&office_csp(host)) {
        headers.insert(CONTENT_SECURITY_POLICY, csp);
    }
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("cross-origin"),
    );
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.remove(X_FRAME_OPTIONS);
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
    fn the_office_policy_names_the_host_instead_of_self() {
        let policy = office_csp("127.0.0.1:38765");
        assert_eq!(
            policy,
            "default-src http://127.0.0.1:38765; script-src http://127.0.0.1:38765 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src http://127.0.0.1:38765 blob:; connect-src http://127.0.0.1:38765 blob:; img-src http://127.0.0.1:38765 blob: data:; media-src http://127.0.0.1:38765 blob:; font-src http://127.0.0.1:38765 data:; style-src http://127.0.0.1:38765 'unsafe-inline'; frame-src http://127.0.0.1:38765 blob:; object-src 'none'; base-uri http://127.0.0.1:38765; form-action 'none'; frame-ancestors 'self'"
        );
        assert!(!policy.contains("'self' "));
    }

    #[test]
    fn apply_sets_every_companion_header() {
        let mut headers = HeaderMap::new();
        apply(&mut headers, "127.0.0.1:1", &["sha256-abc".to_string()]);
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
        assert!(headers
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("'sha256-abc'"));
    }

    #[test]
    fn office_responses_drop_the_frame_denial_and_open_cross_origin_reads() {
        let mut headers = HeaderMap::new();
        apply(&mut headers, "127.0.0.1:1", &[]);
        apply_office(&mut headers, "127.0.0.1:1");
        assert!(headers.get("x-frame-options").is_none());
        assert_eq!(
            headers.get("cross-origin-resource-policy").unwrap(),
            "cross-origin"
        );
        assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
        assert!(headers
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("default-src http://127.0.0.1:1;"));
    }
}
