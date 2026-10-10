# Pending and finding intervention policy

`src/core/intervention-policy.ts` owns pending/finding decisions. It returns
structured diagnostics or data and performs no I/O, persistence, input mutation
or rendering. Its queries accept current readonly state; admission and batch
application supply the evolving snapshot rather than a cached initial sponsor.

| Responsibility | Owner | Consumers / retained boundary |
|---|---|---|
| Finding IDs/enums/payload shapes | finding-schema / journal-entry | Schema vocabulary and persisted formats stay unchanged |
| Pending head/live/FIFO/block/gate/escalation | intervention-policy | CLI, preflight, reducer, state/registry projection and next intent |
| Finding grid/reason/target/reset/deferral | intervention-policy | Raise/reset checks, gate/hook/verify disposition and CLI batch effects |
| Finding open/action sponsorship and closure eligibility | intervention-policy | Existing admission or reducer stages; closure keeps `unknown`, sponsorship keeps `not_found` |
| Back-edge source/target rules | reducer/transition | Core action effects query its target; kind-guards derives its ordered source sets |
| Task body/freshness/frozen progress | task-amend-policy and its task check orchestration | Sponsor checks precede amendment rights as before |
| General admission order and snapshot application | preflight / reducer | Owner checks run at existing positions; no new kind dispatcher |
| Rich pending provenance/schema serialization | projection-writer | Live queries preserve fields/order; writers strip only the existing resolved tag from live output |
| CLI input/actor/dispatch/allocation/batch shape | CLI | Same payloads, actor split, ordering, stdout and catalog failure outlet |
| TUI and Board presentation | Separate adapters/models | Both consume neutral livePending; translations, truncation, DTOs and HTTP responses remain separate |

Historical pending state retains resolved rows; FIFO means first unresolved.
Only current gate/profile heads block advance. All pending kinds require a next
intent; gate-at-cursor routing and soft binding are independent of advance
blockage. Gate reject never co-resolves. CLI handles structural absence before
constructing an entry; admission still reports wrong-kind gate/escalation at
its original position. Finding close and FIFO id mismatch remain reducer-stage.

Finding checks retain missing -> closed -> action mismatch; string versus array
`expected_action` is operation-specific. Raise preserves risk -> unusual reason
-> target mode/step/task -> spec-lock after general authority. Reset preserves
sponsor -> canonical step -> exact target -> task/step -> abandoned. Progress
preservation and task mutation rights remain in their existing owner.

The retirement removes the CLI FIX_RESET_STEP/BACK_EDGE_TARGET maps, schema-owned
policy exports, repeated pending history selection/live filtering, and repeated
sponsor/closure eligibility. No compatibility re-export or new diagnostics,
release identity, schema migration or shared presentation model is introduced.
Historical dissolution manifests retain their original migration destinations;
this document and active protocol/reference links identify current ownership.

`tests/core/intervention-policy-ownership.test.ts` is a bounded AST tripwire for
known declaration/query/eligibility forms and reverse runtime dependencies, not
semantic proof against every possible renamed implementation. It scans all
production source and contains failing synthetic counterexamples. Literal
policy, precedence, stage, byte differential and real CLI/journal witnesses
provide independent behavioral evidence. No exception baseline was added.

## Existing next-action reachability finding (unfixed)

A real journal can reach SPEC.design with spec_locked=true and no pending:
eight built CLI commands establish a standard ceremony, submit a valid empty
spec and a docs task graph, then the real spec-lock evaluator passes. A normal
single-entry `mutate()` of a human approved spec-lock gate commits; replay of
all nine entries yields that state. No append/admission/evaluator bypass or
snapshot flag injection is used. The built `loaf next --format=json --quiet`
then exits 1 with UNEXPECTED_ERROR and preserves journal bytes.

Cause: transitionOwnerFor skips the gate prompt when spec_locked is true, then
calls nextLegalTargets without passing that flag. That helper evaluates the
SPEC.design -> EXECUTE.plan guard without spec_locked, returns no targets, and
the non-terminal invariant throws. Ordinary CLI gate assembly also emits phase
advance in its atomic batch; this witness proves accepted core single-entry
mutation/replay reachability, not that normal completed CLI gate approval
leaves the intermediate cursor. This behavior predates the intervention refactor
and is a separate finding, intentionally not fixed by this change. The pre-C5
next builder at f866979 throws the identical exception on the same replayed
state; transition routing/guard behavior is unchanged by this refactor.

Session evidence: `/tmp/c5-slice4-invariant-reachability.json` and the retained
agent-created directory recorded there, containing journal, projections,
CLI setup transcript and crash log. Repair needs a separately authorized
next-action contract change; do not weaken the ownership/refactor checks or
silently change gate batching to hide this result.
