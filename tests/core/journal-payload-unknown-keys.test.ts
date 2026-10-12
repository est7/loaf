import { describe, expect, test } from "vitest";
import { z } from "zod";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PER_KIND_PAYLOAD } from "../../src/core/kind-registry.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import { SpecSubmitInput } from "../../src/core/spec-schema.js";
import { admissionPayloadFixtures } from "../helpers/admitted-entry-fixtures.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { appendMany } from "../../src/core/journal-append.js";
import { emptyMeta } from "../../src/core/snapshot.js";

// Walk the installed Zod graph rather than maintaining a second object list.
// Zod 4 refinements stay on the underlying object; effects/pipes expose children.
function objectNodes() {
  const seen = new Set<z.ZodTypeAny>();
  const objects: Array<{ schema: z.ZodObject; path: string }> = [];
  function visit(schema: z.ZodTypeAny, location: string) {
    if (seen.has(schema)) return;
    seen.add(schema);
    const def = schema._def as unknown as {
      type: string;
      innerType?: z.ZodTypeAny;
      element?: z.ZodTypeAny;
      options?: z.ZodTypeAny[];
      left?: z.ZodTypeAny;
      right?: z.ZodTypeAny;
      schema?: z.ZodTypeAny;
      in?: z.ZodTypeAny;
      out?: z.ZodTypeAny;
    };
    if (schema instanceof z.ZodObject) {
      objects.push({ schema, path: location });
      for (const [key, child] of Object.entries(schema.shape))
        visit(child as z.ZodTypeAny, `${location}.${key}`);
    } else if (def.type === "array") visit(def.element!, `${location}[]`);
    else if (def.type === "union")
      def.options!.forEach((child, index) => {
        visit(child, `${location}<${index}>`);
      });
    else if (def.type === "intersection") {
      visit(def.left!, `${location}<left>`);
      visit(def.right!, `${location}<right>`);
    } else if (
      ["optional", "nullable", "default", "prefault", "readonly", "nonoptional"].includes(def.type)
    )
      visit(def.innerType!, location);
    else if (def.type === "effects") visit(def.schema!, location);
    else if (def.type === "pipe") {
      visit(def.in!, location);
      visit(def.out!, location);
    } else if (
      ![
        "string",
        "number",
        "boolean",
        "literal",
        "enum",
        "never",
        "unknown",
        "any",
        "transform",
      ].includes(def.type)
    )
      throw new Error(`Unvisited schema type ${def.type} at ${location}`);
  }
  for (const [kind, schema] of Object.entries(PER_KIND_PAYLOAD)) visit(schema, `${kind}:$`);
  return objects;
}
function rejectsUnknown(schema: z.ZodObject): boolean {
  const result = schema.safeParse({ unknown_contract_key: true });
  // Missing required fields must not masquerade as unknown-key rejection.
  return (
    !result.success &&
    result.error.issues.some(
      (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("unknown_contract_key"),
    )
  );
}

describe("closed journal object keys", () => {
  test("every reachable object rejects unknown keys (60 distinct object nodes)", () => {
    const nodes = objectNodes();
    expect(nodes).toHaveLength(60);
    for (const node of nodes) expect(rejectsUnknown(node.schema), node.path).toBe(true);
  });

  test("pending declared fields are optional, with no new length/default rules", () => {
    const added = {
      ...(admissionPayloadFixtures["pending:added"] as object),
      options: [],
      task_id: "T-001",
    };
    expect(PER_KIND_PAYLOAD["pending:added"].parse(added)).toEqual(added);
    expect(
      PER_KIND_PAYLOAD["pending:added"].parse(admissionPayloadFixtures["pending:added"]),
    ).toEqual(admissionPayloadFixtures["pending:added"]);
    expect(PER_KIND_PAYLOAD["pending:resolved"].parse({ id: "PEND-0001", answer: "" })).toEqual({
      id: "PEND-0001",
      answer: "",
    });
    expect(PER_KIND_PAYLOAD["pending:resolved"].parse({ id: "PEND-0001" })).toEqual({
      id: "PEND-0001",
    });
  });

  test("whole-submit feature identity rejects unknown fields before stripping", () => {
    expect(
      SpecSubmitInput.safeParse({
        feature: { id: "F-001", name: "Feature", typo: true },
        intent: "The system shall preserve declared content",
      }).success,
    ).toBe(false);
  });

  test("invalid batch does not append; old invalid line fails replay without rewriting", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-closed-payload-"));
    const file = path.join(dir, "journal.jsonl");
    const started: JournalEntry = {
      seq: 0,
      entry_id: "JE-000001",
      at: "2026-10-10T00:00:00.000Z",
      actor: "cli:loaf",
      entry_schema_version: 1,
      kind: "session:started",
      payload: admissionPayloadFixtures["session:started"],
    };
    const invalid: JournalEntry = {
      ...started,
      seq: 1,
      entry_id: "JE-000002",
      kind: "pending:added",
      payload: { ...(admissionPayloadFixtures["pending:added"] as object), typo: true },
    };
    try {
      await fs.writeFile(file, "");
      await expect(
        appendMany(file, [started, invalid], emptyMeta(), { fsync: false }),
      ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
      expect(await fs.readFile(file, "utf8")).toBe("");
      const historical = JSON.stringify(started) + "\n" + JSON.stringify(invalid) + "\n";
      await fs.writeFile(file, historical);
      expect(await replayJournal(file)).toMatchObject({
        ok: false,
        code: "REDUCER_REJECTED",
        at_seq: 1,
        detail: { inner_code: "INVALID_PAYLOAD" },
      });
      expect(await fs.readFile(file, "utf8")).toBe(historical);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
