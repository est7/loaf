import { describe, expect, test } from "vitest";

import * as docs from "../../docs/schemas.js";
import {
  emitArtifactSchema,
  emitInputSchema,
  formatSchema,
  type ArtifactSchemaKind,
} from "../../src/cli/schema-emit.js";
import {
  EvidenceAddInput as RuntimeEvidenceAddInput,
  EvidenceFullPayload as RuntimeEvidenceFullPayload,
} from "../../src/core/evidence-schema.js";
import {
  Ceremony as RuntimeCeremony,
  JournalEntry as RuntimeJournalEntry,
} from "../../src/core/journal-entry.js";
import {
  RequirementEarsShape as RuntimeRequirementEarsShape,
  RequirementEarsVerifiable as RuntimeRequirementEarsVerifiable,
  SpecFrontmatter as RuntimeSpecFrontmatter,
  VisualContract as RuntimeVisualContract,
} from "../../src/core/spec-schema.js";

const BASE_EVIDENCE = {
  kind: "local-check" as const,
  iteration: 1,
  actor: "cli:loaf",
  result: "passed" as const,
  summary: "current schema divergence fixture",
};

describe("schemas dissolution divergence characterization", () => {
  test("evidence full schemas use evidence_id in docs and id at runtime", () => {
    const docsFixture = {
      ...BASE_EVIDENCE,
      schema_version: 2,
      evidence_id: "EV-000001",
      at: "2026-07-16T08:19:00.000Z",
    };
    const runtimeFixture = { ...BASE_EVIDENCE, id: "EV-000001" };

    expect(docs.EvidenceEntry.safeParse(docsFixture).success).toBe(true);
    expect(RuntimeEvidenceFullPayload.safeParse(docsFixture).success).toBe(false);
    expect(RuntimeEvidenceFullPayload.safeParse(runtimeFixture).success).toBe(true);
    expect(docs.EvidenceEntry.safeParse(runtimeFixture).success).toBe(false);
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

  test("Ceremony accepts an empty object with defaults only in docs", () => {
    const docsResult = docs.Ceremony.safeParse({});

    expect(docsResult.success).toBe(true);
    if (docsResult.success) {
      expect(docsResult.data).toEqual({
        spec_phase: false,
        verify_phase: false,
        settle_phase: false,
        strict_spec_review: false,
        lessons_required: "skip",
        strict_drift_check: false,
      });
    }
    expect(RuntimeCeremony.safeParse({}).success).toBe(false);
  });

  test("JournalEntry accepts the reserved signature field only in docs", () => {
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

    expect(docs.JournalEntry.safeParse(fixture).success).toBe(true);
    expect(RuntimeJournalEntry.safeParse(fixture).success).toBe(false);
  });
});

describe("current public schema output baseline", () => {
  const inputSurfaces: Array<Parameters<typeof emitInputSchema>[0]> = [
    "spec:add-req",
    "spec:add-scenario",
    "spec:add-visual",
    "tasks:add",
    "evidence:add",
  ];

  test.each(inputSurfaces)("input:%s", (surface) => {
    expect(formatSchema(emitInputSchema(surface))).toMatchSnapshot();
  });

  const artifactSurfaces: ArtifactSchemaKind[] = ["spec", "tasks", "evidence", "finding", "state"];

  test.each(artifactSurfaces)("artifact:%s", (surface) => {
    expect(formatSchema(emitArtifactSchema(surface))).toMatchSnapshot();
  });
});
