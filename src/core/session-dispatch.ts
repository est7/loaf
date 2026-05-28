// Phase 16 SC-8 — session dispatch resolver.
//
// Implements protocol §10.3 5-level precedence:
//   1. --session <UUID> flag        (registry lookup; cwd match; prefix ≥8)
//   2. --feature <name> flag        (state.json projection; canonical sessionId)
//   3. $LOAF_SESSION env            (same as #1)
//   4. $LOAF_FEATURE env            (same as #2)
//   5. Auto-pick cwd/.loaf/*        (require valid state.json projection)
//
// `--feature-dir <path>` semantics (codex r285 P1, locked):
//   - --feature / $LOAF_FEATURE + --feature-dir → override featureDir
//   - --session / $LOAF_SESSION + --feature-dir → USAGE (session identity
//     comes from registry; manual featureDir is contradictory)
//   - bare --feature-dir (no feature name) → USAGE (no feature to address)
//
// Auto-pick contract (codex r286 P5):
//   - NoSessionError (no journal / no entries) → silent skip (not a candidate)
//   - SnapshotStaleError → PROPAGATE as SNAPSHOT_STALE_REBUILD_REQUIRED
//     (do NOT silently skip — fail-fast per §13.1 reader contract)
//   - Successful load + phase === "DONE" → skip (terminal, not active)
//   - Successful load + phase !== "DONE" → active candidate
//   - Other errors → propagate (defensive; never silently swallow)
//
// Errors emitted (DiagnosticCode):
//   - FEATURE_NOT_FOUND, FEATURE_AMBIGUOUS, SESSION_CWD_MISMATCH,
//     SESSION_SHORT_AMBIGUOUS, SESSION_NOT_FOUND (Phase 16 SC-8 new),
//     SNAPSHOT_STALE_REBUILD_REQUIRED (passes through from loader),
//     USAGE (--feature-dir conflict cases).

import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultRegistryDir } from "./registry-writer.js";
import {
  loadProjections,
  NoSessionError,
  SnapshotStaleError,
} from "./projection-loader.js";
import { RegistryFile } from "./projection-schema.js";

const MIN_SHORT_UUID_PREFIX = 8;

export type DispatchSource =
  | "session-flag"
  | "feature-flag"
  | "session-env"
  | "feature-env"
  | "auto-pick";

export type DispatchOk = {
  ok: true;
  feature: string;
  featureDir: string;
  /** Canonical UUID from registry (session sources) or from
   *  state.json projection (feature sources / auto-pick). null only
   *  in edge cases (e.g. pre-session:started state, which shouldn't
   *  reach dispatch resolution anyway). */
  sessionId: string | null;
  source: DispatchSource;
  /** Auto-pick advisory line for stderr (e.g. "auto-picked 'auth-refresh'").
   *  null for non-auto-pick sources. Caller routes through ctx.advisory()
   *  which respects --quiet. */
  autoPickAdvisory: string | null;
};

export type DispatchFailCode =
  | "FEATURE_NOT_FOUND"
  | "FEATURE_AMBIGUOUS"
  | "SESSION_CWD_MISMATCH"
  | "SESSION_SHORT_AMBIGUOUS"
  | "SESSION_NOT_FOUND"
  | "SNAPSHOT_STALE_REBUILD_REQUIRED"
  | "USAGE";

export type DispatchFail = {
  ok: false;
  code: DispatchFailCode;
  message: string;
  detail: Record<string, unknown>;
};

export type DispatchResult = DispatchOk | DispatchFail;

export interface DispatchInput {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** Optional override; defaults to defaultRegistryDir() which honors
   *  LOAF_REGISTRY_DIR env (set by vitest setup file). */
  registryDir?: string;
}

/** Extract flag value (`--flag value` or `--flag=value`). Returns
 *  `undefined` when absent. */
function pickFlagValue(argv: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === flag) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) return v;
      return undefined;
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

