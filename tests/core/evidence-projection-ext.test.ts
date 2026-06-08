// evidence-projection-ext — Slice 1.C sub-cycle 1.
//
// EvidenceState projection ext + EvidenceFullPayload strict refines.
//
// Adds 3 new projection fields (check / reason / attachments) per codex Q2 lock
// (Slice 1.C r33). Backs verify-accept gate check 1 (lane-status via
// EvidenceEntry.check) + check 3 (canSatisfy reason/attachments) without
// reading journal payload at gate time (preserves projection layering).
//
// New module src/core/evidence-schema.ts mirrors docs/schemas.ts §4/§6/§16
// (EvidenceKind / EvidenceResult / VerifyCheckKind / Attachment +
// EvidenceFullPayload strict). Parallels spec-schema.ts (1.B 2) +
// task-schema.ts (1.B 3a) neutral module placement so verify-accept-check
// + evidence-compat + journal-entry import without circular dep.

import { describe, expect, test } from "vitest";
import { ZodError } from "zod";

import {
  EvidenceFullPayload,
  EvidenceKind,
  EvidenceResult,
  VerifyCheckKind,
  AttachmentPayload,
} from "../../src/core/evidence-schema.js";
import { apply, initialSnapshot } from "../../src/core/reducer.js";
import type { EvidenceState, Snapshot } from "../../src/core/reducer.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";

const SHA = "a".repeat(64);

// Codex r34 BLOCK 2 fix: EvidenceFullPayload is now strict full mirror.
// Required fields: id / kind / iteration / actor / result / summary.
// Helper applies overrides so each test states only what it cares about.
function fullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "EV-000099",
    kind: "local-check",
    iteration: 1,
    actor: "cli:loaf",
    result: "passed",
    summary: "stub local-check evidence summary",
    ...overrides,
  };
}

function ev(
  payload: Record<string, unknown>,
  overrides: Partial<JournalEntry> = {},
): JournalEntry {
  return {
    seq: 0,
    entry_id: "JE-000001",
    at: "2026-05-17T10:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
    kind: "evidence:added",
    payload,
    ...overrides,
  };
}

