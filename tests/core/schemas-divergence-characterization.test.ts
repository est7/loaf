import { describe, expect, test } from "vitest";

import * as docs from "../../docs/schemas.js";
import {
  emitArtifactSchema,
  emitInputSchema,
  formatSchema,
  type ArtifactSchemaKind,
} from "../../src/cli/schema-emit.js";
import { INPUT_SCHEMAS } from "../../src/cli/input-schemas.js";
import {
  EvidenceAddInput as RuntimeEvidenceAddInput,
  EvidenceAddInputBatched as RuntimeEvidenceAddInputBatched,
  EvidenceFullPayload as RuntimeEvidenceFullPayload,
} from "../../src/core/evidence-schema.js";
import { EvidenceEntry as RuntimeEvidenceEntry } from "../../src/core/projection-schema.js";
import {
  BatchId as RuntimeBatchId,
  Ceremony as RuntimeCeremony,
  CeremonyLabel as RuntimeCeremonyLabel,
  JournalEntry as RuntimeJournalEntry,
  Phase as RuntimePhase,
  SignatureEnvelope as RuntimeSignatureEnvelope,
} from "../../src/core/journal-entry.js";
import {
  RequirementEarsShape as RuntimeRequirementEarsShape,
  RequirementEarsVerifiable as RuntimeRequirementEarsVerifiable,
  SpecAddReqInput,
  SpecAddScenarioInput,
  SpecAddVisualInput,
  SpecFrontmatter as RuntimeSpecFrontmatter,
  VisualContract as RuntimeVisualContract,
} from "../../src/core/spec-schema.js";
import { TaskInputBatched } from "../../src/core/task-schema.js";

const BASE_EVIDENCE = {
  kind: "local-check" as const,
  iteration: 1,
  actor: "cli:loaf",
  result: "passed" as const,
  summary: "current schema divergence fixture",
};

