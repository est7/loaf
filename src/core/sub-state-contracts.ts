// Phase 16 SC-15b — runtime mirror of `docs/schemas.ts:SUB_STATE_CONTRACTS`.
//
// Stable-core layer does NOT import from docs/ (project pattern, same as
// hook-events.ts). The lockstep test at
// `tests/cli/sub-state-contracts-runtime-lockstep.test.ts` catches drift
// between this mirror and the canonical docs schema.
//
// SC-15b consumes `prompt_inject` (session-start context composition).
// The FULL contract is mirrored — not a prompt-only map — because SC-15c
// (write-guard) immediately needs `write_paths` / `mutation_rights`, and a
// prompt-only mirror would force a second public-contract migration one
// slice later (codex GO Q-C lock).

import { SubState } from "./journal-entry.js";
import { z } from "zod";

// MutationRights — per-file allowlist/denylist mirror (docs §SubStateContract).
export const MutationRights = z.object({
  writable_fields: z.array(z.string()).default([]),
  forbidden_fields: z.array(z.string()).default([]),
});
export type MutationRights = z.infer<typeof MutationRights>;

export const SubStateContract = z.object({
  sub_state: SubState,
  entry: z.string(),
  exit: z.string(),
  write_paths: z.array(z.string()),
  mutation_rights: MutationRights.optional(),
  next: z.array(SubState),
  prompt_inject: z.string(),
});
export type SubStateContract = z.infer<typeof SubStateContract>;

