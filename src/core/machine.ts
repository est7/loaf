import type { EntryKind, GateName, SubState } from "./journal-entry.js";

// `contract:next` preserves contract-only navigation hints that are not
// legal `event:phase_advanced` transitions. It has no journal apply owner.
export type MachineEdgeOwnerKind =
  | Extract<
      EntryKind,
      "event:phase_advanced" | "session:delivered" | "session:archived" | "session:abandoned"
    >
  | "contract:next";

export type MachineGuardName =
  | "spec_phase_required"
  | "spec_phase_forbidden"
  | "verify_phase_required"
  | "spec_locked_required"
  | "settle_phase_required"
  | "verify_accepted_required";

export type MachineEdge = {
  target: SubState;
  owner_kind: MachineEdgeOwnerKind;
  guards?: readonly MachineGuardName[];
};

export type MachineNode = {
  entry: string;
  exit: string;
  write_paths: readonly string[];
  mutation_rights?: {
    writable_fields: readonly string[];
    forbidden_fields: readonly string[];
  };
  edges: readonly MachineEdge[];
  prompt_inject: string;
  gate?: GateName;
};

export type MachineDefinition = Record<SubState, MachineNode>;

/** Preserve literal inference while rejecting missing and extra state keys. */
export function defineMachine<const T extends MachineDefinition>(
  machine: T & Record<Exclude<keyof T, SubState>, never>,
): T {
  return machine;
}