// A reducer-ready snapshot pre-positioned at EXECUTE.work where
// evidence:added is sub_state-legal per PER_KIND_SUB_STATE.
function execSnapshot(): Snapshot {
  const base = initialSnapshot();
  return {
    ...base,
    state: {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "F-001",
      phase: "EXECUTE",
      sub_state: "EXECUTE.work",
      iteration: 1,
      spec_locked: true,
      verify_accepted: false,
      spec_version: 1,
      ceremony: {
        spec_phase: true,
        verify_phase: true,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      },
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Module mirror — protocol-level enums are co-located, not re-exported
// from docs/schemas.ts to keep runtime import-graph free of doc files.
// ───────────────────────────────────────────────────────────────────────

describe("evidence-schema enums (docs/schemas.ts §4/§6 mirror)", () => {
  test("EvidenceKind enum lists protocol §6 kinds", () => {
    expect(EvidenceKind.options).toEqual([
      "task-summary",
      "verify-review",
      "spec-review",
      "acceptance",
      "visual-review",
      "gate-decision",
      "local-check",
      "manual",
      "waiver",
      "spike-finding",
    ]);
  });

  test("EvidenceResult enum lists protocol §6 results", () => {
    expect(EvidenceResult.options).toEqual([
      "passed",
      "failed",
      "approved",
      "rejected",
      "waived",
    ]);
  });

  test("VerifyCheckKind enum lists protocol §4 lanes", () => {
    expect(VerifyCheckKind.options).toEqual([
      "run",
      "review",
      "acceptance",
      "visual",
    ]);
  });

  test("AttachmentPayload requires path min 3 + sha256 64-hex + mime min 3", () => {
    expect(() => AttachmentPayload.parse({ path: "x", sha256: SHA, mime: "image/png" })).toThrow(
      ZodError,
    );
    expect(() => AttachmentPayload.parse({ path: "screenshot.png", sha256: "short", mime: "image/png" })).toThrow(
      ZodError,
    );
    expect(() => AttachmentPayload.parse({ path: "screenshot.png", sha256: SHA, mime: "x" })).toThrow(
      ZodError,
    );
    const ok = AttachmentPayload.parse({
      path: "screenshot.png",
      sha256: SHA,
      mime: "image/png",
      bytes: 1024,
    });
    expect(ok).toEqual({ path: "screenshot.png", sha256: SHA, mime: "image/png", bytes: 1024 });
  });
});

// ───────────────────────────────────────────────────────────────────────
// Strict payload refines — manual/waiver actor+reason; visual-review
// attachments. These are runtime invariants the journal append layer
// enforces (PER_KIND_PAYLOAD lookup), independent of reducer extract.
// ───────────────────────────────────────────────────────────────────────

describe("EvidenceFullPayload — happy paths", () => {
  test("local-check with required fields only parses (default covers=[])", () => {
    const parsed = EvidenceFullPayload.parse(fullPayload({ id: "EV-000001" }));
    expect(parsed.id).toBe("EV-000001");
    expect(parsed.kind).toBe("local-check");
    expect(parsed.covers).toEqual([]);
  });

  test("full body with all optional fields parses (visual-review)", () => {
    const parsed = EvidenceFullPayload.parse(
      fullPayload({
        id: "EV-000002",
        kind: "visual-review",
        result: "approved",
        covers: ["VIS-AUTH-001"],
        actor: "human:reviewer@example.com",
        check: "visual",
        attachments: [{ path: "shot.png", sha256: SHA, mime: "image/png" }],
      }),
    );
    expect(parsed.check).toBe("visual");
    expect(parsed.attachments).toHaveLength(1);
  });

  test("manual evidence with human actor + reason ≥10 chars parses", () => {
    const parsed = EvidenceFullPayload.parse(
      fullPayload({
        id: "EV-000003",
        kind: "manual",
        actor: "human:tester@example.com",
        reason: "tested the flow by hand on staging",
        covers: ["REQ-AUTH-001"],
      }),
    );
    expect(parsed.kind).toBe("manual");
  });

  test("gate-decision evidence with based_on + decided_by parses", () => {
    const parsed = EvidenceFullPayload.parse(
      fullPayload({
        id: "EV-000004",
        kind: "gate-decision",
        actor: "human:reviewer@example.com",
        result: "approved",
        gate: "spec-lock",
        decided_by: "human:reviewer@example.com",
        based_on: { spec: 1, tasks: 1 },
      }),
    );
    expect(parsed.gate).toBe("spec-lock");
    expect(parsed.based_on?.spec).toBe(1);
  });

  // Slice 1.C sub-cycle 1 r35 optional polish: summary accepts LongTextField
  // inline (pre-promote) + sidecar (post-promote) per docs/schemas.ts §0a
  // LongTextField discriminated union. Documents the intentional divergence
  // from docs §16:1712 (`summary: z.string().min(3)`) for the sidecar
  // promotion model wire (journal-mutate Pass 2).
  test("summary as LongTextField inline (mode=inline + text) parses", () => {
    const parsed = EvidenceFullPayload.parse(
      fullPayload({
        id: "EV-000050",
        summary: { mode: "inline", text: "x".repeat(20_000) },
      }),
    );
    if (typeof parsed.summary === "string") {
      throw new Error("expected LongTextField inline form");
    }
    expect(parsed.summary.mode).toBe("inline");
  });

  test("summary as LongTextField sidecar (mode=sidecar + ref) parses", () => {
    const parsed = EvidenceFullPayload.parse(
      fullPayload({
        id: "EV-000051",
        summary: {
          mode: "sidecar",
          ref: { path: "attachments/JE-000010/summary.txt", sha256: SHA, size: 12345 },
        },
      }),
    );
    if (typeof parsed.summary === "string") {
      throw new Error("expected LongTextField sidecar form");
    }
    expect(parsed.summary.mode).toBe("sidecar");
  });
});

describe("EvidenceFullPayload — strict mode rejects unknown keys (codex r34)", () => {
  test("rejects unknown payload key", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000005", bogus_field: "x" })),
    ).toThrow(ZodError);
  });

  test("rejects misspelled known key", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000006", task_ID: "T-001" })),
    ).toThrow(ZodError);
  });
});

