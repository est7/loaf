// In-process admission contract. Journal persistence retains the raw candidate.
import type { z } from "zod";
import type { EntryKind, JournalEntry } from "./journal-entry.js";
import type { PayloadSchemas } from "./kind-registry.js";

export type AdmittedEntry = {
  [K in EntryKind]: Omit<JournalEntry, "kind" | "payload"> & {
    kind: K;
    payload: z.output<PayloadSchemas[K]>;
  };
}[EntryKind];
