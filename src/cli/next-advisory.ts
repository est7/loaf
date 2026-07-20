import type { I18n } from "./i18n.js";
import { SUCCESS_KEYS } from "./runtime-i18n-keys.js";
import { buildNextOutput, type BuildNextOutputInput } from "../core/next-action.js";
import { PendingPromptKind } from "../core/journal-entry.js";

export type NextAdvisorySelector = {
  kind: "feature" | "feature-dir";
  value: string;
};

export function pendingKindsForNext(
  pending: readonly { kind: string }[],
): BuildNextOutputInput["pending"] {
  return pending.map(({ kind }) => ({ kind: PendingPromptKind.parse(kind) }));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function appendSelector(command: string, selector: NextAdvisorySelector): string {
  return `${command} --${selector.kind} ${shellQuote(selector.value)}`;
}

/**
 * Render a copy-pasteable next hint without owning workflow routing.
 * `buildNextOutput` remains the sole routing authority. Blocking actions may
 * require human-provided arguments, so those point to the scoped JSON query
 * instead of advertising an unsafe placeholder command as runnable.
 */
export function buildNextAdvisory(
  i18n: I18n,
  input: BuildNextOutputInput,
  selector: NextAdvisorySelector,
): string | undefined {
  const output = buildNextOutput(input);
  if (output.next_action === undefined) return undefined;

  if (!output.next_action.blocking) {
    return appendSelector(output.next_action.command, selector);
  }

  const command = `${appendSelector("loaf next", selector)} --format json`;
  return i18n.t(SUCCESS_KEYS.nextFullCommandPointer, { command });
}
