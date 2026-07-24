import { defineConfig } from "vitest/config";

// The integration test logs into a real server, which runs Argon2id.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
