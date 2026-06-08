import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 10_000,
    maxWorkers: "50%",
    // Phase 16 SC-7: isolate the default registry writer from real
    // `~/.loaf/registry/` for the entire test suite. Sets
    // process.env.LOAF_REGISTRY_DIR to a tmp dir; defaultRegistryDir()
    // honors it. Per-call DI overrides still work for tests that need
    // them.
    setupFiles: ["tests/setup-registry-isolation.ts"],
  },
});
