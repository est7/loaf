import { declareCommandPolicy } from "../command-policy.js";
import type { Command } from "commander";
import { ARTIFACT_SCHEMA_KINDS, type ArtifactSchemaKind } from "../schema-emit.js";

export function registerState(
  program: Command,
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
  // Registered action policy owns dry-run rejection and schema output.
  const stateCmd = program.command("state").description("Session state schema dump (SC-10)");

  const ARTIFACT_PARENTS: Record<ArtifactSchemaKind, ReturnType<typeof program.command>> = {
    spec: specCmd,
    tasks: tasksCmd,
    evidence: evidenceCmd,
    finding: findingCmd,
    state: stateCmd,
  };
  for (const kind of ARTIFACT_SCHEMA_KINDS) {
    declareCommandPolicy(
      ARTIFACT_PARENTS[kind]
        .command("schema")
        .description(`Dump the ${kind} artifact JSON Schema (Phase 16 SC-10; read-only)`),
      { selectors: "forbidden", dryRun: "read-only", schema: { kind: "artifact", key: kind } },
    ).action(() => {
      // no-feature — registered action policy emits the schema before this body.
    });
  }
}
