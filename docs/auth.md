# Authentication

Engram Store separates two things that are often conflated: proving who you
are to the server, and decrypting your data. The server can gate access to
ciphertext; only your password-derived keys can turn that ciphertext into
files. Every mechanism below strengthens the first without ever touching the
second.

## Password login

The password never leaves the device. Argon2id (moderate profile) turns it
into a key-encryption key; a one-way subkey of that (the login key) is sent to
the server, which stores only a BLAKE2b digest. Verifying a login therefore
proves knowledge of the password while giving the server nothing that can
derive any key.

## Two-factor authentication (TOTP)

- Standard RFC 6238 codes (SHA-1, 6 digits, 30-second steps): every
  authenticator app works. Enrollment shows a QR code and a manual key;
  enabling requires a first valid code, which also guards against scanning
  mistakes.
- Login becomes two steps: a correct password returns only a short-lived
  pending token; **key attributes are withheld until a valid code is
  presented.** The pending token is refused by every other endpoint.
- One step of clock drift is tolerated. Each accepted code's time step is
  recorded and may never be used again, so intercepted codes cannot be
  replayed.
- Ten one-time recovery codes are issued at enrollment, shown exactly once,
  and stored only as digests. Using one consumes it.
- Disabling two-factor requires a current code or a recovery code.
- The local S3 bridge supports two-factor accounts through the `ENGRAM_TOTP`
  environment variable.

What two-factor does and does not do in an end-to-end encrypted system: it
gates the server's willingness to serve your ciphertext and accept writes. The
encryption itself remains derived from your password; a second factor can
neither weaken nor substitute for it. This is the same division used by other
end-to-end encrypted products.

## Throttling

All authentication endpoints share a failure throttle keyed by address and
claimed identity: a handful of free attempts, then exponentially growing
delays (capped at fifteen minutes), answered with HTTP 429 and a Retry-After
header. Success clears the slate; other identities from the same address are
unaffected.

## Session state

Sessions are bearer tokens (30-day JWT). The decrypted keys live in
sessionStorage, scoped to the tab and cleared on lock. A failed first sync
after unlock surfaces an explicit retry rather than blocking the interface,
and pages restored from the browser's back/forward cache reload cleanly.

## Planned: bring-your-own SSO (OpenID Connect)

The design, so self-hosters can front the vault with their own identity
provider (Keycloak, Authentik, Authelia, Google, Entra, or any compliant
issuer):

- Configuration by environment: issuer URL, client id, client secret; the
  server reads the issuer's discovery document and validates ID tokens
  against its JWKS. Authorization-code flow with PKCE.
- OIDC replaces the **password proof**, not the password: a successful OIDC
  login yields the session token and the account's key attributes, after
  which the client asks for the vault password purely to unwrap keys locally.
  Nothing about the key hierarchy changes, and the identity provider never
  sees a password or a key.
- Accounts link to an OIDC subject explicitly (by verified email match or a
  one-time link step while signed in); auto-provisioning of new accounts is a
  deliberate configuration flag, off by default.
- Two-factor policy stays coherent: if the identity provider already enforces
  a second factor, the local TOTP step can be marked satisfied by
  configuration; otherwise both apply.

This keeps the zero-knowledge property intact under SSO: the identity
provider decides who may talk to the server; only the vault password decides
who can read anything.
