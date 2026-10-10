import { describe, expect, test, vi } from "vitest";
import { admitEntry } from "../../src/core/entry-admission.js";
import { initialSnapshot, type Snapshot } from "../../src/core/reducer.js";
import { preflight } from "../../src/core/reducer/preflight.js";
import { PER_KIND_PAYLOAD } from "../../src/core/kind-registry.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import { composeSpecMdFrontmatter } from "../../src/core/spec-projection.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mutate, type MutateContext } from "../../src/core/journal-mutate.js";
import { replayJournal } from "../../src/core/journal-bootstrap.js";
import { emptyMeta, SnapshotMeta } from "../../src/core/snapshot.js";
import { main } from "../../src/cli.js";
import { admissionPayloadFixtures } from "../helpers/admitted-entry-fixtures.js";
import type { EntryKind } from "../../src/core/journal-entry.js";

const ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip" as const,
  strict_drift_check: false,
};
function entry(kind: JournalEntry["kind"], payload: unknown): JournalEntry {
  return {
    kind,
    payload,
    seq: 1,
    entry_id: "JE-000002",
    at: "2026-10-10T00:00:00.000Z",
    actor: "cli:loaf",
    entry_schema_version: 1,
  };
}
function started(): Snapshot {
  return {
    ...initialSnapshot(),
    state: {
      session_id: "typed-admission",
      feature: "typed-admission",
      phase: "SPEC",
      sub_state: "SPEC.spec",
      iteration: 1,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 1,
      ceremony,
    },
    spec_header: {
      feature: { id: "F-001", name: "Typed admission" },
      intent: "Consume the schema output deterministically",
      adr_refs: [],
      needs_clarification: [],
    },
  };
}
const req = {
  response: "The system shall consume parsed output",
  id: "REQ-AUTH-001",
  type: "ubiquitous",
  measurable: { threshold: 100, metric: "latency" },
  undeclared_requirement_field: "must not reach the projection",
};

