//! Session tokens: HS256 JSON Web Tokens carrying the server's claims
//! (`uid`, `ep`, `iat`, `exp`), signed with the data directory's
//! `jwt-secret` file. The key is the file's text, as the Node server uses
//! it, so either backend verifies the other's tokens over the same file.

use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use engram_core::b64::{from_b64url, to_b64url};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// The secret's file name inside the data directory, as on the server.
pub const SECRET_FILE: &str = "jwt-secret";
/// Tokens are minted for thirty days, as on the server.
pub const TOKEN_LIFETIME_SECS: i64 = 30 * 24 * 3600;
/// The shortest secret accepted; a generated one is 43 characters.
pub const MIN_SECRET_LEN: usize = 32;
const HEADER: &str = r#"{"alg":"HS256","typ":"JWT"}"#;

type HmacSha256 = Hmac<Sha256>;

/// The claims a token carries; `ep` and `pending` are optional, as on the
/// server (a two-factor pending token has `pending` and no `ep`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Claims {
    pub uid: i64,
    #[serde(default)]
    pub ep: Option<i64>,
    #[serde(default)]
    pub pending: Option<bool>,
    #[serde(default)]
    pub iat: Option<i64>,
    #[serde(default)]
    pub exp: Option<i64>,
}

#[derive(Serialize)]
struct Payload {
    uid: i64,
    ep: i64,
    iat: i64,
    exp: i64,
}

/// Signs and verifies session tokens with one secret.
pub struct Tokens {
    secret: String,
}

impl Tokens {
    pub fn new(secret: impl Into<String>) -> Tokens {
        Tokens {
            secret: secret.into(),
        }
    }

    /// Reads `<data_dir>/jwt-secret`, or creates it (32 random bytes,
    /// base64url, owner-only) when it does not exist yet. A file holding
    /// fewer than `MIN_SECRET_LEN` characters is refused: an empty or
    /// guessable key would let any local process sign a session token.
    pub fn load_or_create(data_dir: &Path) -> io::Result<Tokens> {
        let path = data_dir.join(SECRET_FILE);
        match std::fs::read_to_string(&path) {
            Ok(text) if text.trim().len() >= MIN_SECRET_LEN => Ok(Tokens::new(text.trim())),
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "{} holds fewer than {MIN_SECRET_LEN} characters; remove it to create a new one (every session then ends)",
                    path.display()
                ),
            )),
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                let secret = to_b64url(&engram_core::backend::random_bytes(32));
                write_private(&path, &secret)?;
                Ok(Tokens::new(secret))
            }
            Err(err) => Err(err),
        }
    }

    /// The secret's text; the decoy key attributes are derived from it.
    pub fn secret(&self) -> &str {
        &self.secret
    }

    /// A session token for `uid` at token epoch `ep`, issued at `now`.
    pub fn sign(&self, uid: i64, ep: i64, now: i64) -> String {
        let payload = serde_json::to_string(&Payload {
            uid,
            ep,
            iat: now,
            exp: now + TOKEN_LIFETIME_SECS,
        })
        .expect("claims serialize");
        let signing_input = format!(
            "{}.{}",
            to_b64url(HEADER.as_bytes()),
            to_b64url(payload.as_bytes())
        );
        let signature = to_b64url(&self.mac(signing_input.as_bytes()));
        format!("{signing_input}.{signature}")
    }

    /// The token's claims when its HS256 signature is valid and it has not
    /// expired at `now`; None otherwise.
    pub fn verify(&self, token: &str, now: i64) -> Option<Claims> {
        let mut parts = token.split('.');
        let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let head: serde_json::Value = serde_json::from_slice(&from_b64url(header).ok()?).ok()?;
        if head.get("alg")?.as_str()? != "HS256" {
            return None;
        }
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes()).ok()?;
        mac.update(format!("{header}.{payload}").as_bytes());
        mac.verify_slice(&from_b64url(signature).ok()?).ok()?;
        let claims: Claims = serde_json::from_slice(&from_b64url(payload).ok()?).ok()?;
        if matches!(claims.exp, Some(exp) if exp <= now) {
            return None;
        }
        Some(claims)
    }

    fn mac(&self, message: &[u8]) -> Vec<u8> {
        let mut mac = HmacSha256::new_from_slice(self.secret.as_bytes()).expect("any key length");
        mac.update(message);
        mac.finalize().into_bytes().to_vec()
    }
}

