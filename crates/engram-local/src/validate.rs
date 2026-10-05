//! Request validation with the server's rules (its zod schemas), so a
//! body the server refuses is refused here too, with the same opaque
//! `400 {"error":"invalid request"}`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};

use crate::error::ApiError;

/// zod 4's email pattern, verbatim.
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$",
    )
    .expect("email pattern")
});

/// The server's base64url key: 1 to 512 characters, at most two `=`.
static BASE64_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+={0,2}$").expect("key pattern"));

/// Argon2id floor every account must meet, as the server enforces.
pub const MIN_OPS_LIMIT: i64 = 2;
pub const MIN_MEM_LIMIT: i64 = 19 * 1024 * 1024;

/// JavaScript string length (UTF-16 code units), which zod's limits count.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript `String.prototype.trim`: Unicode white space plus the BOM.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `z.string().email().toLowerCase()`.
pub fn email(value: &str) -> Result<String, ApiError> {
    if EMAIL.is_match(value) {
        Ok(value.to_lowercase())
    } else {
        Err(ApiError::invalid_request())
    }
}

/// The server's `base64Key` rule.
pub fn login_key(value: &str) -> Result<(), ApiError> {
    if (1..=512).contains(&js_len(value)) && BASE64_KEY.is_match(value) {
        Ok(())
    } else {
        Err(ApiError::invalid_request())
    }
}

/// A JSON number that is an integer, as `z.number().int()` accepts it:
/// `3` and `3.0` both qualify; it serializes as an integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct JsInt(pub i64);

impl<'de> Deserialize<'de> for JsInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<JsInt, D::Error> {
        let number = serde_json::Number::deserialize(deserializer)?;
        if let Some(n) = number.as_i64() {
            return Ok(JsInt(n));
        }
        match number.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 => {
                Ok(JsInt(f as i64))
            }
            _ => Err(serde::de::Error::custom("not an integer")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct SecretBox {
    pub ciphertext: String,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kdf {
    pub salt: String,
    pub ops_limit: JsInt,
    pub mem_limit: JsInt,
}

/// The account's key attributes in the server's schema order; unknown
/// fields are dropped, as zod drops them, and the stored JSON keeps this
/// order.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyAttributes {
    pub kdf: Kdf,
    pub encrypted_master_key: SecretBox,
    pub master_key_encrypted_with_recovery_key: SecretBox,
    pub recovery_key_encrypted_with_master_key: SecretBox,
    pub public_key: String,
    pub encrypted_private_key: SecretBox,
}

impl KeyAttributes {
    /// The server's floor on password hashing: no account is created with
    /// parameters weaker than the OWASP minimum, whatever the client says.
    pub fn check(&self) -> Result<(), ApiError> {
        let kdf = &self.kdf;
        if js_len(&kdf.salt) < 16
            || kdf.ops_limit.0 < MIN_OPS_LIMIT
            || kdf.mem_limit.0 < MIN_MEM_LIMIT
        {
            return Err(ApiError::invalid_request());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_follows_zod() {
        for good in [
            "a@example.com",
            "First.Last+tag@Sub.Example.org",
            "o'neil@example.co",
        ] {
            assert!(email(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "not-an-email",
            "a@b",
            ".a@example.com",
            "a..b@example.com",
            "a@-x.com",
            "a b@example.com",
        ] {
            assert!(email(bad).is_err(), "{bad}");
        }
        assert_eq!(email("Alice@Example.COM").unwrap(), "alice@example.com");
    }

    #[test]
    fn login_keys_follow_the_server_rule() {
        assert!(login_key("abcDEF123_-").is_ok());
        assert!(login_key("abc==").is_ok());
        assert!(login_key("").is_err());
        assert!(login_key("***not base64***").is_err());
        assert!(login_key("abc===").is_err());
        assert!(login_key(&"a".repeat(513)).is_err());
    }

    fn attributes(ops: serde_json::Value, mem: serde_json::Value) -> serde_json::Value {
        let sb = serde_json::json!({ "ciphertext": "c", "nonce": "n" });
        serde_json::json!({
            "kdf": { "salt": "0123456789abcdef", "opsLimit": ops, "memLimit": mem },
            "encryptedMasterKey": sb,
            "masterKeyEncryptedWithRecoveryKey": sb,
            "recoveryKeyEncryptedWithMasterKey": sb,
            "publicKey": "p",
            "encryptedPrivateKey": sb,
            "extra": "dropped"
        })
    }

    #[test]
    fn key_attributes_keep_the_schema_order_and_drop_unknown_fields() {
        let parsed: KeyAttributes = serde_json::from_value(attributes(
            serde_json::json!(3),
            serde_json::json!(268435456),
        ))
        .unwrap();
        parsed.check().unwrap();
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            r#"{"kdf":{"salt":"0123456789abcdef","opsLimit":3,"memLimit":268435456},"encryptedMasterKey":{"ciphertext":"c","nonce":"n"},"masterKeyEncryptedWithRecoveryKey":{"ciphertext":"c","nonce":"n"},"recoveryKeyEncryptedWithMasterKey":{"ciphertext":"c","nonce":"n"},"publicKey":"p","encryptedPrivateKey":{"ciphertext":"c","nonce":"n"}}"#
        );
    }

    #[test]
    fn integral_floats_count_as_integers_and_fractions_do_not() {
        let parsed: KeyAttributes = serde_json::from_value(attributes(
            serde_json::json!(3.0),
            serde_json::json!(268435456),
        ))
        .unwrap();
        assert_eq!(parsed.kdf.ops_limit, JsInt(3));
        assert!(serde_json::from_value::<KeyAttributes>(attributes(
            serde_json::json!(2.5),
            serde_json::json!(268435456)
        ))
        .is_err());
        assert!(serde_json::from_value::<KeyAttributes>(attributes(
            serde_json::json!("3"),
            serde_json::json!(268435456)
        ))
        .is_err());
    }

    #[test]
    fn weak_password_hashing_is_refused() {
        let weak: KeyAttributes =
            serde_json::from_value(attributes(serde_json::json!(1), serde_json::json!(8192)))
                .unwrap();
        assert!(weak.check().is_err());
    }

    #[test]
    fn javascript_length_and_trim() {
        assert_eq!(js_len("é"), 1);
        assert_eq!(js_len("😀"), 2);
        assert_eq!(js_trim("\u{feff} name \n"), "name");
    }
}