describe("EvidenceFullPayload — required fields reject missing", () => {
  test("rejects missing iteration", () => {
    const payload = fullPayload({ id: "EV-000010" });
    delete payload.iteration;
    expect(() => EvidenceFullPayload.parse(payload)).toThrow(ZodError);
  });

  test("rejects missing actor", () => {
    const payload = fullPayload({ id: "EV-000011" });
    delete payload.actor;
    expect(() => EvidenceFullPayload.parse(payload)).toThrow(ZodError);
  });

  test("rejects missing result", () => {
    const payload = fullPayload({ id: "EV-000012" });
    delete payload.result;
    expect(() => EvidenceFullPayload.parse(payload)).toThrow(ZodError);
  });

  test("rejects summary < 3 chars", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000013", summary: "ok" })),
    ).toThrow(ZodError);
  });
});

describe("EvidenceFullPayload — strict refines reject invalid bodies", () => {
  test("rejects id not matching EV-\\d{6,}", () => {
    expect(() => EvidenceFullPayload.parse(fullPayload({ id: "EV-1" }))).toThrow(
      ZodError,
    );
  });

  test("rejects unknown kind", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000020", kind: "made-up" })),
    ).toThrow(ZodError);
  });

  test("rejects unknown result enum", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000021", result: "bogus" })),
    ).toThrow(ZodError);
  });

  test("rejects unknown check lane", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000022", check: "security" })),
    ).toThrow(ZodError);
  });

  test("rejects unknown gate name", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000023", gate: "bogus" })),
    ).toThrow(ZodError);
  });

  test("rejects task_id not matching T-\\d{3,}", () => {
    expect(() =>
      EvidenceFullPayload.parse(fullPayload({ id: "EV-000024", task_id: "T-1" })),
    ).toThrow(ZodError);
  });

  test("kind=manual without human:* actor fails refine", () => {
    expect(() =>
      EvidenceFullPayload.parse(
        fullPayload({
          id: "EV-000030",
          kind: "manual",
          actor: "cli:loaf",
          reason: "tested the flow by hand",
        }),
      ),
    ).toThrow(ZodError);
  });

  test("kind=manual with human:* actor but reason < 10 chars fails refine", () => {
    expect(() =>
      EvidenceFullPayload.parse(
        fullPayload({
          id: "EV-000031",
          kind: "manual",
          actor: "human:tester@example.com",
          reason: "short",
        }),
      ),
    ).toThrow(ZodError);
  });

  test("kind=manual with result=waived fails refine", () => {
    const parsed = EvidenceFullPayload.safeParse(
      fullPayload({
        id: "EV-000035",
        kind: "manual",
        result: "waived",
        actor: "human:tester@example.com",
        reason: "manual review waived with enough context",
      }),
    );

    expect(parsed.success).toBe(false);
    if (parsed.success) {
      throw new Error("expected manual+waived evidence to be rejected");
    }
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      "evidence kind=manual must not carry result=waived; use kind=waiver",
    );
  });

  test("kind=waiver with human:* actor but missing reason fails refine", () => {
    const payload = fullPayload({
      id: "EV-000032",
      kind: "waiver",
      actor: "human:tester@example.com",
    });
    delete payload.reason;
    expect(() => EvidenceFullPayload.parse(payload)).toThrow(ZodError);
  });

  test("kind=visual-review without attachments fails refine", () => {
    expect(() =>
      EvidenceFullPayload.parse(
        fullPayload({
          id: "EV-000033",
          kind: "visual-review",
          actor: "human:reviewer@example.com",
        }),
      ),
    ).toThrow(ZodError);
  });

  test("kind=visual-review with attachments=[] fails refine", () => {
    expect(() =>
      EvidenceFullPayload.parse(
        fullPayload({
          id: "EV-000034",
          kind: "visual-review",
          actor: "human:reviewer@example.com",
          attachments: [],
        }),
      ),
    ).toThrow(ZodError);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Reducer projection ext — the 3 new EvidenceState fields land on the
// snapshot when present in the journal payload, and stay undefined for
// backward-compat minimal payloads.
// ───────────────────────────────────────────────────────────────────────

describe("reducer evidence:added — projection extracts new fields", () => {
  test("minimal full payload yields slim projection (no check/reason/attachments)", () => {
    const snap = execSnapshot();
    const result = apply(snap, ev(fullPayload({ id: "EV-000020" })));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.evidence).toHaveLength(1);
    const e: EvidenceState = result.snapshot.evidence[0]!;
    expect(e.id).toBe("EV-000020");
    expect(e.kind).toBe("local-check");
    expect(e.covers).toEqual([]);
    expect(e.actor).toBe("cli:loaf");
    expect(e.check).toBeUndefined();
    expect(e.reason).toBeUndefined();
    expect(e.attachments).toBeUndefined();
  });

  test("check field extracted into projection", () => {
    const snap = execSnapshot();
    const result = apply(
      snap,
      ev(
        fullPayload({
          id: "EV-000021",
          kind: "verify-review",
          check: "review",
          result: "approved",
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.evidence[0]!.check).toBe("review");
    expect(result.snapshot.evidence[0]!.result).toBe("approved");
  });

  test("reason field extracted (for manual/waiver evidence)", () => {
    const snap = execSnapshot();
    const result = apply(
      snap,
      ev(
        fullPayload({
          id: "EV-000022",
          kind: "manual",
          actor: "human:tester@example.com",
          reason: "tested the flow by hand on staging",
          covers: ["REQ-AUTH-001"],
        }),
        { actor: "human:tester@example.com" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.evidence[0]!.reason).toBe("tested the flow by hand on staging");
    expect(result.snapshot.evidence[0]!.actor).toBe("human:tester@example.com");
  });

  test("attachments field extracted (for visual-review)", () => {
    const snap = execSnapshot();
    const attachments = [{ path: "shot.png", sha256: SHA, mime: "image/png", bytes: 2048 }];
    const result = apply(
      snap,
      ev(
        fullPayload({
          id: "EV-000023",
          kind: "visual-review",
          actor: "human:reviewer@example.com",
          covers: ["VIS-AUTH-001"],
          check: "visual",
          result: "approved",
          attachments,
        }),
        { actor: "human:reviewer@example.com" },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.snapshot.evidence[0]!.attachments).toEqual(attachments);
  });

  test("multiple evidence entries accumulate independently", () => {
    let snap = execSnapshot();
    const r1 = apply(
      snap,
      ev(
        fullPayload({
          id: "EV-000024",
          kind: "local-check",
          check: "run",
          result: "passed",
        }),
      ),
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("unreachable");
    snap = r1.snapshot;
    const r2 = apply(
      { ...snap, evidence: [...snap.evidence] },
      ev(
        fullPayload({
          id: "EV-000025",
          kind: "task-summary",
          covers: ["T-001"],
        }),
        { seq: 1, entry_id: "JE-000002" },
      ),
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("unreachable");
    expect(r2.snapshot.evidence).toHaveLength(2);
    expect(r2.snapshot.evidence[0]!.id).toBe("EV-000024");
    expect(r2.snapshot.evidence[0]!.check).toBe("run");
    expect(r2.snapshot.evidence[1]!.id).toBe("EV-000025");
    expect(r2.snapshot.evidence[1]!.check).toBeUndefined();
  });

  test("payload missing id rejects with INVALID_PAYLOAD (preflight schema gate)", () => {
    const snap = execSnapshot();
    const payload = fullPayload({});
    delete payload.id;
    const result = apply(snap, ev(payload));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("INVALID_PAYLOAD");
  });
});