export async function resolveDispatch(input: DispatchInput): Promise<DispatchResult> {
  const sessionFlag = pickFlagValue(input.argv, "--session");
  const featureFlag = pickFlagValue(input.argv, "--feature");
  const featureDirFlag = pickFlagValue(input.argv, "--feature-dir");
  const sessionEnv = input.env["LOAF_SESSION"];
  const featureEnv = input.env["LOAF_FEATURE"];

  // ── USAGE rejection: --session + --feature-dir ──
  if (sessionFlag !== undefined && featureDirFlag !== undefined) {
    return usageConflict(
      "--session and --feature-dir are mutually exclusive",
      ["--session", "--feature-dir"],
      "session identity comes from the registry; manual --feature-dir is contradictory",
    );
  }

  // Level 1: --session flag
  if (sessionFlag !== undefined) {
    return resolveBySessionId(sessionFlag, input, "session-flag");
  }

  // Level 2: --feature flag (with optional --feature-dir override)
  if (featureFlag !== undefined) {
    return resolveByFeatureName(featureFlag, input, "feature-flag", featureDirFlag);
  }

  // ── USAGE rejection: $LOAF_SESSION + --feature-dir ──
  if (sessionEnv !== undefined && featureDirFlag !== undefined) {
    return usageConflict(
      "$LOAF_SESSION and --feature-dir are mutually exclusive",
      ["$LOAF_SESSION", "--feature-dir"],
      "session identity comes from the registry; manual --feature-dir is contradictory",
    );
  }

  // Level 3: $LOAF_SESSION env
  if (sessionEnv !== undefined && sessionEnv.length > 0) {
    return resolveBySessionId(sessionEnv, input, "session-env");
  }

  // Level 4: $LOAF_FEATURE env (with optional --feature-dir override)
  if (featureEnv !== undefined && featureEnv.length > 0) {
    return resolveByFeatureName(featureEnv, input, "feature-env", featureDirFlag);
  }

  // ── USAGE rejection: bare --feature-dir (no feature name) ──
  if (featureDirFlag !== undefined) {
    return usageConflict(
      "--feature-dir requires --feature <name> or $LOAF_FEATURE to name the feature",
      ["--feature-dir"],
      "pass --feature <name> alongside --feature-dir, or set $LOAF_FEATURE",
    );
  }

  // Level 5: auto-pick
  return autoPickFromCwd(input);
}

function usageConflict(
  message: string,
  conflicting: readonly string[],
  fix: string,
): DispatchFail {
  return {
    ok: false,
    code: "USAGE",
    message: `${message}. ${fix}`,
    detail: { conflicting },
  };
}

async function resolveBySessionId(
  uuidOrPrefix: string,
  input: DispatchInput,
  source: "session-flag" | "session-env",
): Promise<DispatchResult> {
  // Validate prefix length per protocol §1586 (≥8 chars or full UUID).
  if (uuidOrPrefix.length < MIN_SHORT_UUID_PREFIX) {
    return {
      ok: false,
      code: "USAGE",
      message:
        `--session prefix '${uuidOrPrefix}' is too short ` +
        `(<${MIN_SHORT_UUID_PREFIX} chars). Pass ≥${MIN_SHORT_UUID_PREFIX} chars or the full UUID.`,
      detail: { uuid_or_prefix: uuidOrPrefix, min_length: MIN_SHORT_UUID_PREFIX, source },
    };
  }

  const registryDir = input.registryDir ?? defaultRegistryDir();
  let entries: string[];
  try {
    entries = await fs.readdir(registryDir);
  } catch {
    return {
      ok: false,
      code: "SESSION_NOT_FOUND",
      message: `--session ${uuidOrPrefix} matches no entry in the registry`,
      detail: { uuid_or_prefix: uuidOrPrefix, registry_dir: registryDir, source },
    };
  }

  // Collect matching JSON files. Prefix match on the basename (without .json).
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (id.startsWith(uuidOrPrefix)) matches.push(id);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      code: "SESSION_NOT_FOUND",
      message: `--session ${uuidOrPrefix} matches no entry in the registry`,
      detail: { uuid_or_prefix: uuidOrPrefix, registry_dir: registryDir, source },
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      code: "SESSION_SHORT_AMBIGUOUS",
      message:
        `--session ${uuidOrPrefix} matches ${matches.length} sessions in the registry: ` +
        matches.join(", "),
      detail: {
        prefix: uuidOrPrefix,
        match_count: matches.length,
        candidate_list: matches,
        source,
      },
    };
  }

  const sessionId = matches[0]!;
  // Read the registry file to validate cwd match.
  let registryFile: RegistryFile;
  try {
    const raw = await fs.readFile(path.join(registryDir, `${sessionId}.json`), "utf8");
    registryFile = RegistryFile.parse(JSON.parse(raw));
  } catch (err) {
    return {
      ok: false,
      code: "SESSION_NOT_FOUND",
      message:
        `--session ${uuidOrPrefix} registry entry exists but cannot be parsed: ${(err as Error).message}`,
      detail: { uuid_or_prefix: uuidOrPrefix, session_id: sessionId, source },
    };
  }

  // Canonicalize both paths before comparison — on macOS, /var/folders/
  // and /private/var/folders/ refer to the same dir but stringify
  // differently. Use fs.realpath to normalize. Fall back to literal
  // string compare if either path doesn't exist (e.g. dir deleted).
  let registeredCanonical = registryFile.cwd;
  let currentCanonical = input.cwd;
  try { registeredCanonical = await fs.realpath(registryFile.cwd); } catch { /* dir gone — keep literal */ }
  try { currentCanonical = await fs.realpath(input.cwd); } catch { /* keep literal */ }
  if (registeredCanonical !== currentCanonical) {
    return {
      ok: false,
      code: "SESSION_CWD_MISMATCH",
      message:
        `--session ${uuidOrPrefix} is registered against cwd=${registryFile.cwd}, ` +
        `but the current cwd is ${input.cwd}`,
      detail: {
        uuid: sessionId,
        registered_cwd: registryFile.cwd,
        current_cwd: input.cwd,
        source,
      },
    };
  }

  // cwd matches — featureDir = registered_cwd + .loaf/<feature>
  const featureDir = path.join(registryFile.cwd, ".loaf", registryFile.feature);
  return {
    ok: true,
    feature: registryFile.feature,
    featureDir,
    sessionId,
    source,
    autoPickAdvisory: null,
  };
}

