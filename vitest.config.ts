import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Phase 16 SC-7: isolate the default registry writer from real
    // `~/.loaf/registry/` for the entire test suite. Sets
    // process.env.LOAF_REGISTRY_DIR to a tmp dir; defaultRegistryDir()
    // honors it. Per-call DI overrides still work for tests that need
    // them.
    setupFiles: ["tests/setup-registry-isolation.ts"],
    // Many integration tests (tests/core/cli.test.ts alone has ~250 `runCli`
    // calls; tasks-input-modality, etc.) spawn a real Node CLI subprocess per
    // case. Under full file-parallelism the default 5000ms tips a handful over
    // on CPU contention — they pass in isolation / sequential runs, so it is a
    // scheduling artifact, not a logic issue. 20s gives subprocess integration
    // tests headroom while still catching genuine hangs.
    testTimeout: 20000,
  },
});
