import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SubState } from "../src/core/journal-entry.js";
import { MACHINE, type MachineNode } from "../src/core/machine.js";

type MachineEntry = readonly [SubState, MachineNode];

function machineEntries(): MachineEntry[] {
  return (Object.keys(MACHINE) as SubState[]).map(
    (subState) => [subState, MACHINE[subState]] as const,
  );
}

function phaseOf(subState: SubState): string {
  return subState.slice(0, subState.indexOf("."));
}

function stateLabel(subState: SubState): string {
  return subState.slice(subState.indexOf(".") + 1);
}

function stateId(subState: SubState): string {
  return subState.replace(".", "_");
}

function edgeLabel(edge: MachineNode["edges"][number]): string | undefined {
  if (edge.owner_kind === "contract:next") return undefined;
  if (edge.owner_kind !== "event:phase_advanced") return edge.owner_kind;
  return edge.guards?.length ? edge.guards.join(" && ") : undefined;
}

/** Deterministic Mermaid projection of transition-owning MACHINE edges. */
export function generateFsmMermaid(): string {
  const entries = machineEntries();
  const statesByPhase = new Map<string, SubState[]>();

  for (const [subState] of entries) {
    const phase = phaseOf(subState);
    const states = statesByPhase.get(phase);
    if (states === undefined) statesByPhase.set(phase, [subState]);
    else states.push(subState);
  }

  const lines = ["stateDiagram-v2"];
  for (const [phase, states] of statesByPhase) {
    lines.push("", `  state ${phase} {`);
    for (const subState of states) {
      lines.push(`    state "${stateLabel(subState)}" as ${stateId(subState)}`);
    }
    lines.push("  }");
  }

  lines.push("");
  for (const [source, node] of entries) {
    for (const edge of node.edges) {
      if (edge.owner_kind === "contract:next") continue;
      const label = edgeLabel(edge);
      lines.push(
        `  ${stateId(source)} --> ${stateId(edge.target)}${label === undefined ? "" : ` : ${label}`}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

const outputUrl = new URL("../docs/fsm.mmd", import.meta.url);
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  await writeFile(outputUrl, generateFsmMermaid(), "utf8");
}
