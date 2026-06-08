// W6 — schema mirror-drift gate.
//
// docs/schemas.ts is the declared Zod source of truth; the runtime
// src/core/*-schema.ts files are hand-copied mirrors of a subset (their
// headers literally say "mirror docs/schemas.ts §N"). Nothing enforced that
// the copies stay in lockstep — a drift in any closed enum would compile clean
// and ship. This gate asserts each runtime mirror enum's value set equals its
// docs/schemas.ts counterpart, converting reviewer discipline into a test.
//
// Scope: closed `z.enum` value sets only (the drift class that silently bypasses
// invariants). Shapes/refines are out of scope — those have their own tests.

import { describe, expect, test } from "vitest";

import * as docs from "../../docs/schemas.js";
import {
  EvidenceKind as RtEvidenceKind,
  EvidenceResult as RtEvidenceResult,
  VerifyCheckKind as RtVerifyCheckKind,
} from "../../src/core/evidence-schema.js";
import {
  FindingCategory as RtFindingCategory,
  FindingAction as RtFindingAction,
  FindingActionRisk as RtFindingActionRisk,
} from "../../src/core/finding-schema.js";
import {
  ApplicabilityPayload as RtApplicability,
  StepStatusPayload as RtStepStatus,
} from "../../src/core/task-schema.js";
import {
  GateName as RtGateName,
  PendingPromptKind as RtPendingPromptKind,
} from "../../src/core/journal-entry.js";

type ZEnum = { options: readonly string[] };

// runtime mirror ↔ docs/schemas.ts canonical. Add a row whenever a new closed
// enum is mirrored into the runtime.
const PAIRS: Array<{ name: string; runtime: ZEnum; canonical: ZEnum }> = [
  { name: "EvidenceKind", runtime: RtEvidenceKind, canonical: docs.EvidenceKind },
  { name: "EvidenceResult", runtime: RtEvidenceResult, canonical: docs.EvidenceResult },
  { name: "VerifyCheckKind", runtime: RtVerifyCheckKind, canonical: docs.VerifyCheckKind },
  { name: "FindingCategory", runtime: RtFindingCategory, canonical: docs.FindingCategory },
  { name: "FindingAction", runtime: RtFindingAction, canonical: docs.FindingAction },
  { name: "FindingActionRisk", runtime: RtFindingActionRisk, canonical: docs.FindingActionRisk },
  { name: "Applicability", runtime: RtApplicability, canonical: docs.Applicability },
  { name: "StepStatus", runtime: RtStepStatus, canonical: docs.StepStatus },
  { name: "GateName", runtime: RtGateName, canonical: docs.GateName },
  { name: "PendingPromptKind", runtime: RtPendingPromptKind, canonical: docs.PendingPromptKind },
];

describe("W6 — runtime schema mirrors match docs/schemas.ts source of truth", () => {
  for (const { name, runtime, canonical } of PAIRS) {
    test(`${name} enum value set is in lockstep`, () => {
      // Order-insensitive set equality: the runtime mirror must enumerate
      // exactly the canonical value set — no missing, no extra.
      expect([...runtime.options].sort()).toEqual([...canonical.options].sort());
    });
  }

  test("every pair references a defined canonical enum (no typo'd import)", () => {
    for (const { name, canonical } of PAIRS) {
      expect(Array.isArray(canonical.options), `${name} canonical .options`).toBe(true);
    }
  });
});
