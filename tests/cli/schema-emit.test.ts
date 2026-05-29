// Phase 16 SC-10 — pure tests for schema-emit module.
//
// Covers (codex r316 lock):
//   - 5 mutator input schemas — root anyOf, descendant has expected key
//   - 5 artifact projection schemas — root type=object + root properties
//   - $schema = draft-2020-12 on both surfaces
//   - hasPropertyDeep helper walks anyOf/allOf/oneOf/items/properties
//   - finding ↔ findings.json singular/plural mismatch preserved

import { describe, expect, test } from "vitest";

import {
  ARTIFACT_SCHEMA_KINDS,
  emitArtifactSchema,
  emitInputSchema,
  formatSchema,
  type ArtifactSchemaKind,
} from "../../src/cli/schema-emit.js";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

type JsonSchemaNode = Record<string, unknown>;

/** Recursive walk looking for any descendant `properties` block that
 *  contains the given key. Walks the standard JSON Schema combinators:
 *  properties / items / anyOf / oneOf / allOf. Returns true on first hit. */
function hasPropertyDeep(node: unknown, key: string): boolean {
  if (node === null || typeof node !== "object") return false;
  const obj = node as JsonSchemaNode;
  const props = obj["properties"];
  if (props !== undefined && typeof props === "object" && props !== null) {
    if (Object.prototype.hasOwnProperty.call(props, key)) return true;
    for (const v of Object.values(props as Record<string, unknown>)) {
      if (hasPropertyDeep(v, key)) return true;
    }
  }
  const items = obj["items"];
  if (items !== undefined && hasPropertyDeep(items, key)) return true;
  for (const combinator of ["anyOf", "oneOf", "allOf"] as const) {
    const arr = obj[combinator];
    if (Array.isArray(arr)) {
      for (const branch of arr) {
        if (hasPropertyDeep(branch, key)) return true;
      }
    }
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────
// Mutator input schemas (5) — root anyOf + descendant property assertion
// ───────────────────────────────────────────────────────────────────────
describe("emitInputSchema — 5 mutators with root anyOf (batchOrSingle)", () => {
  const expectations: Array<{
    key: Parameters<typeof emitInputSchema>[0];
    descendantKey: string;
  }> = [
    { key: "spec:add-req",      descendantKey: "id_namespace" },
    { key: "spec:add-scenario", descendantKey: "id_namespace" },
    { key: "spec:add-visual",   descendantKey: "id_namespace" },
    { key: "tasks:add",         descendantKey: "kind" },
    { key: "evidence:add",      descendantKey: "kind" },
  ];

  for (const { key, descendantKey } of expectations) {
    test(`${key}: $schema=draft-2020-12, root anyOf, descendant has ${descendantKey}`, () => {
      const schema = emitInputSchema(key) as JsonSchemaNode;
      expect(schema["$schema"]).toBe(DRAFT);
      expect(Array.isArray(schema["anyOf"])).toBe(true);
      expect(hasPropertyDeep(schema, descendantKey)).toBe(true);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Artifact projection schemas (5) — root type=object + root properties
// ───────────────────────────────────────────────────────────────────────
describe("emitArtifactSchema — 5 artifact kinds with root object schemas", () => {
  const expectations: Array<{
    kind: ArtifactSchemaKind;
    expectedRootProperty: string;
  }> = [
    { kind: "spec",     expectedRootProperty: "requirements" },
    { kind: "tasks",    expectedRootProperty: "tasks" },
    { kind: "evidence", expectedRootProperty: "evidence" },
    { kind: "finding",  expectedRootProperty: "findings" }, // PLURAL projection field
    { kind: "state",    expectedRootProperty: "phase" },
  ];

  for (const { kind, expectedRootProperty } of expectations) {
    test(`${kind}: $schema=draft-2020-12, root type=object, root.properties.${expectedRootProperty} defined`, () => {
      const schema = emitArtifactSchema(kind) as JsonSchemaNode;
      expect(schema["$schema"]).toBe(DRAFT);
      expect(schema["type"]).toBe("object");
      const props = schema["properties"] as JsonSchemaNode | undefined;
      expect(props).toBeDefined();
      expect(props![expectedRootProperty]).toBeDefined();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────
// Sanity — ARTIFACT_SCHEMA_KINDS canonical order
// ───────────────────────────────────────────────────────────────────────
describe("ARTIFACT_SCHEMA_KINDS — canonical 5 closed kinds per protocol §1947", () => {
  test("includes 5 kinds: spec / tasks / evidence / finding / state", () => {
    expect([...ARTIFACT_SCHEMA_KINDS]).toEqual([
      "spec",
      "tasks",
      "evidence",
      "finding",
      "state",
    ]);
  });

  test("excludes pending (intentional per protocol §1947)", () => {
    expect((ARTIFACT_SCHEMA_KINDS as readonly string[]).includes("pending")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────
// formatSchema — pretty-printed JSON, trailing newline
// ───────────────────────────────────────────────────────────────────────
describe("formatSchema — output formatting", () => {
  test("emits pretty-printed JSON ending with newline", () => {
    const schema = emitArtifactSchema("tasks");
    const out = formatSchema(schema);
    expect(out.endsWith("\n")).toBe(true);
    // Pretty-printed → contains 2-space indent under root brace
    expect(out).toContain('{\n  "$schema"');
    // Parses back to the same object (round-trip)
    expect(JSON.parse(out)).toEqual(schema);
  });
});

// ───────────────────────────────────────────────────────────────────────
// hasPropertyDeep helper — walks combinators correctly
// ───────────────────────────────────────────────────────────────────────
describe("hasPropertyDeep — schema walker", () => {
  test("finds property in direct .properties", () => {
    expect(hasPropertyDeep({ properties: { id: { type: "string" } } }, "id")).toBe(true);
  });

  test("finds property in anyOf branch", () => {
    expect(
      hasPropertyDeep(
        { anyOf: [{ properties: { a: {} } }, { properties: { b: {} } }] },
        "b",
      ),
    ).toBe(true);
  });

  test("finds property under items in array schema", () => {
    expect(
      hasPropertyDeep({ items: { properties: { tag: {} } } }, "tag"),
    ).toBe(true);
  });

  test("returns false when missing", () => {
    expect(hasPropertyDeep({ properties: { a: {} } }, "z")).toBe(false);
  });
});
