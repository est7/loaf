import type { Command } from "commander";

import type { CommandContext } from "../command-context.js";
import type { CommandMutator } from "../command-mutator.js";
import type { JsonInputIngestor } from "../input-ingestion.js";
import { registerTaskAdd, registerTaskAmend, registerTaskSubmit } from "./tasks/authoring.js";
import {
  registerTaskAbandon,
  registerTaskClaim,
  registerTaskComplete,
  registerTaskRegisterRed,
  registerTaskStep,
} from "./tasks/execution.js";
import { registerTaskQueries } from "./tasks/query.js";
import type { TasksRegistrationDeps } from "./tasks/types.js";

/** Register the loaf tasks family without changing its public facade or command order. */
export function registerTasks(
  program: Command,
  ctx: CommandContext,
  mutator: CommandMutator,
  actor: string,
  input: JsonInputIngestor,
): { tasksCmd: Command } {
  const tasksCmd = program
    .command("tasks")
    .description("Task lifecycle commands (Slice 2 MVP: submit / claim / step)");
  const deps: TasksRegistrationDeps = {
    ctx,
    mutator,
    actor,
    input,
  };

  // Commander help and resolution depend on this exact registration order.
  registerTaskSubmit(tasksCmd, deps);
  registerTaskAdd(tasksCmd, deps);
  registerTaskClaim(tasksCmd, deps);
  registerTaskAbandon(tasksCmd, deps);
  registerTaskQueries(tasksCmd, deps);
  registerTaskComplete(tasksCmd, deps);
  registerTaskAmend(tasksCmd, deps);
  registerTaskRegisterRed(tasksCmd, deps);
  registerTaskStep(tasksCmd, deps);

  return { tasksCmd };
}
