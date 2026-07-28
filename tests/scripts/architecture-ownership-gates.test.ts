import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { CONCURRENCY_INVARIANTS } from "../../src/core/concurrency-contract.js";
import {
  DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS,
  FEATURE_WRITE_LEASE_ERROR_CODES,
  FEATURE_WRITE_LEASE_MECHANISM,
} from "../../src/core/feature-write-lease.js";
import {
  MUTATION_COMMIT_STATES,
  POST_APPEND_COMMIT_FAILURE_CODES,
} from "../../src/core/journal-mutate.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type SourceMap = ReadonlyMap<string, string>;

function collectFiles(root: string, predicate: (relative: string) => boolean): SourceMap {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(path.join(REPO_ROOT, root), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(REPO_ROOT, absolute);
    if (predicate(relative)) sources.set(relative, readFileSync(absolute, "utf8"));
  }
  return sources;
}

function withInjected(
  sources: SourceMap,
  file: string,
  injection: string,
): ReadonlyMap<string, string> {
  const changed = new Map(sources);
  changed.set(file, `${changed.get(file) ?? ""}\n${injection}`);
  return changed;
}

function ownershipViolations(sources: SourceMap): string[] {
  const violations: string[] = [];
  for (const [file, text] of sources) {
    if (
      file.startsWith("src/core/") &&
      file !== "src/core/attachment-authority.ts" &&
      /path\.(?:join|resolve)\([^)]*\bref\.path\b/s.test(text)
    ) {
      violations.push(`attachment-dereference:${file}`);
    }
    if (
      file.startsWith("src/cli/commands/") &&
      /from\s+["'][^"']*\/journal-mutate\.js["']/.test(text)
    ) {
      violations.push(`command-mutator-bypass:${file}`);
    }
    if (
      file.startsWith("src/cli/") &&
      file !== "src/cli/command-mutator.ts" &&
      /\bexecuteClosureTransaction\s*\(/.test(text)
    ) {
      violations.push(`scope-closure-bypass:${file}`);
    }
    if (
      file.startsWith("src/") &&
      file !== "src/core/scope-closure-policy.ts" &&
      /\bkind:\s*["']scope:recorded["']/.test(text)
    ) {
      violations.push(`scope-fact-construction:${file}`);
    }
    if (
      (file.startsWith("src/") ||
        file.startsWith("skills/") ||
        [
          "docs/machine-contract.md",
          "docs/protocol.md",
          "docs/references/incremental-construction.md",
        ].includes(file)) &&
      /(?:`loaf context pack(?:\s|\[)|context-pack-schema)/.test(text)
    ) {
      violations.push(`live-context-pack:${file}`);
    }
  }
  return violations.sort();
}

function indexContractViolations(html: string): string[] {
  const forbidden: ReadonlyArray<readonly [string, RegExp]> = [
    ["reconcile-live-target", /(?:settle_phase=true|event:phase_advanced)[^<\n]*SETTLE\.reconcile/],
    ["reconcile-live-projection", /snapshots\/\{[^}]*reconcile/],
    ["registry-heartbeat-stale", /registry-stale|at 早于 heartbeat/],
    ["skill-decision-owner", /skill 管 content/],
    ["pre-append-only-outcome", /任一步 fail[^<\n]*journal 未 append/],
  ];
  return forbidden.flatMap(([name, pattern]) => (pattern.test(html) ? [name] : []));
}

function concurrencyContractViolations(
  contract: typeof CONCURRENCY_INVARIANTS,
): string[] {
  const violations: string[] = [];
  if (contract.feature_write_lease.timeout_ms !== DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS) {
    violations.push("feature-lease-timeout");
  }
  if (contract.lock_timeout_seconds * 1_000 !== DEFAULT_FEATURE_WRITE_LEASE_TIMEOUT_MS) {
    violations.push("legacy-timeout-alias");
  }
  if (contract.lock_mechanism !== FEATURE_WRITE_LEASE_MECHANISM) {
    violations.push("feature-lease-mechanism");
  }
  if (contract.feature_write_lease.error_codes !== FEATURE_WRITE_LEASE_ERROR_CODES) {
    violations.push("feature-lease-error-codes");
  }
  if (contract.feature_write_lease.malformed_owner !== "fail-closed") {
    violations.push("malformed-owner-polarity");
  }
  if (contract.feature_write_lease.release_fence !== "owner-token") {
    violations.push("release-fence");
  }
  if (contract.mutation_outcomes.states !== MUTATION_COMMIT_STATES) {
    violations.push("commit-state-owner");
  }
  if (contract.mutation_outcomes.pre_append_failure !== "not-committed") {
    violations.push("pre-append-outcome");
  }
  if (contract.mutation_outcomes.dry_run_success !== "not-committed") {
    violations.push("dry-run-outcome");
  }
  if (contract.mutation_outcomes.post_append_failure !== "committed") {
    violations.push("post-append-outcome");
  }
  if (
    contract.mutation_outcomes.post_append_failure_codes !== POST_APPEND_COMMIT_FAILURE_CODES
  ) {
    violations.push("post-append-code-owner");
  }
  if (contract.orphan_attachment_gc.status !== "deferred") {
    violations.push("orphan-attachment-gc-status");
  }
  return violations;
}

describe("architecture ownership gates", () => {
  const sources = new Map([
    ...collectFiles("src", (file) => /\.[cm]?[jt]sx?$/.test(file)),
    ...collectFiles("skills", (file) => file.endsWith("SKILL.md")),
    ...[
      "docs/machine-contract.md",
      "docs/protocol.md",
      "docs/references/incremental-construction.md",
    ].map((file) => [file, readFileSync(path.join(REPO_ROOT, file), "utf8")] as const),
  ]);

  test("Attachment, CommandMutator, scope closure, and context-pack owners are exclusive", () => {
    expect(ownershipViolations(sources)).toEqual([]);
  });

  test.each([
    [
      "attachment dereference",
      "src/core/lessons-projection.ts",
      "path.join(featureDir, ref.path);",
      "attachment-dereference:",
    ],
    [
      "direct journal mutation import",
      "src/cli/commands/evidence.tsx",
      'import { mutateBatch } from "../../core/journal-mutate.js";',
      "command-mutator-bypass:",
    ],
    [
      "scope closure bypass",
      "src/cli/commands/lifecycle.tsx",
      "executeClosureTransaction({});",
      "scope-closure-bypass:",
    ],
    [
      "scope fact construction",
      "src/core/execute-closure.ts",
      'const injected = { kind: "scope:recorded" };',
      "scope-fact-construction:",
    ],
    [
      "live context-pack command",
      "skills/run/SKILL.md",
      "Run `loaf context pack --feature F-001`.",
      "live-context-pack:",
    ],
  ])("negative control detects %s", (_name, file, injection, expectedPrefix) => {
    expect(
      ownershipViolations(withInjected(sources, file, injection)).some((failure) =>
        failure.startsWith(expectedPrefix),
      ),
    ).toBe(true);
  });
});

describe("docs index runtime contract", () => {
  const index = readFileSync(path.join(REPO_ROOT, "docs", "index.html"), "utf8");

  test("does not advertise retired proof, lease, reconcile, or skill ownership", () => {
    expect(indexContractViolations(index)).toEqual([]);
  });

  test.each([
    ["reconcile target", "settle_phase=true → SETTLE.reconcile", "reconcile-live-target"],
    ["registry heartbeat heuristic", "registry-stale", "registry-heartbeat-stale"],
    ["skill decision ownership", "skill 管 content", "skill-decision-owner"],
    ["pre-append-only outcome", "任一步 fail，journal 未 append", "pre-append-only-outcome"],
  ])("negative control detects %s", (_name, injection, expected) => {
    expect(indexContractViolations(`${index}\n${injection}`)).toContain(expected);
  });
});

describe("executable concurrency contract", () => {
  test("binds declarative lease and commit outcomes to runtime owners", () => {
    expect(concurrencyContractViolations(CONCURRENCY_INVARIANTS)).toEqual([]);
  });

  test.each([
    ["feature lease timeout", { feature_write_lease: { timeout_ms: 1 } }, "feature-lease-timeout"],
    [
      "feature lease mechanism",
      { lock_mechanism: "POSIX flock" },
      "feature-lease-mechanism",
    ],
    [
      "feature lease error codes",
      { feature_write_lease: { error_codes: ["LOCK_TIMEOUT"] } },
      "feature-lease-error-codes",
    ],
    [
      "orphan attachment GC status",
      { orphan_attachment_gc: { status: "implemented" } },
      "orphan-attachment-gc-status",
    ],
    [
      "pre-append outcome",
      { mutation_outcomes: { pre_append_failure: "committed" } },
      "pre-append-outcome",
    ],
    [
      "post-append outcome",
      { mutation_outcomes: { post_append_failure: "not-committed" } },
      "post-append-outcome",
    ],
  ])("negative control detects %s drift", (_name, replacement, expected) => {
    const altered = replacement as {
      feature_write_lease?: Partial<typeof CONCURRENCY_INVARIANTS.feature_write_lease>;
      mutation_outcomes?: Partial<typeof CONCURRENCY_INVARIANTS.mutation_outcomes>;
      orphan_attachment_gc?: Partial<typeof CONCURRENCY_INVARIANTS.orphan_attachment_gc>;
    };
    const changed = {
      ...CONCURRENCY_INVARIANTS,
      ...altered,
      feature_write_lease: {
        ...CONCURRENCY_INVARIANTS.feature_write_lease,
        ...(altered.feature_write_lease ?? {}),
      },
      mutation_outcomes: {
        ...CONCURRENCY_INVARIANTS.mutation_outcomes,
        ...(altered.mutation_outcomes ?? {}),
      },
      orphan_attachment_gc: {
        ...CONCURRENCY_INVARIANTS.orphan_attachment_gc,
        ...(altered.orphan_attachment_gc ?? {}),
      },
    } as typeof CONCURRENCY_INVARIANTS;
    expect(concurrencyContractViolations(changed)).toContain(expected);
  });
});
