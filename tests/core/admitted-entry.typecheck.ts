// Compiler-only contract: payload types must remain correlated with entry.kind.
import { expectTypeOf } from "vitest";
import type { AdmittedEntry } from "../../src/core/admitted-entry.js";
import type { PER_KIND_PAYLOAD } from "../../src/core/kind-registry.js";
import type { z } from "zod";

export function verifyAdmittedEntryTypes(entry: AdmittedEntry): void {
  if (entry.kind === "event:tasks_planned") {
    expectTypeOf(entry.payload).toEqualTypeOf<
      z.output<(typeof PER_KIND_PAYLOAD)["event:tasks_planned"]>
    >();
    expectTypeOf(entry.payload.tasks[0]!.depends_on).toEqualTypeOf<string[]>();
    // @ts-expect-error A planned-task payload cannot be used as a pending ID.
    const pendingId: string = entry.payload.id;
    void pendingId;
  }
  if (entry.kind === "pending:resolved") {
    expectTypeOf(entry.payload.id).toEqualTypeOf<string>();
    // @ts-expect-error Payload correlation forbids substituting pending data for a task graph.
    const graph: Extract<AdmittedEntry, { kind: "event:tasks_planned" }> = entry;
    void graph;
  }
  if (entry.kind === "event:spec_req_added") {
    expectTypeOf(entry.payload.req.measurable!.direction).toEqualTypeOf<"lte" | "gte" | "eq">();
  }
}
