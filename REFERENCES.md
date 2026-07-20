# References

Prior work and documentation that informed the design of Engramer Store.

- Ente. "Architecture." https://ente.io/architecture. The key hierarchy model: password-derived key encryption key, random master key, per-object keys, recovery key, and one-way login key.
- Frank Denis et al. "libsodium documentation." https://doc.libsodium.org/. All cryptographic primitives: `crypto_pwhash` (Argon2id), `crypto_secretbox`, `crypto_secretstream_xchacha20poly1305`, `crypto_box_seal`, `crypto_generichash`, `crypto_kdf`.
- Biryukov, Dinu, Khovratovich. "Argon2: the memory-hard function for password hashing and other applications." RFC 9106. https://www.rfc-editor.org/rfc/rfc9106.
- Bernstein, D. J. "Cryptography in NaCl." https://nacl.cr.yp.to/. The secretbox and box constructions.
- Nir, Langley. "ChaCha20 and Poly1305 for IETF Protocols." RFC 8439. https://www.rfc-editor.org/rfc/rfc8439.
- WHATWG. "URL Standard: fragment." https://url.spec.whatwg.org/. Fragment semantics underpinning key-in-fragment share links.