describe("schemas dissolution divergence characterization", () => {
  test("EvidenceEntry converges on the runtime projection schema", () => {
    const fixture = {
      ...BASE_EVIDENCE,
      schema_version: 2,
      id: "EV-000001",
      at: "2026-07-16T08:19:00.000Z",
    };

    expect(docs.EvidenceEntry).toBe(RuntimeEvidenceEntry);
    expect(docs.EvidenceEntry.safeParse(fixture).success).toBe(true);
    expect(RuntimeEvidenceEntry.safeParse(fixture).success).toBe(true);
    expect(RuntimeEvidenceFullPayload.safeParse(BASE_EVIDENCE).success).toBe(false);
  });

  test("evidence add input converges on the runtime sidecar-capable schema", () => {
    const fixture = {
      ...BASE_EVIDENCE,
      summary: {
        mode: "sidecar" as const,
        ref: {
          path: "attachments/JE-000001/summary.txt",
          sha256: "a".repeat(64),
          size: 42,
        },
      },
    };

    expect(docs.EvidenceAddInput).toBe(RuntimeEvidenceAddInput);
    expect(docs.EvidenceAddInput.safeParse(fixture).success).toBe(true);
    expect(RuntimeEvidenceAddInput.safeParse(fixture).success).toBe(true);
  });

  test("VisualContract converges on runtime passthrough behavior", () => {
    const fixture = {
      id: "VIS-UI-001",
      target: "settings screen",
      checks: ["matches approved layout"],
      adr_refs: ["ADR-0042"],
    };

    const docsResult = docs.VisualContract.safeParse(fixture);
    const runtimeResult = RuntimeVisualContract.safeParse(fixture);

    expect(docs.VisualContract).toBe(RuntimeVisualContract);
    expect(docsResult.success).toBe(true);
    expect(runtimeResult.success).toBe(true);
    if (docsResult.success && runtimeResult.success) {
      expect(docsResult.data).toHaveProperty("adr_refs", ["ADR-0042"]);
      expect(runtimeResult.data).toHaveProperty("adr_refs", ["ADR-0042"]);
    }
  });

  test("SpecFrontmatter converges on runtime-required adr_refs", () => {
    const fixture = {
      schema_version: 2,
      spec_version: 1,
      feature: { id: "F-001", name: "Schema dissolution" },
      intent: "Characterize the current duplicated schema behavior.",
      requirements: [],
      scenarios: [],
      needs_clarification: [],
    };

    const docsResult = docs.SpecFrontmatter.safeParse(fixture);
    expect(docs.SpecFrontmatter).toBe(RuntimeSpecFrontmatter);
    expect(docsResult.success).toBe(false);
    expect(RuntimeSpecFrontmatter.safeParse(fixture).success).toBe(false);
  });

  test("RequirementEars keeps the runtime structural and verifiable split", () => {
    const fixture = {
      id: "REQ-SCHEMA-001",
      type: "ubiquitous" as const,
      response: "The schema owner remains explicit.",
    };

    expect(docs.RequirementEars).toBe(RuntimeRequirementEarsVerifiable);
    expect(RuntimeRequirementEarsShape.safeParse(fixture).success).toBe(true);
    expect(RuntimeRequirementEarsVerifiable.safeParse(fixture).success).toBe(false);
  });

  test("Ceremony converges on the runtime six-field-required schema", () => {
    const docsResult = docs.Ceremony.safeParse({});

    expect(docs.Ceremony).toBe(RuntimeCeremony);
    expect(docsResult.success).toBe(false);
    expect(RuntimeCeremony.safeParse({}).success).toBe(false);
    expect(
      RuntimeCeremony.safeParse({
        spec_phase: false,
        verify_phase: false,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      }).success,
    ).toBe(true);
  });

  test("JournalEntry converges on the runtime signature-rejecting envelope", () => {
    const fixture = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-07-16T08:19:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started" as const,
      payload: {},
      signature: {
        alg: "ed25519",
        key_id: "key-1",
        sig: "base64-signature",
        signed_at: "2026-07-16T08:19:00.000Z",
      },
    };

    expect(docs.JournalEntry).toBe(RuntimeJournalEntry);
    expect(docs.JournalEntry.safeParse(fixture).success).toBe(false);
    expect(RuntimeJournalEntry.safeParse(fixture).success).toBe(false);
    const { signature: _, ...unsignedFixture } = fixture;
    expect(RuntimeJournalEntry.safeParse(unsignedFixture).success).toBe(true);
  });

  test("new journal-domain exports are owned by the runtime module", () => {
    expect(docs.BatchId).toBe(RuntimeBatchId);
    expect(docs.Phase).toBe(RuntimePhase);
    expect(docs.CeremonyLabel).toBe(RuntimeCeremonyLabel);
    expect(docs.SignatureEnvelope).toBe(RuntimeSignatureEnvelope);

    expect(RuntimeBatchId.safeParse("facade-only").success).toBe(false);
    expect(RuntimePhase.safeParse("EXECUTE").success).toBe(true);
    expect(RuntimePhase.safeParse("UNKNOWN").success).toBe(false);
    expect(RuntimeCeremonyLabel.safeParse("").success).toBe(true);
    expect(
      RuntimeSignatureEnvelope.safeParse({
        alg: "ed25519",
        key_id: "key-1",
        sig: "base64-signature",
        signed_at: "2026-07-16T08:19:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("current public schema output baseline", () => {
  // Tier 2 --schema output diff summary (wayfinder #6 sub-cycle 4):
  // - spec:add-req now publishes the runtime allocation boundary
  //   (id_namespace + EARS type, passthrough body) instead of a closed copy
  //   that required per-variant body + measurable/verifiability fields.
  // - spec:add-scenario now requires id_namespace + name and permits the
  //   scenario body consumed later, instead of falsely requiring given/when/then.
  // - spec:add-visual now requires id_namespace + target and permits the
  //   remaining body, instead of falsely requiring checks at this boundary.
  // - tasks:add switches oneOf to anyOf because the mutation path uses z.union;
  //   the six strict task variant shapes are otherwise unchanged.
  // - evidence:add adds the runtime summary union: string or inline/sidecar
  //   LongTextField (including path/sha256/size AttachmentRef metadata).
  // - artifact:spec/tasks/evidence/finding/state are unchanged.
  const inputSurfaces: Array<Parameters<typeof emitInputSchema>[0]> = [
    "spec:add-req",
    "spec:add-scenario",
    "spec:add-visual",
    "tasks:add",
    "evidence:add",
  ];

  test("input registry reuses the exact mutation-path schemas", () => {
    expect(INPUT_SCHEMAS["spec:add-req"]).toBe(SpecAddReqInput);
    expect(INPUT_SCHEMAS["spec:add-scenario"]).toBe(SpecAddScenarioInput);
    expect(INPUT_SCHEMAS["spec:add-visual"]).toBe(SpecAddVisualInput);
    expect(INPUT_SCHEMAS["tasks:add"]).toBe(TaskInputBatched);
    expect(INPUT_SCHEMAS["evidence:add"]).toBe(RuntimeEvidenceAddInputBatched);
  });

  test.each(inputSurfaces)("input:%s", (surface) => {
    expect(formatSchema(emitInputSchema(surface))).toMatchSnapshot();
  });

  const artifactSurfaces: ArtifactSchemaKind[] = ["spec", "tasks", "evidence", "finding", "state"];

  test.each(artifactSurfaces)("artifact:%s", (surface) => {
    expect(formatSchema(emitArtifactSchema(surface))).toMatchSnapshot();
  });
});
