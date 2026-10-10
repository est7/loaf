import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createCommandContext } from "../../src/cli/command-context.js";
import { createCommandMutator, type FailureRoute } from "../../src/cli/command-mutator.js";
import { createI18n, BUILTIN_BUNDLES } from "../../src/cli/i18n.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";

describe("failure outlet extraction baseline", () => {
  test.each([
    "emit-failure",
    "legacy-fail",
    "raw-ctx-failure",
  ] as const)("%s preserves the migrated core diagnostic through every intermediate route", async (route: FailureRoute) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-c3-route-"));
    try {
      const snapshot = initialSnapshot();
      snapshot.state = {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "probe",
        phase: "TRIAGE",
        sub_state: "TRIAGE.score",
        iteration: 1,
        spec_locked: false,
        verify_accepted: false,
        spec_version: 0,
        ceremony: {
          spec_phase: false,
          verify_phase: false,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "skip",
          strict_drift_check: false,
        },
      };
      const stdout: string[] = [];
      const stderr: string[] = [];
      const ctx = createCommandContext(
        ["node", "loaf", "advance", "EXECUTE.done", "--format=json"],
        {
          i18n: createI18n("zh", BUILTIN_BUNDLES),
          writeStdout: (s) => {
            stdout.push(s);
          },
          writeStderr: (s) => {
            stderr.push(s);
          },
        },
      );
      const mutator = createCommandMutator(ctx, { registryWriter: undefined });
      const result = await mutator.run(
        dir,
        { feature_dir: dir, snapshot, entries: [], tail_seq: -1, meta: emptyMeta() },
        {
          kind: "event:phase_advanced",
          actor: "cli:loaf",
          payload: { from: "TRIAGE.score", to: "EXECUTE.done" },
        },
        route,
      );
      expect(result).toBeNull();
      expect(ctx.exitCode).toBe(2);
      expect(stdout).toEqual([]);
      const envelope = {
        ok: false,
        code: "TRANSITION_ILLEGAL",
        message: "cannot transition TRIAGE.score → EXECUTE.done",
      };
      expect(stderr).toEqual([
        JSON.stringify({
          ...envelope,
          detail: {
            from: "TRIAGE.score",
            to: "EXECUTE.done",
            allowed_forward: ["TRIAGE.confirm"],
          },
        }) + "\n",
      ]);
      await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("raw text failures currently bypass available zh templates and fix lines", () => {
    const stderr: string[] = [];
    const ctx = createCommandContext(["node", "loaf", "advance"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStdout: () => {},
      writeStderr: (s) => {
        stderr.push(s);
      },
    });
    ctx.failure("TASK_DEP_SELF", "task T-A cannot depend on itself", { task_id: "T-A" });
    expect(stderr).toEqual(["error: TASK_DEP_SELF — task T-A cannot depend on itself\n"]);
    expect(ctx.exitCode).toBe(2);
  });
});
