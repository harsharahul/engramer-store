//! On-device Engram Store backend. It serves the part of the server API a
//! single device needs, over the server's own SQLite schema, so the
//! unchanged web client can run against a vault that never leaves the
//! device. Every cryptographic operation stays in the client, as with a
//! server: this backend stores ciphertext and wrapped keys only.

pub mod accounts;
pub mod error;
pub mod events;
pub mod extract;
pub mod headers;
pub mod server;
pub mod sessions;
pub mod settings;
pub mod store;
pub mod token;
pub mod validate;
