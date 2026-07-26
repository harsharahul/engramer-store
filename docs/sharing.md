# Sharing

Engram Store shares files without ever giving the server a decryption key.
This document describes the two sharing surfaces: outgoing share links and
incoming file requests, and exactly what the server can and cannot see for
each.

## Share links

Sharing a file creates an opaque token; the public link is
`https://your-host/s/<token>`. What travels with the link depends on whether it
has a password.

### Open links

For a link without a password, the file key is appended to the URL as a
fragment:

```
https://your-host/s/<token>#<file-key>
```

Browsers never send the fragment over the network, so the server serves
ciphertext to anyone holding the link while the key stays inside the visitor's
browser. Decryption happens client side, and the page offers preview and
download.

### Password-protected links

A password-protected link is just `https://your-host/s/<token>`; there is no
fragment. When the owner sets a password, the client:

1. derives a link key from the password with Argon2id (a fresh salt, the same
   cost profile used for account passwords);
2. splits it into two independent subkeys: an access key and a wrap key;
3. wraps the file key under the wrap key;
4. stores three things on the server: the KDF parameters, the wrapped file
   key, and a BLAKE2b digest of the access key.

A visitor types the password, and their browser reruns the same derivation.
The access key is presented to the server, which compares digests (the same
scheme used for login) and only then returns the encrypted metadata, the
wrapped key, and, on request, the ciphertext. The wrap key never leaves the
visitor's device, so the server gates downloads on knowledge of the password
without being able to unwrap anything itself. A wrong password is rejected by
the digest check before any content is served.

The trade-off between the two forms is deliberate: an open link keeps key
material out of the server entirely but anyone who sees the link can decrypt;
a password link stores the file key on the server wrapped under an
Argon2id-derived key, in exchange for a second factor that survives the link
leaking. Choose per link.

### Expiry and download limits

Any link can carry an expiry (1 hour to 30 days, or never) and a download
limit (including exactly one download). The server enforces both: expired or
exhausted links answer with HTTP 410, and the download counter advances
atomically so two simultaneous downloads cannot both take the last slot.

### Managing links

The Shared view in the sidebar lists every active link with its file, creation
date, expiry, download count, and whether it is password protected, with copy
and revoke actions. Revocation is immediate; the token stops resolving.

## File requests

A file request is the receiving mirror of a share link: a public page anyone
can use to send files into your vault.

Creating a request produces a link of the form:

```
https://your-host/r/<token>#<label>
```

The label (what you are asking for) rides in the fragment, so the upload page
can greet the sender without the server storing the label in the clear; the
owner's copy of the label is stored encrypted under the master key.

For each file the sender picks, their browser:

1. generates a fresh file key;
2. runs the same on-device analysis as a normal upload (thumbnail, category,
   tags, text extraction), all of which ships only inside encrypted metadata;
3. encrypts content, metadata, and thumbnail with the file key;
4. seals the file key to the owner's X25519 public key (an anonymous sealed
   box), and uploads.

The server relays and stores ciphertext plus the sealed key. It cannot read
the file, the metadata, or the file key; only the owner's private key can
unseal it. On the owner's next sync the client unseals each arrival, re-wraps
the key under the master key, and files the upload into the folder the request
targets, with a notification. Arrivals count against the owner's storage quota
from the moment they land, and requests can be closed (revoked) or given an
expiry like any link.

## Server enforcement summary

| Link state | Metadata | Content | Notes |
| --- | --- | --- | --- |
| Open link | served encrypted | served encrypted | key only in the fragment |
| Password link, no proof | KDF parameters only | refused (403) | digest gate |
| Password link, wrong password | refused (403) | refused (403) | digest mismatch |
| Password link, correct proof | served encrypted + wrapped key | served encrypted | unwrap happens client side |
| Expired | 410 | 410 | checked on every request |
| Download limit reached | 410 | 410 | atomic counter claim |
| Revoked | 404 | 404 | immediate |

The public endpoints never require an account, and none of them ever handle a
plaintext byte or an unwrapped key.
