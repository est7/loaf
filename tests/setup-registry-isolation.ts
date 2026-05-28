// Phase 16 SC-7 — vitest global setup: isolate the registry writer
// from the real user `~/.loaf/registry/` for ALL test runs.
//
// Per codex r281: ~124 mutator call sites in tests/ don't (and shouldn't
// have to) inject a per-call registryWriter. Tests must not write to
// real `~/.loaf/registry/`. This setup file creates a per-process tmp
// dir and exports it via `LOAF_REGISTRY_DIR` env var. The runtime
// `defaultRegistryDir()` honors that env var, so every default registry
// write under tests lands in the tmp dir (which the OS cleans up).
//
// Tests that explicitly inject `registryDir` via DI continue to work
// — their per-call option wins over the env-var default. See
// tests/cli/registry-end-to-end.test.ts.
//
// Production users do NOT set LOAF_REGISTRY_DIR; they get the
// canonical `~/.loaf/registry/`.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpReg = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-vitest-reg-"));
process.env.LOAF_REGISTRY_DIR = tmpReg;
