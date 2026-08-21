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

Sessions are bearer tokens (30-day JWT). The server checks every token
against the account's token epoch and disabled flag on every request, so a
credential change, a revocation, or an administrator disabling the account
ends existing sessions immediately.

The decrypted keys live in the tab's memory. So that a reload does not
cost the password, the tab keeps a reload record in sessionStorage: the
keys sealed under a random 32-byte session key that the server mints for
that one live session and returns only to that session, only while its
token epoch stands. What a browser may write to disk for a tab is
therefore ciphertext plus a bearer token, and the token alone decrypts
nothing. Signing out or locking deletes the session key on the server and
the record in the tab. **Sign out everywhere** in Profile advances the
token epoch and deletes every session key, ending every other device's
session at once while the current tab carries on with a fresh token. The
limit: someone who copies the disk and replays the token before the
session is revoked can fetch the session key. The optional **Lock
after inactivity** setting (off by default, synced with the account)
shortens that window.

Device unlock wraps the master key under a secret only the passkey or
the device keychain can reproduce, with the session token sealed inside
the same record. A failed first sync after unlock surfaces an explicit
retry rather than blocking the interface, and pages restored from the
browser's back/forward cache reload cleanly.

## Registration policy and administration

`ENGRAMER_REGISTRATION` controls who may create accounts: `open` (default),
`invite` (a single-use invite link minted by an administrator), or `closed`.
Administrators are declared by the operator through `ENGRAMER_ADMIN_EMAILS`
and may always register, which bootstraps a fresh locked-down server without
a special first-run flow.

Administrators manage what the server actually controls: accounts (usage,
status, per-user quota overrides, disable and delete), and invites. A
disabled account loses its existing sessions immediately, not just future
logins, and deleting an account removes every byte it stored. There is
deliberately no password reset: the server never holds key material, so the
recovery key is the only way back into an account. For deployments behind an
identity-aware proxy, the standard pattern of forward authentication in
front of the ingress composes cleanly with all of this.

## Browser hardening

Every response carries a Content Security Policy that is deny-by-default:
scripts and connections are restricted to this origin, `object-src` is
`none`, and framing is refused. This matters more here than in an ordinary
app because the master key lives in the page, so any script execution in
this origin would be total compromise; the policy means a compromised
dependency has nowhere to send anything. WebAssembly is allowed because
on-device OCR needs it; plain `eval` is not. The client's inline
theme-before-paint script is permitted by a hash computed from the served
page at startup, so the policy never needs `unsafe-inline` for scripts.
Cross-origin browser access is off unless origins are listed explicitly,
and the pre-login endpoint returns a stable decoy salt for unknown
addresses so it cannot be used to discover who has an account.

The media bridge, the service worker that streams decrypted video and
audio to the player, serves only video and audio, only to media elements,
and marks every response it builds as something that cannot act as a
document, so a file that arrived from someone else can never be rendered
as a page on the vault's origin.

`Strict-Transport-Security` is usually set by the TLS-terminating proxy.
Deployments whose proxy does not set it can turn it on with
`ENGRAMER_HSTS=on`; the server then sends it on responses that arrived
over HTTPS.

