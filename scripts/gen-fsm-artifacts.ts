import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SubState } from "../src/core/journal-entry.js";
import { MACHINE, type MachineNode } from "../src/core/machine.js";
import { parseCheckMode, writeOrCheckGeneratedFile } from "./generated-file.js";
import { markdownCodeCell, replaceGeneratedBlock } from "./generated-markdown.js";

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

function codeList(values: readonly string[]): string {
  return values.length === 0 ? "—" : values.map(markdownCodeCell).join("<br>");
}

export function renderFsmSubstates(): string {
  const lines = [
    "| Sub-state | Entry condition | Exit condition | Logical write paths | Gate |",
    "|---|---|---|---|---|",
  ];
  for (const [subState, node] of machineEntries()) {
    lines.push(
      `| ${markdownCodeCell(subState)} | ${markdownCodeCell(node.entry)} | ${markdownCodeCell(node.exit)} | ${codeList(node.write_paths)} | ${node.gate === undefined ? "—" : markdownCodeCell(node.gate)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function transitionTable(
  edges: readonly (readonly [SubState, MachineNode["edges"][number]])[],
): string[] {
  const lines = ["| From | To | Owner kind | Guards |", "|---|---|---|---|"];
  for (const [source, edge] of edges) {
    lines.push(
      `| ${markdownCodeCell(source)} | ${markdownCodeCell(edge.target)} | ${markdownCodeCell(edge.owner_kind)} | ${codeList(edge.guards ?? [])} |`,
    );
  }
  return lines;
}

export function renderFsmTransitions(): string {
  const edges = machineEntries().flatMap(([source, node]) =>
    node.edges.map((edge) => [source, edge] as const),
  );
  const legal = edges.filter(([, edge]) => edge.owner_kind === "event:phase_advanced");
  const dedicated = edges.filter(
    ([, edge]) =>
      edge.owner_kind !== "event:phase_advanced" && edge.owner_kind !== "contract:next",
  );
  const hints = edges.filter(([, edge]) => edge.owner_kind === "contract:next");

  return `${[
    "#### Legal `event:phase_advanced` transitions",
    "",
    ...transitionTable(legal),
    "",
    "#### Dedicated-owner cursor transitions",
    "",
    ...transitionTable(dedicated),
    "",
    "#### Navigation hints (not legal transitions)",
    "",
    ...transitionTable(hints),
  ].join("\n")}\n`;
}

export function renderFsmMutationRights(): string {
  const lines = [
    "| Sub-state | Writable fields | Forbidden fields |",
    "|---|---|---|",
  ];
  for (const [subState, node] of machineEntries()) {
    if (!("mutation_rights" in node)) continue;
    lines.push(
      `| ${markdownCodeCell(subState)} | ${codeList(node.mutation_rights.writable_fields)} | ${codeList(node.mutation_rights.forbidden_fields)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Replace only the three generated FSM blocks in protocol.md. */
export function generateFsmProtocol(source: string): string {
  const withSubstates = replaceGeneratedBlock(source, "fsm-substates", renderFsmSubstates());
  const withTransitions = replaceGeneratedBlock(
    withSubstates,
    "fsm-transitions",
    renderFsmTransitions(),
  );
  return replaceGeneratedBlock(
    withTransitions,
    "fsm-mutation-rights",
    renderFsmMutationRights(),
  );
}

const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url);

if (isMain) {
  const check = parseCheckMode(process.argv.slice(2));
  const fsmUrl = new URL("../docs/fsm.mmd", import.meta.url);
  const protocolUrl = new URL("../docs/protocol.md", import.meta.url);
  const fsmDrifted = await writeOrCheckGeneratedFile(fsmUrl, () => generateFsmMermaid(), check);
  const protocolDrifted = await writeOrCheckGeneratedFile(
    protocolUrl,
    generateFsmProtocol,
    check,
  );
  if (check && (fsmDrifted || protocolDrifted)) process.exitCode = 1;
}
