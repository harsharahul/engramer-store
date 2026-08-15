# Test fixtures

Every file here is a deterministic, regenerable test vector produced by
`apps/desktop/scripts/egc1-fixture.mjs`. In particular, `egc1-fixture.key`
is not a credential: it is the fixed byte ramp `key[i] = (i * 13 + 5) % 256`,
committed so the Rust and TypeScript crypto cores can prove byte-for-byte
agreement on the same input. CI regenerates the vectors and fails if the
committed copies drift.