describe("typed entry admission", () => {
  for (const kind of Object.keys(admissionPayloadFixtures) as EntryKind[]) {
    test(`one root payload parse for ${kind}`, () => {
      const payload = admissionPayloadFixtures[kind];
      expect(PER_KIND_PAYLOAD[kind].safeParse(payload).success).toBe(true);
      const spy = vi.spyOn(PER_KIND_PAYLOAD[kind], "safeParse");
      const throwingParse = vi.spyOn(PER_KIND_PAYLOAD[kind], "parse");
      try {
        admitEntry(
          kind === "session:started" ? initialSnapshot() : started(),
          entry(kind, payload),
        );
        expect(spy).toHaveBeenCalledTimes(1);
        expect(throwingParse).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        throwingParse.mockRestore();
      }
    });
  }
  test("preflight returns schema output without changing the raw candidate", () => {
    const raw = entry("event:spec_req_added", { spec_version: 2, req });
    const bytes = JSON.stringify(raw);
    const result = preflight(raw, { snapshot: started() });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.entry.kind).toBe("event:spec_req_added");
    if (result.entry.kind !== "event:spec_req_added") throw new Error("expected requirement entry");
    expect(result.entry.payload.req.measurable?.direction).toBe("lte");
    expect(result.entry.payload.req).not.toHaveProperty("undeclared_requirement_field");
    expect(Object.keys(result.entry.payload.req)).toEqual(["id", "type", "response", "measurable"]);
    expect(JSON.stringify(raw)).toBe(bytes);
  });

  test("reducer consumes parsed defaults, stripping and declaration order", () => {
    const result = admitEntry(started(), entry("event:spec_req_added", { spec_version: 2, req }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.snapshot.requirements[0]).toEqual({
      id: "REQ-AUTH-001",
      type: "ubiquitous",
      response: req.response,
      measurable: { metric: "latency", threshold: 100, direction: "lte" },
    });
    expect(Object.keys(result.snapshot.requirements[0]!)).toEqual([
      "id",
      "type",
      "response",
      "measurable",
    ]);
    const md = composeSpecMdFrontmatter(result.snapshot);
    expect(md).toContain("direction: lte");
    expect(md).not.toContain("undeclared_requirement_field");
  });

  test.each([
    {
      actor: "cli:loaf",
      payload: { id: "PEND-0001", kind: "ask_user_question", question: "Choose an option" },
      ok: true,
    },
    { actor: "cli:loaf", payload: { id: "PEND-0001" }, ok: false },
    { actor: "migration:retired", payload: { id: "PEND-0001" }, ok: false },
  ])("one payload parse per admission (actor=$actor, ok=$ok)", ({ actor, payload, ok }) => {
    const spy = vi.spyOn(PER_KIND_PAYLOAD["pending:added"], "safeParse");
    try {
      const result = admitEntry(started(), { ...entry("pending:added", payload), actor });
      expect(result.ok).toBe(ok);
      expect(spy).toHaveBeenCalledTimes(1);
      if (actor.startsWith("migration:"))
        expect(result).toMatchObject({ code: "ACTOR_AUTHORITY_VIOLATION" });
    } finally {
      spy.mockRestore();
    }
  });

  test("raw journal payload bytes survive parsed projection, replay and real doctor rebuild", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-typed-journal-"));
    const ctx: MutateContext = {
      feature_dir: dir,
      snapshot: initialSnapshot(),
      tail_seq: -1,
      entries: [],
      meta: emptyMeta(),
      fsync: false,
    };
    async function write(kind: EntryKind, payload: unknown) {
      const result = await mutate(
        {
          kind,
          payload,
          at: "2026-10-10T00:00:00.000Z",
          actor: "cli:loaf",
          entry_schema_version: 1,
        },
        ctx,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.message);
      ctx.snapshot = result.snapshot;
      ctx.entries.push(result.entry);
      ctx.tail_seq = result.entry.seq;
      ctx.meta = result.meta;
    }
    try {
      await write("session:started", admissionPayloadFixtures["session:started"]);
      for (const [from, to] of [
        ["TRIAGE.score", "TRIAGE.confirm"],
        ["TRIAGE.confirm", "SPEC.proposal"],
        ["SPEC.proposal", "SPEC.spec"],
      ])
        await write("event:phase_advanced", { from, to });
      await write("event:spec_submitted", {
        spec_version: 1,
        feature: { id: "F-001", name: "Typed admission" },
        intent: "Consume the schema output deterministically",
        adr_refs: [],
        needs_clarification: [
          {
            question: "What should be preserved?",
            id: "NC-001",
            passthrough_marker: "retained clarification",
          },
        ],
      });
      const rawPayload = { spec_version: 2, req };
      const payloadBytes = JSON.stringify(rawPayload);
      await write("event:spec_req_added", rawPayload);
      await write("event:spec_scenario_added", {
        spec_version: 3,
        scenario: {
          then: ["projection updates"],
          when: ["an event arrives"],
          given: ["a session"],
          name: "Typed scenario",
          id: "SCEN-AUTH-001",
          stripped_scenario_marker: "remove me",
        },
      });
      await write("event:spec_visual_added", {
        spec_version: 4,
        visual: {
          checks: ["Display correctly"],
          target: "Result panel",
          id: "VIS-AUTH-001",
          passthrough_marker: "retained visual",
        },
      });
      const journalPath = path.join(dir, "journal.jsonl");
      const journalBytes = await fs.readFile(journalPath);
      expect(journalBytes.toString()).toContain(`"payload":${payloadBytes}`);
      expect(journalBytes.toString()).toContain("undeclared_requirement_field");
      const mutationSpec = await fs.readFile(path.join(dir, "spec.md"));
      expect(mutationSpec.toString()).toContain("direction: lte");
      expect(mutationSpec.toString()).not.toContain("undeclared_requirement_field");
      expect(mutationSpec.toString()).not.toContain("stripped_scenario_marker");
      expect(mutationSpec.toString()).toContain("retained clarification");
      expect(mutationSpec.toString()).toContain("retained visual");
      const replay = await replayJournal(journalPath, { collect_entries: true });
      expect(replay.ok, JSON.stringify(replay)).toBe(true);
      if (!replay.ok) throw new Error(replay.message);
      expect(JSON.stringify(replay.snapshot)).toBe(JSON.stringify(ctx.snapshot));
      expect(composeSpecMdFrontmatter(replay.snapshot)).toBe(mutationSpec.toString());
      const names = await fs.readdir(path.join(dir, "snapshots"));
      const mutationBytes = await Promise.all(
        names.map((name) => fs.readFile(path.join(dir, "snapshots", name))),
      );
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        expect(
          await main([
            "node",
            "loaf",
            "doctor",
            "--rebuild",
            "--feature",
            "probe",
            "--feature-dir",
            dir,
            "--format",
            "json",
          ]),
        ).toBe(0);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
      expect(await fs.readFile(journalPath)).toEqual(journalBytes);
      expect(await fs.readFile(path.join(dir, "spec.md"))).toEqual(mutationSpec);
      for (const [index, name] of names.entries()) {
        const rebuilt = await fs.readFile(path.join(dir, "snapshots", name));
        if (name === "_meta.json") {
          // As in A20, write time is operational metadata; all journal-derived
          // fields must still match, including offsets and rolling checksums.
          const { written_at: beforeTime, ...before } = SnapshotMeta.parse(
            JSON.parse(mutationBytes[index]!.toString()),
          );
          const { written_at: afterTime, ...after } = SnapshotMeta.parse(
            JSON.parse(rebuilt.toString()),
          );
          expect(beforeTime).toBeDefined();
          expect(afterTime).toBeDefined();
          expect(after).toEqual(before);
        } else {
          expect(rebuilt, name).toEqual(mutationBytes[index]);
        }
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
