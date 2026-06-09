import type { Command } from "commander";
import type { CommandContext } from "../command-context.js";
import {
  ARTIFACT_SCHEMA_KINDS,
  emitArtifactSchema,
  formatSchema,
  type ArtifactSchemaKind,
} from "../schema-emit.js";

export function registerState(
  program: Command,
  ctx: CommandContext,
  specCmd: Command,
  tasksCmd: Command,
  evidenceCmd: Command,
  findingCmd: Command,
): void {
  // ── Phase 16 SC-10 — `loaf <kind> schema` artifact subs ──────────────
  //
  // 5 closed-enum kinds per protocol §1947 (excludes pending):
  //   spec / tasks / evidence / finding / state
  //
  // 4 attach under existing parents (specCmd / tasksCmd / evidenceCmd /
  // findingCmd); `state` is a NEW top-level parent (no other v0.1.0
  // state subs). Feature-agnostic — pre-parse guard already rejected
  // --feature / --feature-dir / --session / $LOAF_*. Read-only —
  // `--dry-run` rejected via ctx.rejectIfDryRun(<label>).
  const stateCmd = program.command("state").description("Session state schema dump (SC-10)");

  const ARTIFACT_PARENTS: Record<ArtifactSchemaKind, ReturnType<typeof program.command>> = {
    spec: specCmd,
    tasks: tasksCmd,
    evidence: evidenceCmd,
    finding: findingCmd,
    state: stateCmd,
  };
  for (const kind of ARTIFACT_SCHEMA_KINDS) {
    ARTIFACT_PARENTS[kind]
      .command("schema")
      .description(`Dump the ${kind} artifact JSON Schema (Phase 16 SC-10; read-only)`)
      .action(async () => {
        // no-feature — schema dump is feature-agnostic. Literal label
        // per kind so the SC-6c static guard finds ctx.rejectIfDryRun("<kind> schema").
        let rejected = false;
        if (kind === "spec") rejected = ctx.rejectIfDryRun("spec schema");
        else if (kind === "tasks") rejected = ctx.rejectIfDryRun("tasks schema");
        else if (kind === "evidence") rejected = ctx.rejectIfDryRun("evidence schema");
        else if (kind === "finding") rejected = ctx.rejectIfDryRun("finding schema");
        else rejected = ctx.rejectIfDryRun("state schema");
        if (rejected) return;
        const schema = emitArtifactSchema(kind) as Record<string, unknown>;
        ctx.success(schema, () => formatSchema(schema));
      });
  }
}
