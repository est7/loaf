import {
  ScopeRecordedPayload,
  type JournalEntry,
} from "./journal-entry.js";

export type ScopeClosureFact = {
  scope: JournalEntry;
  transition: JournalEntry;
  iteration: number;
};

export type ScopeClosureFailure = {
  code:
    | "SCOPE_RECORDED_BATCH_INVALID"
    | "SCOPE_RECORDED_ITERATION_DUPLICATE";
  message: string;
  detail: Record<string, unknown>;
};

function isExecuteClosure(entry: JournalEntry): boolean {
  const payload = entry.payload as { from?: unknown; to?: unknown };
  return (
    entry.kind === "event:phase_advanced" &&
    payload.from === "EXECUTE.work" &&
    payload.to === "EXECUTE.done"
  );
}

function parseAdjacentFact(
  scope: JournalEntry,
  transition: JournalEntry,
): ScopeClosureFact | null {
  if (scope.kind !== "scope:recorded" || !isExecuteClosure(transition)) {
    return null;
  }
  const parsed = ScopeRecordedPayload.safeParse(scope.payload);
  if (!parsed.success) return null;
  if (
    scope.actor !== transition.actor ||
    scope.batch_id === undefined ||
    scope.batch_id !== transition.batch_id ||
    scope.batch_index !== 0 ||
    transition.batch_index !== 1 ||
    scope.batch_count !== 2 ||
    transition.batch_count !== 2
  ) {
    return null;
  }
  return { scope, transition, iteration: parsed.data.iteration };
}

/**
 * Parse canonical closure facts from journal history. Only the exact
 * two-entry batch emitted by the closure writer is accepted as a fact.
 */
export function parseScopeClosureFacts(
  entries: readonly JournalEntry[],
): {
  facts: ScopeClosureFact[];
  incompleteTransitionSeqs: number[];
} {
  const facts: ScopeClosureFact[] = [];
  const consumedTransitions = new Set<number>();
  for (let index = 0; index + 1 < entries.length; index += 1) {
    const fact = parseAdjacentFact(entries[index]!, entries[index + 1]!);
    if (fact === null) continue;
    facts.push(fact);
    consumedTransitions.add(fact.transition.seq);
  }
  return {
    facts,
    incompleteTransitionSeqs: entries
      .filter(isExecuteClosure)
      .filter((entry) => !consumedTransitions.has(entry.seq))
      .map((entry) => entry.seq),
  };
}

/** Validate the candidate closure fact against current state and history. */
export function validateScopeClosureBatch(
  candidates: readonly JournalEntry[],
  priorEntries: readonly JournalEntry[],
  expectedIteration: number,
): ScopeClosureFailure | null {
  const scopeIndexes = candidates.flatMap((entry, index) =>
    entry.kind === "scope:recorded" ? [index] : [],
  );
  const closureIndexes = candidates.flatMap((entry, index) =>
    isExecuteClosure(entry) ? [index] : [],
  );
  // A marker is what asserts the canonical closure fact. Marker-less
  // historical/raw closure transitions remain append-compatible and are
  // reported as incomplete by the replay projection.
  if (scopeIndexes.length === 0) return null;
  if (
    scopeIndexes.length !== 1 ||
    closureIndexes.length !== 1 ||
    scopeIndexes[0]! + 1 !== closureIndexes[0]
  ) {
    return {
      code: "SCOPE_RECORDED_BATCH_INVALID",
      message:
        "scope:recorded must sit immediately before exactly one EXECUTE.work → EXECUTE.done transition in the same batch",
      detail: {
        reason: "missing_or_non_adjacent_execute_closure",
        scope_indexes: scopeIndexes,
        closure_indexes: closureIndexes,
      },
    };
  }

  const fact = parseAdjacentFact(
    candidates[scopeIndexes[0]!]!,
    candidates[closureIndexes[0]!]!,
  );
  if (fact === null) {
    return {
      code: "SCOPE_RECORDED_BATCH_INVALID",
      message:
        "scope:recorded closure must be an actor-matched two-entry batch with indexes 0/1 and count 2",
      detail: { reason: "invalid_batch_envelope_or_actor" },
    };
  }
  if (fact.iteration !== expectedIteration) {
    return {
      code: "SCOPE_RECORDED_BATCH_INVALID",
      message: `scope:recorded iteration ${fact.iteration} does not match closing iteration ${expectedIteration}`,
      detail: {
        reason: "iteration_mismatch",
        iteration: fact.iteration,
        expected_iteration: expectedIteration,
      },
    };
  }

  const history = parseScopeClosureFacts(priorEntries);
  if (history.facts.some((prior) => prior.iteration === expectedIteration)) {
    return {
      code: "SCOPE_RECORDED_ITERATION_DUPLICATE",
      message: `scope:recorded already exists for iteration ${expectedIteration}`,
      detail: { iteration: expectedIteration },
    };
  }
  return null;
}

export function findScopeClosureFact(
  entries: readonly JournalEntry[],
  iteration: number,
): ScopeClosureFact | null {
  return (
    parseScopeClosureFacts(entries).facts.find(
      (fact) => fact.iteration === iteration,
    ) ?? null
  );
}

export function buildScopeClosureEntries(
  actor: string,
  iteration: number,
  paths: readonly string[],
  at: string,
): Array<
  Omit<
    JournalEntry,
    "seq" | "entry_id" | "batch_id" | "batch_index" | "batch_count"
  >
> {
  return [
    {
      at,
      actor,
      entry_schema_version: 1,
      kind: "scope:recorded",
      payload: { iteration, paths: [...paths] },
    },
    {
      at,
      actor,
      entry_schema_version: 1,
      kind: "event:phase_advanced",
      payload: { from: "EXECUTE.work", to: "EXECUTE.done" },
    },
  ];
}