export const SUB_STATE_CONTRACTS: Array<z.infer<typeof SubStateContract>> = [
  // ─── TRIAGE ───
  {
    sub_state: "TRIAGE.score",
    entry: "loaf start <desc> invoked",
    exit: "complexity_score computed (0-100)",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["TRIAGE.confirm"],
    prompt_inject: "Score 0-100 across files/api/schema/concurrency/security. Suggest profile.",
  },
  {
    sub_state: "TRIAGE.confirm",
    entry: "score computed",
    exit: "user accepts or overrides profile",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["SPEC.proposal", "EXECUTE.plan"],
    prompt_inject:
      "Confirm proposed profile (quick/light/standard/deep — see skill PRESETS) or override.",
  },

  // ─── SPEC ───
  {
    sub_state: "SPEC.proposal",
    entry:
      "ceremony.spec_phase=true && TRIAGE.confirm done; OR Q9 escalation backfill (ceremony.spec_phase 由 false 改 true)",
    exit: "spec.md body has Proposal section",
    write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/spec-draft-context.md"],
    next: ["SPEC.spec"],
    prompt_inject:
      "Write Proposal: why / scope / anti-scope. If backfill, read spec-draft-context.md.",
  },
  {
    sub_state: "SPEC.spec",
    entry: "proposal section exists OR amend-spec back-edge",
    exit: "frontmatter has requirements (each with three-way verifiability) + scenarios (+visual_contracts if UI); needs_clarification empty",
    write_paths: [".loaf/<feature>/spec.md"],
    next: ["SPEC.plan"],
    prompt_inject:
      "Author EARS REQ-* with measurable / verified_by_scenarios / acceptance_na+reason. Add Gherkin SCEN-* and VIS-* as needed.",
  },
  {
    sub_state: "SPEC.plan",
    entry: "spec section complete && needs_clarification empty",
    exit: "spec.md body has Plan section",
    write_paths: [".loaf/<feature>/spec.md"],
    mutation_rights: {
      writable_fields: ["spec.md:body.plan"],
      forbidden_fields: [
        "spec.md:frontmatter.requirements",
        "spec.md:frontmatter.scenarios",
        "spec.md:frontmatter.visual_contracts",
        "tasks.json:*",
      ],
    },
    next: ["SPEC.design"],
    prompt_inject: "Plan: risks / dependencies / milestones.",
  },
  {
    sub_state: "SPEC.design",
    entry: "plan section complete",
    exit: "design section + tasks.json generated; every REQ/SCEN/VIS bound to ≥1 task",
    write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/tasks.json"],
    mutation_rights: {
      writable_fields: ["spec.md:body.design", "tasks.json:*"],
      forbidden_fields: [
        "spec.md:frontmatter.requirements",
        "spec.md:frontmatter.scenarios",
        "spec.md:frontmatter.visual_contracts",
      ],
    },
    next: ["EXECUTE.plan"],
    prompt_inject:
      "Design + decompose into tasks bound to REQ/SCEN/VIS via task.drives[]. Use labels[] for bug/security/etc.",
  },

  // ─── EXECUTE ───
  {
    sub_state: "EXECUTE.plan",
    entry: "spec-lock passed (or quick: TRIAGE.confirm done)",
    exit: "every task has execution policy populated per its kind",
    write_paths: [".loaf/<feature>/tasks.json"],
    mutation_rights: {
      writable_fields: [
        "tasks.json:tasks[].execution[].applicability",
        "tasks.json:tasks[].status",
      ],
      forbidden_fields: [
        "tasks.json:tasks[].id",
        "tasks.json:tasks[].kind",
        "tasks.json:tasks[].drives",
        "tasks.json:tasks[].depends_on",
        "tasks.json:tasks[].labels",
        "spec.md:*",
      ],
    },
    next: ["EXECUTE.work"],
    prompt_inject:
      "Derive execution policy for each task from kind × profile. Set step.applicability accordingly.",
  },
  {
    sub_state: "EXECUTE.work",
    entry: "EXECUTE.plan done OR fix-impl/fix-test/amend-tasks back-edge",
    exit: "every task.status = done OR abandoned, with all required steps passed/waived/na",
    write_paths: [
      ".loaf/<feature>/tasks.json",
      ".loaf/<feature>/evidence.jsonl",
      ".loaf/<feature>/findings.jsonl",
    ],
    mutation_rights: {
      writable_fields: [
        "tasks.json:tasks[].execution[].status",
        "tasks.json:tasks[].execution[].evidence_refs",
        "tasks.json:tasks[].status",
        "evidence.jsonl:*",
        "findings.jsonl:*",
      ],
      forbidden_fields: [
        "tasks.json:tasks[].id",
        "tasks.json:tasks[].kind",
        "tasks.json:tasks[].drives",
        "tasks.json:tasks[].depends_on",
        "tasks.json:tasks[].labels",
        "spec.md:*",
      ],
    },
    next: ["EXECUTE.work", "EXECUTE.done"],
    prompt_inject:
      "Execute each in-progress task at its currently-running step. Append evidence with covers[].",
  },
  {
    sub_state: "EXECUTE.done",
    entry: "all tasks status ∈ {done, abandoned}",
    exit:
      "advance to VERIFY.plan (verify_phase=true);" +
      " OR DONE.delivered (verify_phase=false: quick / light non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + §10.14)",
    write_paths: [],
    next: ["VERIFY.plan", "DONE.delivered"],
    prompt_inject:
      "All tasks complete. verify_phase=true → advance to VERIFY.plan." +
      " verify_phase=false non-spike → run `loaf deliver` (verify-min then DONE.delivered)." +
      " spike (any profile) → deliver blocked; pick archive / spike convert / abandon per §8.3.",
  },

  // ─── VERIFY ───
  {
    sub_state: "VERIFY.plan",
    entry: "EXECUTE.done && ceremony.verify_phase=true",
    exit: "applicability computed for each VerifyCheckKind (must/optional/na with reasons)",
    write_paths: [".loaf/<feature>/state.json"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Compute which verify checks apply: run/review/acceptance/visual. Output reasoning + N/A justifications.",
  },
  {
    sub_state: "VERIFY.run",
    entry: "VERIFY.plan done with run applicability ∈ {must, optional-elected}; OR amend back-edge",
    exit: "run check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.review", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run the `run` check (test + lint + typecheck). Append evidence with kind=local-check or task-summary. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.review",
    entry: "VERIFY.plan or prior check done with review applicability ∈ {must, optional-elected}",
    exit: "review check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.acceptance", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run quality review (spec_fit + quality_fit). Append evidence with kind=verify-review. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.acceptance",
    entry:
      "VERIFY.plan or prior check done with acceptance applicability ∈ {must, optional-elected}",
    exit: "acceptance check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.visual", "VERIFY.accept"],
    prompt_inject:
      "Run selected Gherkin acceptance scenarios. Append evidence with kind=acceptance. Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.visual",
    entry: "VERIFY.plan or prior check done with visual applicability ∈ {must, optional-elected}",
    exit: "visual check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    next: ["VERIFY.run", "VERIFY.review", "VERIFY.acceptance", "VERIFY.accept"],
    prompt_inject:
      "Run visual contract verification. Append evidence with kind=visual-review (attachments required). Raise findings as needed.",
  },
  {
    sub_state: "VERIFY.accept",
    entry: "all applicable checks passed/waived + no open findings",
    exit:
      "verify-accept gate approved." +
      " settle_phase=true (deep) → SETTLE.reconcile via `loaf settle`;" +
      " settle_phase=false (standard) → DONE.delivered via `loaf deliver`",
    write_paths: [".loaf/<feature>/evidence.jsonl"],
    next: ["SETTLE.reconcile", "DONE.delivered"],
    prompt_inject:
      "Verify-accept gate. Review check status + open findings. Approve or reject." +
      " On approve: settle_phase=true → `loaf settle` enters SETTLE.reconcile;" +
      " settle_phase=false → `loaf deliver` enters DONE.delivered.",
  },

  // ─── SETTLE ───
  {
    sub_state: "SETTLE.reconcile",
    entry:
      "verify-accept passed && ceremony.settle_phase=true (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "reconcile.json valid",
    write_paths: [".loaf/<feature>/reconcile.json"],
    next: ["SETTLE.lessons"],
    prompt_inject:
      "Compare planned_scope vs actual_scope. Resolve every drift. Snapshot verify_checks_status.",
  },
  {
    sub_state: "SETTLE.lessons",
    entry: "reconcile valid (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "lessons.md appended (deep: lessons_required=must)",
    write_paths: [".loaf/<feature>/lessons.md"],
    next: ["DONE.delivered", "DONE.archived", "DONE.abandoned"],
    prompt_inject:
      "Append lessons (deep: MUST). User then runs `loaf deliver` / `loaf archive` / `loaf abandon`.",
  },

  // ─── DONE (terminal) ───
  {
    sub_state: "DONE.delivered",
    entry: "loaf deliver succeeded (Q4: advisory only — no git/gh side effects)",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
  {
    sub_state: "DONE.archived",
    entry: "loaf archive --reason '...'",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
  {
    sub_state: "DONE.abandoned",
    entry: "loaf abandon --reason '...' (reason required)",
    exit: "terminal",
    write_paths: [],
    next: [],
    prompt_inject: "",
  },
];

/** sub_state → contract lookup (built once; the contract list is frozen). */
export const SUB_STATE_CONTRACT_BY_STATE: Readonly<Record<string, SubStateContract>> =
  Object.fromEntries(SUB_STATE_CONTRACTS.map((c) => [c.sub_state, c]));

/**
 * prompt_inject text for a sub_state. Returns `undefined` for an unknown
 * sub_state (caller decides: session-start treats unknown as no-context).
 * Terminal DONE.* states carry an empty-string prompt_inject by design.
 */
export function promptInjectFor(subState: string): string | undefined {
  return SUB_STATE_CONTRACT_BY_STATE[subState]?.prompt_inject;
}
