import { readFileSync } from "node:fs";

export interface SkillSupervisionContract {
  schema: 1;
  route_command: string;
  automatic_owner_verbs: string[];
  human_stops: Array<{
    id: string;
    command_prefix: string;
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
        typeof stop.command_prefix === "string",
    )
  ) {
    throw new Error("skills/run/SKILL.md has an invalid loaf supervision contract");
  }
  return value as SkillSupervisionContract;
}

export function loadSkillSupervisionContract(skillPath: string): SkillSupervisionContract {
  return parseSkillSupervisionContract(readFileSync(skillPath, "utf8"));
}

export type SkillAdviceClassification =
  | { kind: "automatic" }
  | { kind: "human-stop"; id: string };

export function classifySkillAdvice(
  contract: SkillSupervisionContract,
  advice: { command: string; owner_verb: string },
): SkillAdviceClassification {
  const humanStop = contract.human_stops.find((stop) =>
    advice.command.startsWith(stop.command_prefix),
  );
  if (humanStop !== undefined) return { kind: "human-stop", id: humanStop.id };
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
