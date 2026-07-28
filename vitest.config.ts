import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Keep discovery rooted in this checkout. Agent-managed worktrees may live
    // below `.claude/worktrees/`; the default Vitest glob would otherwise run
    // their suites as duplicate projects and make the root result depend on
    // ambient workspace state.
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    maxWorkers: "50%",
    // Isolate user config and the default registry writer from the real
    // `~/.loaf/` tree. Per-call DI overrides still win in focused tests.
    setupFiles: ["tests/setup-environment-isolation.ts"],
    // Many integration tests (tests/core/cli.test.ts alone has ~250 `runCli`
    // calls; tasks-input-modality, etc.) spawn a real Node CLI subprocess per
    // case. Under full file-parallelism the default 5000ms tips a handful over
    // on CPU contention — they pass in isolation / sequential runs, so it is a
    // scheduling artifact, not a logic issue. 20s gives subprocess integration
    // tests headroom while still catching genuine hangs.
    testTimeout: 20000,
  },
});
