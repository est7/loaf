// Slice A SC-A2 — spec.md projection writer unit tests.
//
// Covers the pure compose + IO write split (codex r84/r90):
//   composeSpecMdFrontmatter — must throw on null spec_header / state
//     (invariant violation surfaces loud, not silent no-op)
//   writeDerivedSpecMd — atomic tmp+fsync+rename+parent-fsync;
//     final spec.md absent or unchanged on failure (no partial replace).
//
// E2E unlock through gate decide spec-lock --approve lives in cli.test.ts.

import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { composeSpecMdFrontmatter, writeDerivedSpecMd } from "../../src/core/spec-projection.js";
import { initialSnapshot, type Snapshot, type SpecHeader } from "../../src/core/reducer.js";
import { emptyMeta } from "../../src/core/snapshot.js";
import type { JournalEntry } from "../../src/core/journal-entry.js";
import type { Ceremony } from "../../src/core/journal-entry.js";
import { readSpecFrontmatter } from "../../src/core/spec-frontmatter.js";

const STANDARD_CEREMONY: Ceremony = {
  spec_phase: true,
  verify_phase: true,
  settle_phase: false,
  strict_spec_review: false,
  lessons_required: "skip",
  strict_drift_check: false,
};

function snapshotWithSpec(specHeader: SpecHeader): Snapshot {
  const snap = initialSnapshot();
  snap.state = {
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    feature: "auth-refresh",
    phase: "SPEC",
    sub_state: "SPEC.design",
    iteration: 0,
    spec_locked: false,
    verify_accepted: false,
    spec_version: 1,
    ceremony: STANDARD_CEREMONY,
  };
  snap.spec_header = specHeader;
  return snap;
}

function makeHeader(overrides: Partial<SpecHeader> = {}): SpecHeader {
  return {
    feature: { id: "F-001", name: "OAuth access token refresh" },
    intent: "users should not perceive auth recovery flows in flight",
    adr_refs: [],
    needs_clarification: [],
    ...overrides,
  };
}

describe("composeSpecMdFrontmatter — Slice A SC-A2 pure compose", () => {
  test("throws when snapshot.state is null (no session)", () => {
    const snap = initialSnapshot();
    snap.spec_header = makeHeader();
    expect(() => composeSpecMdFrontmatter(snap)).toThrow(/state is null/);
  });

  test("throws when snapshot.spec_header is null (codex r90 — projection corruption surfaces loud)", () => {
    const snap = initialSnapshot();
    snap.state = {
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      feature: "auth-refresh",
      phase: "SPEC",
      sub_state: "SPEC.proposal",
      iteration: 0,
      spec_locked: false,
      verify_accepted: false,
      spec_version: 1,
      ceremony: STANDARD_CEREMONY,
    };
    // spec_header stays null — caller invariant violation
    expect(() => composeSpecMdFrontmatter(snap)).toThrow(/spec_header is null/);
  });

  test("produces SpecFrontmatter-valid YAML that round-trips through readSpecFrontmatter", async () => {
    const snap = snapshotWithSpec(makeHeader());
    snap.requirements = [
      {
        id: "REQ-AUTH-001",
        type: "event-driven",
        trigger: "an API request receives HTTP 401",
        response: "the system shall attempt to refresh the access token before surfacing failure",
        verified_by_scenarios: ["SCEN-AUTH-E2E-001"],
      },
    ];
    snap.scenarios = [
      {
        id: "SCEN-AUTH-E2E-001",
        name: "Expired token recovered by refresh",
        tag: "e2e",
        requires_acceptance: true,
        given: ["user has a valid refresh token", "the access token is expired"],
        when: ["the user opens the order list"],
        then: ["the system refreshes the access token", "the order list is displayed"],
      },
    ];
    snap.visual_contracts = [];

    const content = composeSpecMdFrontmatter(snap);

    // Write to a temp file and round-trip via the production reader.
    const dir = await mkdtemp(path.join(tmpdir(), "loaf-spec-projection-"));
    try {
      await writeFile(path.join(dir, "spec.md"), content);
      const result = await readSpecFrontmatter(dir);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.frontmatter.feature.id).toBe("F-001");
        expect(result.frontmatter.feature.name).toBe("OAuth access token refresh");
        expect(result.frontmatter.spec_version).toBe(1);
        expect(result.frontmatter.requirements).toHaveLength(1);
        expect(result.frontmatter.requirements[0]!.id).toBe("REQ-AUTH-001");
        expect(result.frontmatter.scenarios).toHaveLength(1);
        expect(result.frontmatter.scenarios[0]!.id).toBe("SCEN-AUTH-E2E-001");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves existingBody verbatim after the frontmatter fence", () => {
    const snap = snapshotWithSpec(makeHeader());
    const body = "\n## Notes\n\nUser-edited body content lives here.\n- bullet 1\n- bullet 2\n";
    const content = composeSpecMdFrontmatter(snap, body);

    // content must end with the original body — no trimming, no rewrites.
    expect(content.endsWith(body)).toBe(true);
    expect(content).toContain("\n## Notes");
    expect(content).toContain("bullet 1");
  });

  test("rejects composed frontmatter that fails SpecFrontmatter.parse (codex r90 strict gate)", () => {
    const snap = snapshotWithSpec(makeHeader());
    // Inject an invalid requirement by direct push (bypassing reducer
    // schema gates). Missing required 'response' field for ubiquitous
    // EARS variant — parse should reject.
    snap.requirements = [
      {
        id: "REQ-AUTH-001",
        type: "ubiquitous",
        // response missing — SpecFrontmatter.parse should fail
      } as unknown as Snapshot["requirements"][number],
    ];
    expect(() => composeSpecMdFrontmatter(snap)).toThrow();
  });
});

