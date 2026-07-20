import { defineConfig } from "vitest/config";

// Account setup runs real Argon2id; give tests room.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
