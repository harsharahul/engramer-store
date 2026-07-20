# Security

## Threat model

Engramer Store is designed so that a fully compromised server cannot read user content.

**Protected against a malicious or compromised server:**

- File contents, file names, folder names, thumbnails, and extracted search text are ciphertext on the server. Keys are wrapped with the client-held master key.
- Authentication uses a one-way login key derived from the password-derived key encryption key. The stored digest cannot be inverted into any decryption key.
- Public share links carry the file key in the URL fragment, which is never transmitted to the server.

**Visible to the server (metadata):** blob sizes, timestamps, the folder tree shape, account email, and access patterns. Traffic analysis is out of scope for the current design.

**Not protected:**

- A compromised client device or browser. The client is the trust anchor: whoever controls the code served to the browser controls the cryptography. Self-hosting keeps that code under the operator's control.
- Weak passwords. Argon2id at sensitive parameters slows offline guessing but cannot rescue a guessable password.
- Loss of both the password and the recovery key. There is no backdoor; the data is unrecoverable by design.

## Cryptography

All primitives come from [libsodium](https://doc.libsodium.org/):

- Argon2id (`crypto_pwhash`) for password key derivation, sensitive parameters with recorded fallback.
- XSalsa20-Poly1305 (`crypto_secretbox`) for key wrapping and metadata.
- XChaCha20-Poly1305 streaming AEAD (`crypto_secretstream`) for file content, 4 MiB chunks. Truncation, reordering, and bit flips fail authentication.
- X25519 sealed boxes (`crypto_box_seal`) for asymmetric key sharing.
- BLAKE2b (`crypto_generichash`, `crypto_kdf`) for digests and subkey derivation.

The full key hierarchy is documented in [docs/architecture.md](docs/architecture.md).

## Reporting a vulnerability

Report vulnerabilities privately by email to harsharahul@boggaram.net. Do not open a public issue for security reports. You can expect an acknowledgement within a few days.
