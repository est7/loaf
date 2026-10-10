import { admitEntry } from "../../src/core/entry-admission.js";
import { JournalEntry, type Ceremony } from "../../src/core/journal-entry.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { describe, expect, test } from "vitest";
import {
  pendingHead,
  pendingHeadIndex,
  livePending,
  checkPendingAdvance,
  planGatePending,
  checkPendingEscalation,
  resolvePending,
  pendingResolutionOwner,
} from "../../src/core/intervention-policy.js";
import type { PendingState } from "../../src/core/projection-types.js";

const kinds = [
  "ask_user_question",
  "gate_decision",
  "spec_clarification",
  "finding_decision",
  "profile_escalation",
] as const;
const prefix: PendingState = { id: "PEND-0001", kind: "gate_decision", resolved: true };
const row = (kind: string, id = "PEND-0002"): PendingState => ({ id, kind, resolved: false });

describe("pending intervention policy", () => {
  test("empty and fully resolved history has no head or live rows", () => {
    for (const rows of [[], [prefix]]) {
      expect(pendingHeadIndex(rows)).toBe(-1);
      expect(pendingHead(rows)).toBeUndefined();
      expect(livePending(rows)).toEqual([]);
      expect(checkPendingAdvance(rows)).toBeNull();
      expect(resolvePending(rows, "PEND-0002")).toEqual({
        ok: false,
        code: "PENDING_NOT_FOUND",
        detail: { reason: "no pending head" },
      });
    }
  });
  test("first unresolved preserves rich fields, identity and order without mutating input", () => {
    const first = {
      pending_id: "PEND-0002",
      kind: "ask_user_question",
      resolved: false,
      question: "keep",
      options: ["b", "a"],
    };
    const later = { ...first, pending_id: "PEND-0003", kind: "profile_escalation" };
    const rows = [{ ...first, pending_id: "PEND-0001", resolved: true }, first, later];
    const bytes = JSON.stringify(rows);
    expect(pendingHeadIndex(rows)).toBe(1);
    expect(pendingHead(rows)).toBe(first);
    const live = livePending(rows);
    expect(live).toEqual([first, later]);
    expect(live[0]).toBe(first);
    expect(live[1]).toBe(later);
    expect(JSON.stringify(rows)).toBe(bytes);
  });
  for (const kind of kinds) {
    test(`${kind}: only current gate/profile head blocks advance`, () => {
      const rows = [prefix, row(kind), row("gate_decision", "PEND-0003")];
      expect(checkPendingAdvance(rows)).toEqual(
        kind === "gate_decision" || kind === "profile_escalation"
          ? { code: "PENDING_BLOCKS_ADVANCE", detail: { pending_id: "PEND-0002", kind } }
          : null,
      );
    });
    test(`${kind}: gate approval soft binding and reject bypass`, () => {
      const head = row(kind),
        rows = [prefix, head, row("gate_decision", "PEND-0003")];
      for (const gate of ["spec-lock", "verify-accept"] as const) {
        const plan = planGatePending(rows, gate, "approved");
        expect(plan).toEqual(
          kind === "gate_decision"
            ? { ok: true, resolutionHead: head }
            : {
                ok: false,
                code: "GATE_NOT_PENDING",
                detail: { gate_kind: gate, head_id: head.id, head_kind: kind },
              },
        );
        if (plan.ok) expect(plan.resolutionHead).toBe(head);
        expect(planGatePending(rows, gate, "rejected")).toEqual({
          ok: true,
          resolutionHead: undefined,
        });
      }
    });
    test(`${kind}: escalation checks retain TRIAGE exemption and actual_head`, () => {
      const rows = [prefix, row(kind), row("profile_escalation", "PEND-0003")];
      for (const state of ["TRIAGE.score", "TRIAGE.confirm"] as const)
        expect(checkPendingEscalation(rows, state)).toBeNull();
      expect(checkPendingEscalation(rows, "EXECUTE.work")).toEqual(
        kind === "profile_escalation"
          ? null
          : { code: "ESCALATION_NOT_PENDING", detail: { actual_head: kind } },
      );
    });
    test(`${kind}: next intent covers all kinds without strengthening advance blockers`, () => {
      expect(pendingResolutionOwner(kind, "spec-lock")).toEqual(
        kind === "gate_decision"
          ? { owner: "gate decide", gate: "spec-lock" }
          : { owner: kind === "profile_escalation" ? "profile escalate" : "pending resolve" },
      );
      expect(pendingResolutionOwner(kind, null)).toEqual({
        owner: kind === "profile_escalation" ? "profile escalate" : "pending resolve",
      });
    });
  }
  test("gate absence is allowed while non-TRIAGE escalation absence is rejected", () => {
    expect(planGatePending([], "spec-lock", "approved")).toEqual({
      ok: true,
      resolutionHead: undefined,
    });
    expect(checkPendingEscalation([], "EXECUTE.work")).toEqual({
      code: "ESCALATION_NOT_PENDING",
      detail: { actual_head: "(none)" },
    });
    expect(checkPendingEscalation([], "TRIAGE.confirm")).toBeNull();
  });
  test("FIFO mismatch retains exact detail; success retains history and promotes the next head", () => {
    const head = row("ask_user_question"),
      later = row("gate_decision", "PEND-0003");
    const rows = [prefix, head, later];
    const bytes = JSON.stringify(rows);
    expect(resolvePending(rows, later.id)).toEqual({
      ok: false,
      code: "PENDING_NOT_FOUND",
      detail: { reason: "id=PEND-0003 does not match head id=PEND-0002 (FIFO violation)" },
    });
    expect(resolvePending(rows, "PEND-0999")).toEqual({
      ok: false,
      code: "PENDING_NOT_FOUND",
      detail: { reason: "id=PEND-0999 does not match head id=PEND-0002 (FIFO violation)" },
    });
    const result = resolvePending(rows, head.id);
    expect(result).toEqual({ ok: true, pending: [prefix, { ...head, resolved: true }, later] });
    if (!result.ok) throw new Error("expected resolved head");
    expect(pendingHead(result.pending)).toBe(later);
    expect(result.pending[0]).toBe(prefix);
    expect(JSON.stringify(rows)).toBe(bytes);
  });
});

test("FIFO failure remains reducer-stage after successful admission and leaves snapshot unchanged", () => {
  const ceremony: Ceremony = {
    spec_phase: true,
    verify_phase: true,
    settle_phase: false,
    strict_spec_review: false,
    lessons_required: "skip",
    strict_drift_check: false,
  };
  for (const pending of [[], [prefix, row("ask_user_question")]]) {
    const snapshot: Snapshot = {
      ...initialSnapshot(),
      state: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        feature: "witness",
        phase: "EXECUTE",
        sub_state: "EXECUTE.work",
        iteration: 1,
        spec_locked: true,
        verify_accepted: false,
        spec_version: 1,
        ceremony,
      },
      pending,
    };
    const entry = JournalEntry.parse({
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-05-28T11:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "pending:resolved",
      payload: { id: "PEND-0003", answer: "witness" },
    });
    const bytes = JSON.stringify(snapshot);
    expect(preflight(entry, { snapshot }).ok).toBe(true);
    expect(admitEntry(snapshot, entry)).toEqual({
      ok: false,
      stage: "reducer",
      code: "PENDING_NOT_FOUND",
      detail: {
        reason:
          pending.length === 0
            ? "no pending head"
            : "id=PEND-0003 does not match head id=PEND-0002 (FIFO violation)",
      },
    });
    expect(JSON.stringify(snapshot)).toBe(bytes);
  }
});
