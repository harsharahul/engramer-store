# Security

## Threat model

Engram Store is designed so that a fully compromised server cannot read user content.

**Protected against a malicious or compromised server:**

- File contents, file names, folder names, thumbnails, and extracted search text are ciphertext on the server. Keys are wrapped with the client-held master key.
- Authentication uses a one-way login key derived from the password-derived key encryption key. The stored digest cannot be inverted into any decryption key.
- Public share links carry the file key in the URL fragment, which is never transmitted to the server.
- The password-hashing parameters the server hands out before login are checked against a floor on the client, so a server cannot weaken key derivation to make offline guessing cheap.

**Visible to the server (metadata):** blob sizes, timestamps, the folder tree shape, account email, and access patterns. Traffic analysis is out of scope for the current design.

**What the server can do that the design does not prevent:**

- Serve an older version of a file and its metadata as if current. Every version authenticates under the file's key; there is no client-side freshness proof.
- Name a wrong public key when one account shares with another, or when a stranger uploads through a file request. Sharing seals the file key to the key the server reports. To make a substitution visible, every account has a key fingerprint shown in Profile and beside each claimant in the share dialog, the first key released to a person is pinned and a later change stops the release until the owner has compared fingerprints, and file-request links carry the owner's key so the receiving page refuses a server that names another. A fingerprint compared out of band is the check; the pin is what makes a change visible.

**Not protected:**

- A compromised client device or browser. The client is the trust anchor: whoever controls the code served to the browser controls the cryptography. The Mac and iPhone apps load the client from the deployment they are pointed at, so they share this property rather than escaping it. Self-hosting keeps that code under the operator's control.
- Weak passwords. Argon2id slows offline guessing but cannot rescue a guessable password.
- Loss of both the password and the recovery key. There is no backdoor; the data is unrecoverable by design.

## Sessions and devices

- Decrypted keys live in the client's memory. So that a reload does not cost the password, a tab keeps its keys sealed under a random session key the server holds for that one live session and returns only while it stands. What a browser writes to disk for a tab is therefore ciphertext and a bearer token; the token alone decrypts nothing. Signing out or locking deletes the session key, and **Sign out everywhere** in Profile ends every device's session at once. An attacker who copies the disk and replays the token before either happens can fetch the session key; an optional lock after inactivity shortens that window.
- Device unlock (Touch ID, Face ID, a passkey) stores the master key wrapped under a secret only the authenticator or the device keychain can reproduce, with the session token sealed inside. The extension handoff on Apple devices, which is opt-in, keeps the key in the device keychain behind the passcode, on that device only.
- The local S3 bridge holds the master key in process memory for as long as it runs.

## Cryptography

All primitives come from [libsodium](https://doc.libsodium.org/):

- Argon2id (`crypto_pwhash`) for password key derivation: libsodium's moderate profile (256 MiB, 3 passes) by default, with a recorded fallback for memory-constrained devices. A test asserts the parameters stay at or above the OWASP floor.
- XSalsa20-Poly1305 (`crypto_secretbox`) for key wrapping and metadata.
- XChaCha20-Poly1305 streaming AEAD (`crypto_secretstream`) for file content, 4 MiB chunks. Truncation, reordering, and bit flips fail authentication.
- X25519 sealed boxes (`crypto_box_seal`) for asymmetric key sharing.
- BLAKE2b (`crypto_generichash`, `crypto_kdf`) for digests and subkey derivation.

The full key hierarchy is documented in [docs/architecture.md](docs/architecture.md).

## Reporting a vulnerability

Report vulnerabilities privately by email to harsharahul@boggaram.net. Do not open a public issue for security reports. You can expect an acknowledgement within a few days.