/** Canonical state-axis definition. Keep declaration order aligned with SubState. */
export const MACHINE = defineMachine({
  "TRIAGE.score": {
    entry: "loaf start <desc> invoked",
    exit: "complexity_score computed (0-100)",
    write_paths: [".loaf/<feature>/state.json"],
    edges: [{ target: "TRIAGE.confirm", owner_kind: "event:phase_advanced" }],
    prompt_inject: "Score 0-100 across files/api/schema/concurrency/security. Suggest profile.",
  },
  "TRIAGE.confirm": {
    entry: "score computed",
    exit: "user accepts or overrides profile",
    write_paths: [".loaf/<feature>/state.json"],
    edges: [
      {
        target: "SPEC.proposal",
        owner_kind: "event:phase_advanced",
        guards: ["spec_phase_required"],
      },
      {
        target: "EXECUTE.plan",
        owner_kind: "event:phase_advanced",
        guards: ["spec_phase_forbidden"],
      },
    ],
    prompt_inject:
      "Confirm proposed profile (quick/light/standard/deep — see skill PRESETS) or override.",
  },
  "SPEC.proposal": {
    entry:
      "ceremony.spec_phase=true && TRIAGE.confirm done; OR Q9 escalation backfill (ceremony.spec_phase 由 false 改 true)",
    exit: "spec.md body has Proposal section",
    write_paths: [".loaf/<feature>/spec.md", ".loaf/<feature>/spec-draft-context.md"],
    edges: [{ target: "SPEC.spec", owner_kind: "event:phase_advanced" }],
    prompt_inject:
      "Write Proposal: why / scope / anti-scope. If backfill, read spec-draft-context.md.",
  },
  "SPEC.spec": {
    entry: "proposal section exists OR amend-spec back-edge",
    exit: "frontmatter has requirements (each with three-way verifiability) + scenarios (+visual_contracts if UI); needs_clarification empty",
    write_paths: [".loaf/<feature>/spec.md"],
    edges: [{ target: "SPEC.plan", owner_kind: "event:phase_advanced" }],
    prompt_inject:
      "Author EARS REQ-* with measurable / verified_by_scenarios / acceptance_na+reason. Add Gherkin SCEN-* and VIS-* as needed.",
  },
  "SPEC.plan": {
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
    edges: [{ target: "SPEC.design", owner_kind: "event:phase_advanced" }],
    prompt_inject: "Plan: risks / dependencies / milestones.",
  },
  "SPEC.design": {
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
    edges: [
      {
        target: "EXECUTE.plan",
        owner_kind: "event:phase_advanced",
        guards: ["spec_locked_required"],
      },
    ],
    prompt_inject:
      "Design + decompose into tasks bound to REQ/SCEN/VIS via task.drives[]. Use labels[] for bug/security/etc.",
    gate: "spec-lock",
  },
  "EXECUTE.plan": {
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
    edges: [{ target: "EXECUTE.work", owner_kind: "event:phase_advanced" }],
    prompt_inject:
      "Derive execution policy for each task from kind × profile. Set step.applicability accordingly.",
  },
  "EXECUTE.work": {
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
    edges: [
      { target: "EXECUTE.work", owner_kind: "contract:next" },
      { target: "EXECUTE.done", owner_kind: "event:phase_advanced" },
    ],
    prompt_inject:
      "Execute each in-progress task at its currently-running step. Append evidence with covers[].",
  },
  "EXECUTE.done": {
    entry: "all tasks status ∈ {done, abandoned}",
    exit:
      "advance to VERIFY.plan (verify_phase=true);" +
      " OR DONE.delivered (verify_phase=false: quick / light non-spike via `loaf deliver`: verify-min runs at this boundary, on pass transition direct to DONE.delivered, on fail exit 2 — see protocol.md §3.2 + §10.14)",
    write_paths: [],
    edges: [
      {
        target: "VERIFY.plan",
        owner_kind: "event:phase_advanced",
        guards: ["verify_phase_required"],
      },
      { target: "DONE.delivered", owner_kind: "session:delivered" },
    ],
    prompt_inject:
      "All tasks complete. verify_phase=true → advance to VERIFY.plan." +
      " verify_phase=false non-spike → run `loaf deliver` (verify-min then DONE.delivered)." +
      " spike (any profile) → deliver blocked; pick archive / spike convert / abandon per §8.3.",
  },
  "VERIFY.plan": {
    entry: "EXECUTE.done && ceremony.verify_phase=true",
    exit: "applicability computed for each VerifyCheckKind (must/optional/na with reasons)",
    write_paths: [".loaf/<feature>/state.json"],
    edges: [
      { target: "VERIFY.run", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.review", owner_kind: "contract:next" },
      { target: "VERIFY.acceptance", owner_kind: "contract:next" },
      { target: "VERIFY.visual", owner_kind: "contract:next" },
      { target: "VERIFY.accept", owner_kind: "contract:next" },
    ],
    prompt_inject:
      "Compute which verify checks apply: run/review/acceptance/visual. Output reasoning + N/A justifications.",
  },
  "VERIFY.run": {
    entry: "VERIFY.plan done with run applicability ∈ {must, optional-elected}; OR amend back-edge",
    exit: "run check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    edges: [
      { target: "VERIFY.review", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.acceptance", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.visual", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.accept", owner_kind: "event:phase_advanced" },
    ],
    prompt_inject:
      "Run the `run` check (test + lint + typecheck). Append evidence with kind=local-check or task-summary. Raise findings as needed.",
  },
  "VERIFY.review": {
    entry: "VERIFY.plan or prior check done with review applicability ∈ {must, optional-elected}",
    exit: "review check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    edges: [
      { target: "VERIFY.run", owner_kind: "contract:next" },
      { target: "VERIFY.acceptance", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.visual", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.accept", owner_kind: "event:phase_advanced" },
    ],
    prompt_inject:
      "Run quality review (spec_fit + quality_fit). Append evidence with kind=verify-review. Raise findings as needed.",
  },
  "VERIFY.acceptance": {
    entry:
      "VERIFY.plan or prior check done with acceptance applicability ∈ {must, optional-elected}",
    exit: "acceptance check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    edges: [
      { target: "VERIFY.run", owner_kind: "contract:next" },
      { target: "VERIFY.review", owner_kind: "contract:next" },
      { target: "VERIFY.visual", owner_kind: "event:phase_advanced" },
      { target: "VERIFY.accept", owner_kind: "event:phase_advanced" },
    ],
    prompt_inject:
      "Run selected Gherkin acceptance scenarios. Append evidence with kind=acceptance. Raise findings as needed.",
  },
  "VERIFY.visual": {
    entry: "VERIFY.plan or prior check done with visual applicability ∈ {must, optional-elected}",
    exit: "visual check passed or explicitly waived",
    write_paths: [".loaf/<feature>/evidence.jsonl", ".loaf/<feature>/findings.jsonl"],
    edges: [
      { target: "VERIFY.run", owner_kind: "contract:next" },
      { target: "VERIFY.review", owner_kind: "contract:next" },
      { target: "VERIFY.acceptance", owner_kind: "contract:next" },
      { target: "VERIFY.accept", owner_kind: "event:phase_advanced" },
    ],
    prompt_inject:
      "Run visual contract verification. Append evidence with kind=visual-review (attachments required). Raise findings as needed.",
  },
  "VERIFY.accept": {
    entry:
      "all applicable checks passed/waived + no actionable open findings (`defer` / `backlog` are non-blocking dispositions)",
    exit:
      "verify-accept gate approved." +
      " settle_phase=true (deep) → SETTLE.reconcile via `loaf settle`;" +
      " settle_phase=false (standard) → DONE.delivered via `loaf deliver`",
    write_paths: [".loaf/<feature>/evidence.jsonl"],
    edges: [
      {
        target: "SETTLE.reconcile",
        owner_kind: "event:phase_advanced",
        guards: ["settle_phase_required", "verify_accepted_required"],
      },
      { target: "DONE.delivered", owner_kind: "session:delivered" },
    ],
    prompt_inject:
      "Verify-accept gate. Review check status + open findings. Approve or reject." +
      " On approve: settle_phase=true → `loaf settle` enters SETTLE.reconcile;" +
      " settle_phase=false → `loaf deliver` enters DONE.delivered.",
    gate: "verify-accept",
  },
  "SETTLE.reconcile": {
    entry:
      "verify-accept passed && ceremony.settle_phase=true (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "reconcile.json valid",
    write_paths: [".loaf/<feature>/reconcile.json"],
    edges: [{ target: "SETTLE.lessons", owner_kind: "event:phase_advanced" }],
    prompt_inject:
      "Compare planned_scope vs actual_scope. Resolve every drift. Snapshot verify_checks_status.",
  },
  "SETTLE.lessons": {
    entry: "reconcile valid (deep only after rev 5.x; quick/light/standard skip SETTLE)",
    exit: "lessons.md appended (deep: lessons_required=must)",
    write_paths: [".loaf/<feature>/lessons.md"],
    edges: [
      { target: "DONE.delivered", owner_kind: "session:delivered" },
      { target: "DONE.archived", owner_kind: "session:archived" },
      { target: "DONE.abandoned", owner_kind: "session:abandoned" },
    ],
    prompt_inject:
      "Append lessons (deep: MUST). User then runs `loaf deliver` / `loaf archive` / `loaf abandon`.",
  },
  "DONE.delivered": {
    entry: "loaf deliver succeeded (Q4: advisory only — no git/gh side effects)",
    exit: "terminal",
    write_paths: [],
    edges: [],
    prompt_inject: "",
  },
  "DONE.archived": {
    entry: "loaf archive --reason '...'",
    exit: "terminal",
    write_paths: [],
    edges: [],
    prompt_inject: "",
  },
  "DONE.abandoned": {
    entry: "loaf abandon --reason '...' (reason required)",
    exit: "terminal",
    write_paths: [],
    edges: [],
    prompt_inject: "",
  },
} as const satisfies MachineDefinition);

export type MachineState = keyof typeof MACHINE;

export type DerivedSubStateContract = {
  sub_state: SubState;
  entry: string;
  exit: string;
  write_paths: string[];
  mutation_rights?: {
    writable_fields: string[];
    forbidden_fields: string[];
  };
  next: SubState[];
  prompt_inject: string;
};

/** Compatibility projection consumed by the runtime contract shim. */
export const SUB_STATE_CONTRACTS: DerivedSubStateContract[] = Object.entries(MACHINE).map(
  ([subState, node]) => ({
    sub_state: subState as SubState,
    entry: node.entry,
    exit: node.exit,
    write_paths: [...node.write_paths],
    ...("mutation_rights" in node
      ? {
          mutation_rights: {
            writable_fields: [...node.mutation_rights.writable_fields],
            forbidden_fields: [...node.mutation_rights.forbidden_fields],
          },
        }
      : {}),
    next: node.edges.map((edge) => edge.target),
    prompt_inject: node.prompt_inject,
  }),
);

/** Cursor-owned human gate, if the current node declares one. */
export function gateNameForCursor(subState: SubState): GateName | null {
  const node: MachineNode = MACHINE[subState];
  return node.gate ?? null;
}
