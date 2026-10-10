import { diagnostic } from "../../src/core/error-catalog.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createCommandContext } from "../../src/cli/command-context.js";
import { createCommandMutator } from "../../src/cli/command-mutator.js";
import { createI18n, BUILTIN_BUNDLES } from "../../src/cli/i18n.js";
import { initialSnapshot } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";

describe("failure outlet extraction baseline", () => {
  test("core mutation diagnostics preserve their envelope", async () => {
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

  test("mutation outlet preserves gate failure details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-c3-gate-"));
    try {
      const snapshot = initialSnapshot();
      snapshot.state = {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "probe",
        phase: "SPEC",
        sub_state: "SPEC.design",
        iteration: 1,
        spec_locked: false,
        verify_accepted: false,
        spec_version: 1,
        ceremony: {
          spec_phase: true,
          verify_phase: true,
          settle_phase: false,
          strict_spec_review: false,
          lessons_required: "skip",
          strict_drift_check: false,
        },
      };
      const stderr: string[] = [];
      const ctx = createCommandContext(
        ["node", "loaf", "gate", "decide", "spec-lock", "--format=json"],
        {
          writeStdout: () => {},
          writeStderr: (line) => stderr.push(line),
        },
      );
      const result = await createCommandMutator(ctx, { registryWriter: undefined }).run(
        dir,
        { feature_dir: dir, snapshot, entries: [], tail_seq: -1, meta: emptyMeta() },
        {
          kind: "gate:decided",
          actor: "human:reviewer",
          payload: { gate_kind: "spec-lock", decision: "approved", reason: "reviewed gate" },
        },
      );
      expect(result).toBeNull();
      expect(ctx.exitCode).toBe(2);
      expect(JSON.parse(stderr.join(""))).toMatchObject({
        code: "GATE_PRECONDITION_VIOLATION",
        detail: {
          gate: "spec-lock",
          failure_count: 1,
          checks: [
            {
              check: 1,
              code: "SPEC_FRONTMATTER_INVALID",
              detail: { subcode: "SPEC_NOT_FOUND", path: path.join(dir, "spec.md") },
            },
          ],
        },
      });
      await expect(fs.stat(path.join(dir, "journal.jsonl"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("text failures use existing zh templates and catalog fix lines", () => {
    const stderr: string[] = [];
    const ctx = createCommandContext(["node", "loaf", "advance"], {
      i18n: createI18n("zh", BUILTIN_BUNDLES),
      writeStdout: () => {},
      writeStderr: (s) => {
        stderr.push(s);
      },
    });
    ctx.failure(diagnostic("TASK_DEP_SELF", { task_id: "T-A" }));
    expect(stderr).toEqual([
      "error: TASK_DEP_SELF — task T-A 不能依赖自身\n  fix: remove the self-reference from depends_on, then retry the task graph mutation\n  see: protocol.md#§10.8\n",
    ]);
    expect(ctx.exitCode).toBe(2);
  });
});
