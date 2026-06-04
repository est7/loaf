import type { JournalEntry } from "../core/journal-entry.js";

// L1/L9 — the unstamped entry shape that `runMutator` accepts and the named
// batch builders (batch-builders.ts) return. runMutator owns `at` +
// entry_schema_version stamping, so callers and builders never carry them.
// Defined from JournalEntry (not from the mutate partial) so the contract
// boundary is a named type, distinct from buildSpecSubmitBatch's pre-stamped
// `Parameters<typeof mutateBatch>[0]` contract.
export type MutatorEntry = Pick<JournalEntry, "kind" | "payload" | "actor">;
