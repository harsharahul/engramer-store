# References

Prior work and documentation that informed the design of Engram Store.

- Ente. "Architecture." https://ente.io/architecture. The key hierarchy model: password-derived key encryption key, random master key, per-object keys, recovery key, and one-way login key.
- Frank Denis et al. "libsodium documentation." https://doc.libsodium.org/. All cryptographic primitives: `crypto_pwhash` (Argon2id), `crypto_secretbox`, `crypto_secretstream_xchacha20poly1305`, `crypto_box_seal`, `crypto_generichash`, `crypto_kdf`.
- Biryukov, Dinu, Khovratovich. "Argon2: the memory-hard function for password hashing and other applications." RFC 9106. https://www.rfc-editor.org/rfc/rfc9106.
- Bernstein, D. J. "Cryptography in NaCl." https://nacl.cr.yp.to/. The secretbox and box constructions.
- Nir, Langley. "ChaCha20 and Poly1305 for IETF Protocols." RFC 8439. https://www.rfc-editor.org/rfc/rfc8439.
- WHATWG. "URL Standard: fragment." https://url.spec.whatwg.org/. Fragment semantics underpinning key-in-fragment share links.
- MEGA Limited. "MEGA Security White Paper." https://mega.io/security. Prior art for in-browser playback of end-to-end encrypted media via chunked counter-mode encryption, and the integrity trade-off that motivates per-chunk authenticated encryption here.
- Proton AG. "How Proton Drive keeps your files encrypted while downloading them." https://proton.me/blog/proton-drive-web-encryption-technique. Worker-based decrypt-and-stream pipeline for encrypted downloads in the browser.
- Amazon Web Services. "Using Amazon CloudFront Origin Shield." https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html. Origin shielding: a caching layer that absorbs repeated reads before they reach a costly origin, the pattern behind the server's content window cache.
- NGINX. "Module ngx_http_slice_module." https://nginx.org/en/docs/http/ngx_http_slice_module.html. Serving and caching large files as fixed-size byte-range slices, prior art for aligned window caching of ranged reads.
- Apple Inc. "HTTP Live Streaming." RFC 8216. https://www.rfc-editor.org/rfc/rfc8216. The segmented-delivery school of streaming; this project deliberately keeps originals unsegmented and untranscoded, trading segment simplicity for byte-identical storage.
