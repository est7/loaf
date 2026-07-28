import type { I18n } from "./i18n.js";
import { SUCCESS_KEYS } from "./runtime-i18n-keys.js";
import {
  buildNextOutput,
  type BuildNextOutputInput,
  type NextOutput,
} from "../core/next-action.js";
import { PendingPromptKind } from "../core/journal-entry.js";
import type { Snapshot } from "../core/reducer.js";
import type { DispatchOk } from "../core/session-dispatch.js";
import type { CommandContext } from "./command-context.js";

export type NextAdvisorySelector = {
  kind: "session" | "feature" | "feature-dir";
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

export function appendSelector(command: string, selector: NextAdvisorySelector): string {
  return `${command} --${selector.kind} ${shellQuote(selector.value)}`;
}

export function selectorForFeature(
  feature: string,
  featureDir: string,
  explicitFeatureDir: boolean,
): NextAdvisorySelector {
  return explicitFeatureDir
    ? { kind: "feature-dir", value: featureDir }
    : { kind: "feature", value: feature };
}

function argvHasFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function selectorForDispatch(
  dispatch: DispatchOk,
  argv: readonly string[],
): NextAdvisorySelector {
  if (dispatch.source === "session-flag" || dispatch.source === "session-env") {
    if (dispatch.sessionId === null) {
      throw new Error(`session dispatch source ${dispatch.source} has no canonical session id`);
    }
    return { kind: "session", value: dispatch.sessionId };
  }
  return selectorForFeature(
    dispatch.feature,
    dispatch.featureDir,
    argvHasFlag(argv, "--feature-dir"),
  );
}

export async function selectorForCommandContext(
  ctx: CommandContext,
): Promise<NextAdvisorySelector> {
  const dispatch = await ctx.resolveDispatch();
  if (!dispatch.ok) {
    throw new Error(`next advisory requested after failed dispatch: ${dispatch.code}`);
  }
  return selectorForDispatch(dispatch, ctx.argv);
}

export function buildScopedNextOutput(
  input: BuildNextOutputInput,
  selector: NextAdvisorySelector,
): NextOutput {
  const output = buildNextOutput(input);
  if (output.next_action === undefined) return output;
  return {
    ...output,
    next_action: {
      ...output.next_action,
      command: appendSelector(output.next_action.command, selector),
    },
  };
}

export function nextInputFromSnapshot(
  snapshot: Snapshot,
  featureDir: string,
): BuildNextOutputInput | null {
  const state = snapshot.state;
  if (state === null) return null;
  return {
    feature: state.feature,
    feature_dir: featureDir,
    phase: state.phase,
    sub_state: state.sub_state,
    ceremony: state.ceremony,
    spec_locked: state.spec_locked,
    verify_accepted: state.verify_accepted,
    pending: pendingKindsForNext(snapshot.pending),
  };
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
  const output = buildScopedNextOutput(input, selector);
  if (output.next_action === undefined) return undefined;

  if (!output.next_action.blocking) {
    return output.next_action.command;
  }

  const command = `${appendSelector("loaf next", selector)} --format json`;
  return i18n.t(SUCCESS_KEYS.nextFullCommandPointer, { command });
}

export function buildNextAdvisoryFromSnapshot(
  i18n: I18n,
  snapshot: Snapshot,
  featureDir: string,
  selector: NextAdvisorySelector,
): string | undefined {
  const input = nextInputFromSnapshot(snapshot, featureDir);
  return input === null ? undefined : buildNextAdvisory(i18n, input, selector);
}

export function nextCommandFromSnapshot(
  snapshot: Snapshot,
  featureDir: string,
  selector: NextAdvisorySelector,
): string | undefined {
  const input = nextInputFromSnapshot(snapshot, featureDir);
  if (input === null) return undefined;
  return buildScopedNextOutput(input, selector).next_action?.command;
}
