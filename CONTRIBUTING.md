# Contributing

Thanks for your interest in Engramer Store.

## Setup

```bash
pnpm install
pnpm test
pnpm build
```

Node.js 22+ and pnpm are required. `better-sqlite3` compiles a native module on install.

## Ground rules

- **No custom cryptography.** All primitives come from libsodium through `packages/crypto`. Changes to the crypto core need tests covering round trips, tamper rejection, and wrong-key failure.
- **The server never sees plaintext.** Any new server endpoint must handle only ciphertext, wrapped keys, or structural metadata. Integration tests should assert this where practical.
- **Tests accompany features.** Crypto changes get unit tests; API changes get integration tests that exercise the real encryption path.
- **TypeScript strict mode** across the workspace; `pnpm build` must pass with no errors.

## Commit style

Conventional prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `deploy:`.

## Pull requests

Keep PRs focused on one change. Describe what the change does and how you verified it. CI must pass.