describe("writeDerivedSpecMd — Slice A SC-A2 atomic IO", () => {
  test("creates new spec.md when absent (fresh feature dir)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loaf-spec-projection-"));
    try {
      const snap = snapshotWithSpec(makeHeader());
      await writeDerivedSpecMd(snap, dir);

      const written = await readFile(path.join(dir, "spec.md"), "utf8");
      expect(written).toMatch(/^---/);
      expect(written).toContain("F-001");
      expect(written).toContain("intent:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves existing body across re-write (read existing → split → re-emit)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loaf-spec-projection-"));
    try {
      const snap = snapshotWithSpec(makeHeader());
      await writeDerivedSpecMd(snap, dir);

      // Append a body section, simulating user edit.
      const original = await readFile(path.join(dir, "spec.md"), "utf8");
      const withUserBody = original + "\n## User Notes\n\nHand-edited content.\n";
      await writeFile(path.join(dir, "spec.md"), withUserBody);

      // Now mutate the projection (add a REQ) and re-write.
      snap.requirements = [
        {
          id: "REQ-AUTH-001",
          type: "ubiquitous",
          response: "the system shall handle the case correctly under all conditions",
          acceptance_na: true,
          acceptance_na_reason: "subjective UX validated via manual testing scope",
        },
      ];
      await writeDerivedSpecMd(snap, dir);

      const rewritten = await readFile(path.join(dir, "spec.md"), "utf8");
      expect(rewritten).toContain("REQ-AUTH-001");
      // User body must survive verbatim.
      expect(rewritten).toContain("## User Notes");
      expect(rewritten).toContain("Hand-edited content.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("FS-failure surface: final spec.md unchanged when writeDerivedSpecMd rejects (codex r92 reword)", async () => {
    // Pre-create spec.md AS A DIRECTORY at the target path. With this
    // setup writeDerivedSpecMd fails at the initial readFile (EISDIR)
    // — BEFORE tmp-file creation / fsync / rename. So this test does
    // NOT exercise rename-stage atomicity (codex r92 #2 — original
    // claim was incorrect). What it DOES prove is the broader
    // invariant: any FS-level failure during projection write leaves
    // the prior on-disk state intact, never partially replaced.
    //
    // The rename-stage atomicity is owned by the underlying syscall
    // semantics (POSIX rename within same FS is atomic by spec).
    // Deterministic rename-stage fault injection would require either
    // extracting a tiny atomic-write helper with an injectable fs
    // adapter, or a test-only flag in the production API — codex r90
    // Q7 explicitly recommended against the latter.
    const dir = await mkdtemp(path.join(tmpdir(), "loaf-spec-projection-"));
    try {
      const specPath = path.join(dir, "spec.md");
      await mkdir(specPath); // pre-create as directory → readFile throws EISDIR

      const snap = snapshotWithSpec(makeHeader());
      await expect(writeDerivedSpecMd(snap, dir)).rejects.toThrow();

      // Final spec.md is still the directory we created — pre-existing
      // state preserved, not partially replaced by tmp residue.
      const stat = await import("node:fs/promises").then((fsp) => fsp.stat(specPath));
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("re-write is idempotent — same snapshot writes identical content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loaf-spec-projection-"));
    try {
      const snap = snapshotWithSpec(makeHeader());
      await writeDerivedSpecMd(snap, dir);
      const first = await readFile(path.join(dir, "spec.md"), "utf8");

      await writeDerivedSpecMd(snap, dir);
      const second = await readFile(path.join(dir, "spec.md"), "utf8");

      expect(second).toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Slice A SC-A2 Pass 5 integration — surfaces PROJECTION_WRITE_FAILED
// when writeDerivedSpecMd throws after journal append succeeds. Uses
// pre-create-as-directory fault injection (codex r90 Q7 recommendation:
// real-FS failure, no test-only flags in production API).
describe("mutateBatch Pass 5 — PROJECTION_WRITE_FAILED surface", () => {
  test("spec_submitted batch with spec.md pre-created as directory → PROJECTION_WRITE_FAILED, journal appended", async () => {
    const { initialSnapshot: init } = await import("../../src/core/reducer.js");
    const { mutateBatch } = await import("../../src/core/journal-mutate.js");
    const fsP = await import("node:fs/promises");

    const dir = await mkdtemp(path.join(tmpdir(), "loaf-pass5-"));
    try {
      // Pre-create spec.md AS A DIRECTORY at the target path. rename(tmp →
      // spec.md) must fail — Pass 5 catches, surfaces PROJECTION_WRITE_FAILED.
      await mkdir(path.join(dir, "spec.md"));

      let snapshot = init();
      let entries: JournalEntry[] = [];
      let meta = emptyMeta();
      // session:started
      const boot = await mutateBatch(
        [
          {
            at: "2026-05-19T10:00:00.000Z",
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "session:started",
            payload: {
              session_id: "550e8400-e29b-41d4-a716-446655440000",
              feature: "auth-refresh",
              ceremony: STANDARD_CEREMONY,
            },
          },
        ],
        { feature_dir: dir, snapshot, tail_seq: -1, entries, meta, fsync: false },
      );
      if (!boot.ok) throw new Error(`seed boot failed: ${boot.message}`);
      snapshot = boot.snapshot;
      entries = entries.concat(boot.entries);
      meta = boot.meta;

      // Walk TRIAGE.score → TRIAGE.confirm → SPEC.proposal.
      let tail = 0;
      for (const [from, to] of [
        ["TRIAGE.score", "TRIAGE.confirm"],
        ["TRIAGE.confirm", "SPEC.proposal"],
      ] as Array<[string, string]>) {
        const r = await mutateBatch(
          [
            {
              at: "2026-05-19T10:00:01.000Z",
              actor: "cli:loaf",
              entry_schema_version: 1,
              kind: "event:phase_advanced",
              payload: { from, to } as unknown as Record<string, unknown>,
            },
          ],
          { feature_dir: dir, snapshot, tail_seq: tail, entries, meta, fsync: false },
        );
        if (!r.ok) throw new Error(`walk failed: ${r.message}`);
        snapshot = r.snapshot;
        tail += 1;
        entries = entries.concat(r.entries);
        meta = r.meta;
      }

      // spec_submitted at SPEC.proposal → Pass 5 fires → write fails.
      const result = await mutateBatch(
        [
          {
            at: "2026-05-19T10:00:02.000Z",
            actor: "human:test@invalid.local",
            entry_schema_version: 1,
            kind: "event:spec_submitted",
            payload: {
              spec_version: 1,
              feature: { id: "F-001", name: "OAuth token refresh" },
              intent: "users should not perceive auth recovery flows in flight",
              adr_refs: [],
              needs_clarification: [],
            },
          },
        ],
        { feature_dir: dir, snapshot, tail_seq: tail, entries, meta, fsync: false },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("PROJECTION_WRITE_FAILED");
        expect(result.detail).toBeDefined();
        expect(result.detail!["projection"]).toBe("spec.md");
        expect(result.detail!["journal_appended"]).toBe(true);
        expect(result.detail!["spec_version"]).toBe(1);
        expect(typeof result.detail!["last_seq"]).toBe("number");
      }

      // Critical: journal already has the appended entry (journal is truth).
      const journal = await fsP.readFile(path.join(dir, "journal.jsonl"), "utf8");
      const lines = journal.trim().split("\n");
      const lastEntry = JSON.parse(lines[lines.length - 1]!);
      expect(lastEntry.kind).toBe("event:spec_submitted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("non-spec batch (e.g. phase_advanced only) does NOT trigger Pass 5 — spec.md untouched", async () => {
    const { initialSnapshot: init } = await import("../../src/core/reducer.js");
    const { mutateBatch } = await import("../../src/core/journal-mutate.js");
    const fsP = await import("node:fs/promises");

    const dir = await mkdtemp(path.join(tmpdir(), "loaf-pass5-skip-"));
    try {
      // Hand-write spec.md with arbitrary content; phase_advanced should
      // not touch it (Pass 5 scoped to SPEC_EMITTING_KINDS).
      const before = "---\nschema_version: 2\nbogus: untouched\n---\nbody\n";
      await fsP.writeFile(path.join(dir, "spec.md"), before);

      const snapshot = init();
      const boot = await mutateBatch(
        [
          {
            at: "2026-05-19T10:00:00.000Z",
            actor: "cli:loaf",
            entry_schema_version: 1,
            kind: "session:started",
            payload: {
              session_id: "660e8400-e29b-41d4-a716-446655440001",
              feature: "auth-refresh",
              ceremony: STANDARD_CEREMONY,
            },
          },
        ],
        { feature_dir: dir, snapshot, tail_seq: -1, entries: [], meta: emptyMeta(), fsync: false },
      );
      if (!boot.ok) throw new Error(`boot: ${boot.message}`);

      const after = await fsP.readFile(path.join(dir, "spec.md"), "utf8");
      expect(after).toBe(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
