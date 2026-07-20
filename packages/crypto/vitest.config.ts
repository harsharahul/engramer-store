import { defineConfig } from "vitest/config";

// Argon2id at sensitive parameters is deliberately slow; give tests room.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
