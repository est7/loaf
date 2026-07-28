import { readFileSync } from "node:fs";

import {
  NextOwnerVerb as NextOwnerVerbSchema,
  type NextOwnerVerb,
} from "../../src/core/reducer/transition.js";

export interface SkillSupervisionContract {
  schema: 1;
  route_command: string;
  automatic_owner_verbs: NextOwnerVerb[];
  human_stops: Array<{
    id: string;
    command_prefix: string;
    owner_verb: NextOwnerVerb;
  }>;
}

const CONTRACT_PATTERN =
  /<!-- loaf-supervision-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- loaf-supervision-contract:end -->/;

export function parseSkillSupervisionContract(text: string): SkillSupervisionContract {
  const match = text.match(CONTRACT_PATTERN);
  if (match?.[1] === undefined) {
    throw new Error("skills/run/SKILL.md is missing the loaf supervision contract");
  }
  const value = JSON.parse(match[1]) as Partial<SkillSupervisionContract>;
  if (
    value.schema !== 1 ||
    typeof value.route_command !== "string" ||
    !Array.isArray(value.automatic_owner_verbs) ||
    !value.automatic_owner_verbs.every((verb) => typeof verb === "string") ||
    !Array.isArray(value.human_stops) ||
    !value.human_stops.every(
      (stop) =>
        typeof stop === "object" &&
        stop !== null &&
        typeof stop.id === "string" &&
        typeof stop.command_prefix === "string" &&
        typeof stop.owner_verb === "string",
    )
  ) {
    throw new Error("skills/run/SKILL.md has an invalid loaf supervision contract");
  }
  const contract = value as SkillSupervisionContract;
  const automatic = new Set(
    contract.automatic_owner_verbs.map((verb) => NextOwnerVerbSchema.parse(verb)),
  );
  const human = new Set(
    contract.human_stops.map((stop) => NextOwnerVerbSchema.parse(stop.owner_verb)),
  );
  const overlap = [...automatic].filter((verb) => human.has(verb));
  if (overlap.length > 0) {
    throw new Error(`skill supervision ownership overlaps: ${overlap.join(", ")}`);
  }
  const classified = new Set([...automatic, ...human]);
  const missing = NextOwnerVerbSchema.options.filter((verb) => !classified.has(verb));
  if (missing.length > 0) {
    throw new Error(`skill supervision ownership is incomplete: ${missing.join(", ")}`);
  }
  return contract;
}

export function loadSkillSupervisionContract(skillPath: string): SkillSupervisionContract {
  return parseSkillSupervisionContract(readFileSync(skillPath, "utf8"));
}

export type SkillAdviceClassification =
  | { kind: "automatic" }
  | { kind: "human-stop"; id: string };

export function classifySkillAdvice(
  contract: SkillSupervisionContract,
  advice: { command: string; owner_verb: NextOwnerVerb },
): SkillAdviceClassification {
  const humanStop = contract.human_stops.find((stop) =>
    advice.command.startsWith(stop.command_prefix),
  );
  if (humanStop !== undefined) {
    if (humanStop.owner_verb !== advice.owner_verb) {
      throw new Error(
        `skill supervision owner mismatch for ${humanStop.id}: expected ${humanStop.owner_verb}, got ${advice.owner_verb}`,
      );
    }
    return { kind: "human-stop", id: humanStop.id };
  }
  if (contract.automatic_owner_verbs.includes(advice.owner_verb)) {
    return { kind: "automatic" };
  }
  throw new Error(
    `skill supervision contract does not classify ${advice.owner_verb}: ${advice.command}`,
  );
}

export function loafCommandArgs(command: string, featureDir: string): string[] {
  const suffix = ` --feature-dir ${featureDir}`;
  if (!command.startsWith("loaf ") || !command.endsWith(suffix)) {
    throw new Error(`cannot execute non-canonical loaf advice: ${command}`);
  }
  return command.slice("loaf ".length, -suffix.length).split(" ");
}
