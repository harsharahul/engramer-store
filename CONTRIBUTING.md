# Contributing to Engram Store

Thanks for your interest. This is a security-critical project with a small,
deliberately focused surface; contributions that keep it that way are very
welcome.

## Principles

- **No custom cryptography.** Every primitive comes from libsodium through
  `packages/crypto`. Changes to the crypto core land with tests covering round
  trips, tamper rejection, and wrong-key failure.
- **The server never sees plaintext.** Any new endpoint handles only
  ciphertext, wrapped keys, or structural metadata. Derived data such as
  categories, tags, and search text belongs inside the encrypted metadata blob,
  never in a server column. Assert this in tests where practical.
- **Intelligence runs on the client.** Extraction, categorization, and search
  happen on the user's device. A feature that requires the server to read
  content does not belong here.
- **Every change lands with tests.** The suite runs in well under a minute;
  there is no excuse to skip it. New behavior gets a test that fails before the
  change and passes after.

## Development

```bash
pnpm install
pnpm build                            # typecheck every package, build the client
pnpm test                             # crypto, web, and server suites
pnpm --filter @engramer/server dev    # API with reload on port 3080
pnpm --filter @engramer/web dev       # Vite dev server on 5173, proxying /api
```

Docker:

```bash
docker build -t engramer-store .
docker run --rm -p 3080:3080 -v engramer-data:/data engramer-store
```

The repository is a pnpm workspace:

```
packages/crypto/   E2EE core: key hierarchy, streaming encryption, sealed boxes
apps/server/       Zero-knowledge API: Fastify, SQLite metadata, on-disk blobs
apps/web/          Web client: React, all cryptography in the browser
```

When changing the client, remember the service worker caches the app shell: a
hard refresh clears a stale build during local testing.

## Submitting changes

1. Branch off `main`.
2. Make the change with tests; keep `pnpm build` and `pnpm test` green.
3. Match the surrounding style: TypeScript strict mode, comments that state
   constraints rather than narrate code, no emojis in code or docs.
4. Add a CHANGELOG entry under the unreleased version heading.
5. Open a pull request describing what changed and why. CI runs the Node 22 and
   24 matrix, a dependency audit, and a Docker image build with a health-check
   smoke test.

## Commit style

Conventional prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, `deploy:`.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
