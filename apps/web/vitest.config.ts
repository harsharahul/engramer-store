import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Argon2id is deliberately slow; give tests room, like the other packages.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);
