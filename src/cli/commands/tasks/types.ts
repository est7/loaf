import type { CommandContext } from "../../command-context.js";
import type { CommandMutator } from "../../command-mutator.js";
import type { JsonInputIngestor } from "../../input-ingestion.js";

export type TasksRegistrationDeps = {
  ctx: CommandContext;
  mutator: CommandMutator;
  actor: string;
  input: JsonInputIngestor;
};
