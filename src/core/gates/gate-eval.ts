// L7 — gate-mode eval factory. The two gate evaluators (spec-lock,
// verify-accept) share their ENTIRE body verbatim: read spec.md frontmatter,
// synthesize a `check: 1` SPEC_FRONTMATTER_INVALID failure when it is
// unreadable, else delegate to the pure check. Only the pure check differs.
//
// The DIAGNOSTIC eval (evaluateVerifyAcceptDiagnostic) is intentionally NOT
// built here: on read failure it returns a structured `{ok:false, code, ...}`
// error rather than a synthesized check-1 row — a divergence codex r302 locked
// so `loaf verify status` does not pretend 5 checks ran when 0 could. Keeping it
// out of this factory keeps gate-mode vs diagnostic-mode explicit.

import { readSpecFrontmatter } from "../spec-frontmatter.js";
import type { ReadSpecResult } from "../spec-frontmatter.js";
import type { Snapshot } from "../projection-types.js";

type ReadFailure = Extract<ReadSpecResult, { ok: false }>;
type Frontmatter = Extract<ReadSpecResult, { ok: true }>["frontmatter"];

// The check-1 row both gate evals synthesize. A structural subtype of BOTH
// spec-lock's and verify-accept's FailedCheck (`check: 1` and
// `code: "SPEC_FRONTMATTER_INVALID"` are members of each), so it slots into
// either gate result's `{ok:false; checks: FailedCheck[]}` failure arm — the
// explicit return annotations on the two evals coerce the union back.
type SpecReadFailure = {
  ok: false;
  checks: [
    { check: 1; code: "SPEC_FRONTMATTER_INVALID"; message: string; detail: Record<string, unknown> },
  ];
};

function specReadFailure(read: ReadFailure): SpecReadFailure {
  return {
    ok: false,
    checks: [
      {
        check: 1,
        code: "SPEC_FRONTMATTER_INVALID",
        message: read.message,
        detail: { subcode: read.code, ...(read.detail ?? {}) },
      },
    ],
  };
}

/**
 * Build a gate-mode evaluator from a pure check. The returned evaluator reads
 * frontmatter at the IO boundary, maps a read failure to a check-1 row, and
 * otherwise delegates to `check`. Return type is `R | SpecReadFailure`; callers
 * annotate the clean alias (FullSpecLockResult / FullVerifyAcceptResult) to
 * coerce — SpecReadFailure is a subtype of both gate results' failure arm.
 */
export function gateEvalFromCheck<R extends { ok: true } | { ok: false; checks: unknown[] }>(
  check: (snapshot: Snapshot, frontmatter: Frontmatter) => R,
): (snapshot: Snapshot, featureDir: string) => Promise<R | SpecReadFailure> {
  return async (snapshot, featureDir) => {
    const read = await readSpecFrontmatter(featureDir);
    if (!read.ok) return specReadFailure(read);
    return check(snapshot, read.frontmatter);
  };
}