/// Seconds since the Unix epoch, the unit of `iat` and `exp`.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Writes an owner-only file all at once: the text goes to a temporary
/// file first, then a hard link gives it its name, so a crash never
/// leaves a partly written secret and an existing one is never replaced.
fn write_private(path: &Path, text: &str) -> io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::hard_link(&temp, path)
    })();
    let _ = std::fs::remove_file(&temp);
    written
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minted by Node's HMAC for secret "test-secret-from-node":
    /// { uid: 7, ep: 2, iat: 1700000000, exp: 1702592000 }.
    const NODE_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOjcsImVwIjoyLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMjU5MjAwMH0.gYOZorvVKefZ_lzkkmzWTuR1n8w0Xjm11f468aWPRw8";

    #[test]
    fn verifies_a_token_the_node_server_signed() {
        let tokens = Tokens::new("test-secret-from-node");
        let claims = tokens.verify(NODE_TOKEN, 1_700_000_100).unwrap();
        assert_eq!(claims.uid, 7);
        assert_eq!(claims.ep, Some(2));
        assert_eq!(claims.iat, Some(1_700_000_000));
    }

    #[test]
    fn signs_the_servers_claims_for_thirty_days() {
        let tokens = Tokens::new("s");
        let token = tokens.sign(3, 1, 1_000);
        let claims = tokens.verify(&token, 1_001).unwrap();
        assert_eq!(
            claims,
            Claims {
                uid: 3,
                ep: Some(1),
                pending: None,
                iat: Some(1_000),
                exp: Some(1_000 + TOKEN_LIFETIME_SECS),
            }
        );
        let payload = token.split('.').nth(1).unwrap();
        let text = String::from_utf8(from_b64url(payload).unwrap()).unwrap();
        assert_eq!(
            text,
            format!(
                r#"{{"uid":3,"ep":1,"iat":1000,"exp":{}}}"#,
                1_000 + TOKEN_LIFETIME_SECS
            )
        );
    }

    #[test]
    fn refuses_expired_tampered_and_foreign_tokens() {
        let tokens = Tokens::new("test-secret-from-node");
        assert!(
            tokens.verify(NODE_TOKEN, 1_702_592_000).is_none(),
            "expired"
        );
        assert!(
            Tokens::new("another")
                .verify(NODE_TOKEN, 1_700_000_100)
                .is_none(),
            "foreign key"
        );
        let mut tampered = NODE_TOKEN.to_string();
        tampered.pop();
        tampered.push('A');
        assert!(
            tokens.verify(&tampered, 1_700_000_100).is_none(),
            "tampered"
        );
        assert!(tokens.verify("a.b", 1).is_none());
        assert!(tokens.verify("a.b.c.d", 1).is_none());
    }

    #[test]
    fn refuses_an_unsigned_token() {
        let tokens = Tokens::new("s");
        let header = to_b64url(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = to_b64url(br#"{"uid":1,"ep":0}"#);
        assert!(tokens.verify(&format!("{header}.{payload}."), 1).is_none());
    }

    #[test]
    fn creates_the_secret_once_and_reuses_it() {
        let dir = std::env::temp_dir().join(format!(
            "engram-local-token-{}-{}",
            std::process::id(),
            now_secs()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let first = Tokens::load_or_create(&dir).unwrap();
        let second = Tokens::load_or_create(&dir).unwrap();
        assert_eq!(first.secret(), second.secret());
        assert_eq!(from_b64url(first.secret()).unwrap().len(), 32);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(SECRET_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_empty_or_short_secret_file() {
        let dir = std::env::temp_dir().join(format!(
            "engram-local-token-short-{}-{}",
            std::process::id(),
            now_secs()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // An empty key would let any local process sign a token for any account.
        for text in ["", "  \n", "too-short"] {
            std::fs::write(dir.join(SECRET_FILE), text).unwrap();
            let err = Tokens::load_or_create(&dir)
                .err()
                .expect("a short secret is refused");
            assert_eq!(err.kind(), io::ErrorKind::InvalidData, "{text:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
