import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createCommandContext } from "../../src/cli/command-context.js";
import { createCommandMutator } from "../../src/cli/command-mutator.js";
import type { MutatorEntry } from "../../src/cli/mutator-entry.js";
import { loadSession } from "../../src/core/cli-runtime.js";
import { ENTRY_SCHEMA_VERSIONS } from "../../src/core/kind-registry.js";

// Sentinel versions distinguish owner lookup from a literal stamp. Use the
// real mutator pipeline and inspect the persisted journal, then restore state.
test.each([
  "single",
  "shared",
  "per-entry",
  "planned",
] as const)("%s command writer stamps each kind from the version owner", async (route) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-entry-version-"));
  const versions = ENTRY_SCHEMA_VERSIONS;
  const originals = [versions["session:started"], versions["pending:added"]];
  versions["session:started"] = 7;
  versions["pending:added"] = 8;
  try {
    const stderr: string[] = [];
    const ctx = createCommandContext(["loaf", "--format", "json"], {
      writeStdout: () => {},
      writeStderr: (text) => {
        stderr.push(text);
      },
    });
    const mutator = createCommandMutator(ctx, { registryWriter: undefined });
    const session = await loadSession(dir);
    const entries: MutatorEntry[] = [
      {
        kind: "session:started",
        actor: "cli:loaf",
        payload: {
          ceremony_label: "standard",
          workspace: "default",
          loaf_version_required: "^0.8.0",
          session_id: "550e8400-e29b-41d4-a716-446655440000",
          feature: "version-owner",
          ceremony: {
            spec_phase: true,
            verify_phase: true,
            settle_phase: false,
            strict_spec_review: false,
            lessons_required: "skip",
            strict_drift_check: false,
          },
        },
      },
      {
        kind: "pending:added",
        actor: "human:tester",
        payload: {
          id: "PEND-0001",
          kind: "ask_user_question",
          question: "Which option?",
        },
      },
    ];
    const result =
      route === "single"
        ? await mutator.run(dir, session, entries[0]!)
        : route === "shared"
          ? await mutator.run(dir, session, entries)
          : route === "per-entry"
            ? await mutator.runBatch(dir, session, entries, { timestamps: "per-entry" })
            : await mutator.runPlannedBatch(dir, session, () => ({ ok: true, entries }));
    expect(result, stderr.join("")).not.toBeNull();
    const journal = (await fs.readFile(path.join(dir, "journal.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(journal.map((entry) => [entry.kind, entry.entry_schema_version])).toEqual(
      route === "single"
        ? [["session:started", 7]]
        : [
            ["session:started", 7],
            ["pending:added", 8],
          ],
    );
  } finally {
    versions["session:started"] = originals[0]!;
    versions["pending:added"] = originals[1]!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
