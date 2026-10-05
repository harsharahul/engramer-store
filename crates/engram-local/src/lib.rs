//! On-device Engram Store backend. It serves the part of the server API a
//! single device needs, over the server's own SQLite schema, so the
//! unchanged web client can run against a vault that never leaves the
//! device. Every cryptographic operation stays in the client, as with a
//! server: this backend stores ciphertext and wrapped keys only.

pub mod error;
pub mod server;
pub mod store;
pub mod token;