async function resolveByFeatureName(
  name: string,
  input: DispatchInput,
  source: "feature-flag" | "feature-env",
  featureDirOverride: string | undefined,
): Promise<DispatchResult> {
  const featureDir = featureDirOverride ?? path.join(input.cwd, ".loaf", name);

  try {
    const projection = await loadProjections({
      feature_dir: featureDir,
      kinds: ["state"] as const,
    });
    return {
      ok: true,
      feature: name,
      featureDir,
      sessionId: projection.state.session_id ?? null,
      source,
      autoPickAdvisory: null,
    };
  } catch (err) {
    if (err instanceof NoSessionError) {
      return {
        ok: false,
        code: "FEATURE_NOT_FOUND",
        message: `feature '${name}' has no session at ${featureDir}`,
        detail: { feature: name, feature_dir: featureDir, source },
      };
    }
    if (err instanceof SnapshotStaleError) {
      // Preserve the loader's original detail (includes `fix`, `meta_path`,
      // etc.) so downstream consumers get the same shape as pre-SC-8
      // direct loader callers. Override with the dispatch source for trace.
      return {
        ok: false,
        code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
        message:
          `feature '${name}' projection is stale at ${featureDir} (reason: ${err.reason})`,
        detail: { ...err.detail, reason: err.reason, dispatch_source: source },
      };
    }
    throw err;
  }
}

async function autoPickFromCwd(input: DispatchInput): Promise<DispatchResult> {
  const loafDir = path.join(input.cwd, ".loaf");
  let candidates: string[];
  try {
    candidates = await fs.readdir(loafDir);
  } catch {
    return {
      ok: false,
      code: "FEATURE_NOT_FOUND",
      message: "no feature found in cwd (.loaf/ is empty or missing)",
      detail: { cwd: input.cwd },
    };
  }

  const active: Array<{ feature: string; featureDir: string; sessionId: string | null }> = [];

  for (const candidate of candidates) {
    const featureDir = path.join(loafDir, candidate);
    try {
      const projection = await loadProjections({
        feature_dir: featureDir,
        kinds: ["state"] as const,
      });
      if (projection.state.phase === "DONE") continue; // terminal — skip
      active.push({
        feature: candidate,
        featureDir,
        sessionId: projection.state.session_id ?? null,
      });
    } catch (err) {
      if (err instanceof NoSessionError) {
        // Silent skip — directory has no session (pre-start, deleted, etc.).
        continue;
      }
      if (err instanceof SnapshotStaleError) {
        // PROPAGATE — never silently skip a stale projection per
        // §13.1 reader contract.
        return {
          ok: false,
          code: "SNAPSHOT_STALE_REBUILD_REQUIRED",
          message:
            `auto-pick aborted: '${candidate}' projection is stale (reason: ${err.reason}). ` +
            `Run 'loaf doctor --rebuild --feature ${candidate}' to resync.`,
          detail: {
            feature: candidate,
            feature_dir: featureDir,
            dispatch_phase: "auto-pick",
            reason: err.reason,
          },
        };
      }
      // Unknown — propagate to the unexpected-error boundary.
      throw err;
    }
  }

  if (active.length === 0) {
    return {
      ok: false,
      code: "FEATURE_NOT_FOUND",
      message: "no feature found in cwd (.loaf/ is empty, missing, or all features are DONE)",
      detail: { cwd: input.cwd, candidate_count: candidates.length },
    };
  }

  if (active.length >= 2) {
    return {
      ok: false,
      code: "FEATURE_AMBIGUOUS",
      message:
        `current working directory has ${active.length} active features and no dispatch context: ` +
        active.map((a) => a.feature).join(", "),
      detail: {
        count: active.length,
        feature_list: active.map((a) => a.feature),
      },
    };
  }

  const picked = active[0]!;
  return {
    ok: true,
    feature: picked.feature,
    featureDir: picked.featureDir,
    sessionId: picked.sessionId,
    source: "auto-pick",
    autoPickAdvisory: `auto-picked '${picked.feature}'`,
  };
}
