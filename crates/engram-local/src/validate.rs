//! Request validation with the server's rules (its zod schemas), so a
//! body the server refuses is refused here too, with the same opaque
//! `400 {"error":"invalid request"}`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

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

/// A request body that must be a JSON object.
pub fn object(body: &Value) -> Result<&Map<String, Value>, ApiError> {
    body.as_object().ok_or_else(ApiError::invalid_request)
}

/// `secretBoxSchema.optional()`: absent is None; present must be an
/// object with string `ciphertext` and `nonce` (null is refused, as zod's
/// `optional()` refuses it); other keys are dropped.
pub fn optional_secret_box(
    body: &Map<String, Value>,
    key: &str,
) -> Result<Option<SecretBox>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| ApiError::invalid_request()),
    }
}

/// `secretBoxSchema`: required.
pub fn secret_box(body: &Map<String, Value>, key: &str) -> Result<SecretBox, ApiError> {
    optional_secret_box(body, key)?.ok_or_else(ApiError::invalid_request)
}

/// `z.string().nullable().optional()`: absent is None, null is
/// `Some(None)`, a string is `Some(Some(text))`.
pub fn nullable_string(
    body: &Map<String, Value>,
    key: &str,
) -> Result<Option<Option<String>>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) => Ok(Some(Some(text.clone()))),
        Some(_) => Err(ApiError::invalid_request()),
    }
}

/// `z.boolean().optional()`.
pub fn optional_bool(body: &Map<String, Value>, key: &str) -> Result<Option<bool>, ApiError> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(ApiError::invalid_request()),
    }
}

/// `z.string()`: required.
pub fn string(body: &Map<String, Value>, key: &str) -> Result<String, ApiError> {
    match body.get(key) {
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Err(ApiError::invalid_request()),
    }
}

/// `z.number().int().positive()`: a JSON number that is a whole number
/// above zero (JavaScript counts `1.0` as an integer too).
pub fn positive_int(body: &Map<String, Value>, key: &str) -> Result<i64, ApiError> {
    match body.get(key).and_then(Value::as_f64) {
        Some(n) if n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 => Ok(n as i64),
        _ => Err(ApiError::invalid_request()),
    }
}

/// `z.array(z.string()).min(min).max(max)` over the value at `key`.
pub fn string_list(
    body: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<Vec<String>, ApiError> {
    list(body, key, min, max)?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(ApiError::invalid_request)
        })
        .collect()
}

/// `z.array(item).min(min).max(max)` over the value at `key`.
pub fn list<'a>(
    body: &'a Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<&'a Vec<Value>, ApiError> {
    match body.get(key) {
        Some(Value::Array(items)) if (min..=max).contains(&items.len()) => Ok(items),
        _ => Err(ApiError::invalid_request()),
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

    #[test]
    fn body_fields_follow_zod() {
        let body = serde_json::json!({
            "box": { "ciphertext": "c", "nonce": "n", "extra": 1 },
            "nullish": null,
            "text": "t",
            "flag": true,
            "ids": ["a", "b"]
        });
        let body = object(&body).unwrap();
        let sealed = secret_box(body, "box").unwrap();
        assert_eq!(
            serde_json::to_string(&sealed).unwrap(),
            r#"{"ciphertext":"c","nonce":"n"}"#
        );
        assert!(secret_box(body, "missing").is_err());
        assert!(optional_secret_box(body, "missing").unwrap().is_none());
        assert!(
            optional_secret_box(body, "nullish").is_err(),
            "null is not absent"
        );
        assert_eq!(nullable_string(body, "nullish").unwrap(), Some(None));
        assert_eq!(
            nullable_string(body, "text").unwrap(),
            Some(Some("t".to_string()))
        );
        assert_eq!(nullable_string(body, "missing").unwrap(), None);
        assert!(nullable_string(body, "flag").is_err());
        assert_eq!(optional_bool(body, "flag").unwrap(), Some(true));
        assert!(optional_bool(body, "text").is_err());
        assert_eq!(list(body, "ids", 1, 2).unwrap().len(), 2);
        assert!(list(body, "ids", 3, 5).is_err());
        assert!(object(&serde_json::json!([1])).is_err());
    }

    #[test]
    fn lists_of_strings_and_counts_follow_zod() {
        let body = serde_json::json!({ "ids": ["a", "b"], "mixed": ["a", 1], "size": 12.0, "zero": 0, "half": 1.5, "text": "3" });
        let body = object(&body).unwrap();
        assert_eq!(string_list(body, "ids", 1, 2).unwrap(), vec!["a", "b"]);
        assert!(string_list(body, "ids", 3, 5).is_err());
        assert!(string_list(body, "mixed", 1, 5).is_err());
        assert!(string_list(body, "missing", 1, 5).is_err());
        assert_eq!(positive_int(body, "size").unwrap(), 12);
        for key in ["zero", "half", "text", "missing"] {
            assert!(positive_int(body, key).is_err(), "{key}");
        }
    }
}
