// Phase 16 SC-10 — JSON Schema emitters.
//
// Two distinct surfaces (codex r316 lock):
//
//   A. Mutator input schema via `--schema` modifier on 5 batch-capable
//      mutators (spec add-req / spec add-scenario / spec add-visual /
//      tasks add / evidence add). Source: the runtime-owned INPUT_SCHEMAS
//      table in input-schemas.ts. Each entry accepts `T | nonempty T[]` so the
//      emitted JSON Schema has root `anyOf`.
//
//   B. Artifact projection schema via literal `<kind> schema` subcommand
//      (5 kinds: spec / tasks / evidence / finding / state). Source:
//      SpecFrontmatter + 4 projection schemas. Roots have `type: object`
//      and `properties`. `pending` is intentionally excluded — internal
//      projection only, no external consumer use case (the protocol
//      §1947 closed enum locks 5, not 6).
//
// Output: pretty-printed JSON Schema document via Zod v4 built-in
// `z.toJSONSchema(schema, { target: "draft-2020-12" })`. No `$id`
// (URI namespace = separate design decision). No external dependency.

import { z } from "zod";

import { INPUT_SCHEMAS, type MutatorCommand } from "./input-schemas.js";
import { SpecFrontmatter } from "../core/spec-schema.js";
import {
  EvidenceJson,
  FindingsJson,
  StateProjection,
  TasksJson,
} from "../core/projection-schema.js";

/** External CLI artifact-kind names exposed by `<kind> schema` subs.
 *  Closed enum per protocol §1947 (excludes `pending`). */
export type ArtifactSchemaKind = "spec" | "tasks" | "evidence" | "finding" | "state";

export const ARTIFACT_SCHEMA_KINDS: ReadonlyArray<ArtifactSchemaKind> = [
  "spec",
  "tasks",
  "evidence",
  "finding",
  "state",
] as const;

/** Artifact kind → Zod schema. `finding` (singular CLI noun) maps to
 *  `FindingsJson` (plural file name) — same singular/plural mismatch as
 *  SC-9c check. */
const ARTIFACT_SCHEMAS: Record<ArtifactSchemaKind, z.ZodTypeAny> = {
  spec: SpecFrontmatter,
  tasks: TasksJson,
  evidence: EvidenceJson,
  finding: FindingsJson,
  state: StateProjection,
};

/** Emit JSON Schema for one of the 5 batch-capable mutators. */
export function emitInputSchema(commandKey: MutatorCommand): unknown {
  return z.toJSONSchema(INPUT_SCHEMAS[commandKey], { target: "draft-2020-12" });
}

/** Emit JSON Schema for one of the 5 artifact projection kinds. */
export function emitArtifactSchema(kind: ArtifactSchemaKind): unknown {
  return z.toJSONSchema(ARTIFACT_SCHEMAS[kind], { target: "draft-2020-12" });
}

/** Pretty-print a JSON Schema document for stdout. */
export function formatSchema(schema: unknown): string {
  return JSON.stringify(schema, null, 2) + "\n";
}
