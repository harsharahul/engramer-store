//! CSP for the loopback origin, mirroring apps/server/src/app.ts `cspFor`
//! and `hashInlineScripts` for a plain-http host. The web client has one
//! inline script (the theme pre-paint), so the policy must carry its hash
//! or the page loads without it.

use base64::Engine;
use sha2::{Digest, Sha256};

/// sha256 source expressions for every inline <script> body in index.html,
/// in document order, skipping scripts with a src attribute and empty
/// bodies, exactly as the Node server does at startup.
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<script") {
        let tag_start = from + start;
        let Some(tag_end_rel) = lower[tag_start..].find('>') else { break };
        let tag_end = tag_start + tag_end_rel;
        let tag = &lower[tag_start..tag_end];
        let Some(close_rel) = lower[tag_end + 1..].find("</script>") else { break };
        let close = tag_end + 1 + close_rel;
        let has_src = tag.split_whitespace().any(|attr| attr.starts_with("src="));
        if !has_src {
            let body = &html[tag_end + 1..close];
            if !body.trim().is_empty() {
                let digest = Sha256::digest(body.as_bytes());
                out.push(format!(
                    "sha256-{}",
                    base64::engine::general_purpose::STANDARD.encode(digest)
                ));
            }
        }
        from = close + "</script>".len();
    }
    out
}

/// The Node server's policy for a plain-http origin at `host` (host:port):
/// no `upgrade-insecure-requests`, ws:// for the relay, `stream:` for the
/// shell's media protocol.
pub fn csp_for(host: &str, hashes: &[String]) -> String {
    let hashes: String = hashes.iter().map(|h| format!(" '{h}'")).collect();
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

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "<!doctype html><script>\n  console.log(\"spike\");\n</script><script src=\"/assets/app.js\"></script><SCRIPT type=\"module\">   </SCRIPT>";

    #[test]
    fn hashes_match_the_node_server() {
        // Computed with Node: createHash("sha256").update(body, "utf8").digest("base64")
        // for body "\n  console.log(\"spike\");\n".
        assert_eq!(
            inline_script_hashes(FIXTURE),
            vec!["sha256-X/EMeFCuUbkCqn3aYYNphvU6LjLsSo2ImHvIPwULSto=".to_string()]
        );
    }

    #[test]
    fn scripts_with_src_and_empty_bodies_are_skipped() {
        assert_eq!(inline_script_hashes(FIXTURE).len(), 1);
    }

    #[test]
    fn no_inline_scripts_means_no_hashes() {
        assert!(inline_script_hashes("<!doctype html><script src=\"/a.js\"></script>").is_empty());
        assert!(inline_script_hashes("").is_empty());
    }

    #[test]
    fn the_policy_is_the_servers_plain_http_policy() {
        let policy = csp_for("127.0.0.1:38765", &["sha256-abc".to_string()]);
        assert_eq!(
            policy,
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:38765; img-src 'self' blob: data:; media-src 'self' blob: stream:; font-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
        );
        assert!(!policy.contains("upgrade-insecure-requests"));
    }
}
