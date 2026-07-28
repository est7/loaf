import { z } from "zod";

import { EvidenceAddInputBatched } from "../core/evidence-schema.js";
import { SpecAddReqInput, SpecAddScenarioInput, SpecAddVisualInput } from "../core/spec-schema.js";
import { TaskAuthoringInputBatched, TasksSubmitInput } from "../core/task-schema.js";

// Compatibility names for the CLI input-schema vocabulary. The underlying
// values are the exact runtime schemas used by the mutation paths.
export const SpecReqInput = SpecAddReqInput;
export type SpecReqInput = z.infer<typeof SpecReqInput>;

export const SpecScenarioInput = SpecAddScenarioInput;
export type SpecScenarioInput = z.infer<typeof SpecScenarioInput>;

export const SpecVisualInput = SpecAddVisualInput;
export type SpecVisualInput = z.infer<typeof SpecVisualInput>;

// SpecAdd*Input already accepts a single item or a non-empty array.
export const SpecReqInputBatched = SpecAddReqInput;
export const SpecScenarioInputBatched = SpecAddScenarioInput;
export const SpecVisualInputBatched = SpecAddVisualInput;

export const MutatorCommand = z.enum([
  "spec:add-req",
  "spec:add-scenario",
  "spec:add-visual",
  "tasks:submit",
  "tasks:add",
  "evidence:add",
]);
export type MutatorCommand = z.infer<typeof MutatorCommand>;

/** The exact schemas parsed by schema-emitting mutation paths. */
export const INPUT_SCHEMAS: Record<MutatorCommand, z.ZodTypeAny> = {
  "spec:add-req": SpecReqInputBatched,
  "spec:add-scenario": SpecScenarioInputBatched,
  "spec:add-visual": SpecVisualInputBatched,
  "tasks:submit": TasksSubmitInput,
  "tasks:add": TaskAuthoringInputBatched,
  "evidence:add": EvidenceAddInputBatched,
} as const;
