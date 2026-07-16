// Runtime compatibility shim for the state-axis contracts. The canonical
// metadata and ordering live in machine.ts; Zod schemas stay here until the
// later schema-derivation stage.

import { SubState } from "./journal-entry.js";
import { SUB_STATE_CONTRACTS as MACHINE_CONTRACTS } from "./machine.js";
import { z } from "zod";

export const MutationRights = z.object({
  writable_fields: z.array(z.string()).default([]),
  forbidden_fields: z.array(z.string()).default([]),
});
export type MutationRights = z.infer<typeof MutationRights>;

export const SubStateContract = z.object({
  sub_state: SubState,
  entry: z.string(),
  exit: z.string(),
  write_paths: z.array(z.string()),
  mutation_rights: MutationRights.optional(),
  next: z.array(SubState),
  prompt_inject: z.string(),
});
export type SubStateContract = z.infer<typeof SubStateContract>;

export const SUB_STATE_CONTRACTS: SubStateContract[] = MACHINE_CONTRACTS;

/** sub_state → contract lookup (built once from the derived contract objects). */
export const SUB_STATE_CONTRACT_BY_STATE: Readonly<Record<string, SubStateContract>> =
  Object.fromEntries(SUB_STATE_CONTRACTS.map((contract) => [contract.sub_state, contract]));

/**
 * prompt_inject text for a sub_state. Returns `undefined` for an unknown
 * sub_state (caller decides: session-start treats unknown as no-context).
 * Terminal DONE.* states carry an empty-string prompt_inject by design.
 */
export function promptInjectFor(subState: string): string | undefined {
  return SUB_STATE_CONTRACT_BY_STATE[subState]?.prompt_inject;
}
