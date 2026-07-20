import type { CommandContext } from "../../command-context.js";
import type { CommandMutator } from "../../command-mutator.js";

export type TasksRegistrationDeps = {
  ctx: CommandContext;
  mutator: CommandMutator;
  actor: string;
  isStdinTty: () => boolean;
  readStdin: () => Promise<string>;
};
