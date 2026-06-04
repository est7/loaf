// L3 — shared invariant predicates (preflight ↔ reducer de-duplication).
//
// Spec source: findings.md F-ARCH-002 (grilled + codex plan-first GO, 2026-06-03).
// These predicates are the SINGLE place each scalar invariant lives; preflight
// and reducer both delegate, then map the returned fact to their own error
// surface (preflight = typed code + detail.*; reducer = invalidPayload string).
//
// Purpose of THIS file: the predicate-level test surface (primary). Call-site
// error-shape preservation (codes / detail.* / messages) is asserted by the
// existing preflight-validation + reducer suites, which must stay green after
// the refactor (behavior-preserving red line).
//
import { describe, expect, test } from "vitest";

import {
  checkSpecVersion,
  findCollision,
  findDuplicateId,
} from "../../src/core/reducer/invariants.js";

describe("checkSpecVersion — monotonic spec_version, parametrised by batch position", () => {
  // head: payloadVersion must be currentVersion + 1; success carries nextVersion.
  test("head ok → { ok: true, nextVersion: payloadVersion }", () => {
    expect(checkSpecVersion(5, 4, "head")).toEqual({ ok: true, nextVersion: 5 });
  });

  test("head fail → { ok: false, expected: currentVersion + 1 }", () => {
    expect(checkSpecVersion(6, 4, "head")).toEqual({ ok: false, expected: 5 });
    expect(checkSpecVersion(4, 4, "head")).toEqual({ ok: false, expected: 5 });
  });

  // continuation: payloadVersion must equal currentVersion (head already bumped
  // state); success carries nextVersion = currentVersion (unchanged).
  test("continuation ok → { ok: true, nextVersion: currentVersion }", () => {
    expect(checkSpecVersion(4, 4, "continuation")).toEqual({ ok: true, nextVersion: 4 });
  });

  test("continuation fail → { ok: false, expected: currentVersion }", () => {
    expect(checkSpecVersion(5, 4, "continuation")).toEqual({ ok: false, expected: 4 });
    expect(checkSpecVersion(3, 4, "continuation")).toEqual({ ok: false, expected: 4 });
  });

  // The rule (+1 vs +0) lives in the predicate, not the caller. A "head"
  // expected must never equal a "continuation" expected for the same currentV.
  test("mode selects the expected formula, not the caller", () => {
    const cur = 7;
    expect(checkSpecVersion(cur, cur, "head")).toEqual({ ok: false, expected: cur + 1 });
    expect(checkSpecVersion(cur, cur, "continuation")).toEqual({ ok: true, nextVersion: cur });
  });
});

describe("findDuplicateId — self-scan for a duplicate WITHIN a list (tasks_planned)", () => {
  test("no duplicate → null", () => {
    expect(findDuplicateId(["T-001", "T-002", "T-003"])).toBeNull();
  });

  test("empty list → null", () => {
    expect(findDuplicateId([])).toBeNull();
  });

  test("duplicate → { id } of the repeated entry", () => {
    expect(findDuplicateId(["T-001", "T-002", "T-001"])).toEqual({ id: "T-001" });
  });

  test("returns the FIRST id encountered a second time (scan order)", () => {
    // A seen@0, B seen@1, A repeats@2 → first repeat encountered is A.
    expect(findDuplicateId(["A", "B", "A", "B"])).toEqual({ id: "A" });
  });
});

describe("findCollision — membership: does incomingId already exist (REQ/SCEN/VIS add-one)", () => {
  test("collision → { id: incomingId }", () => {
    expect(findCollision("REQ-1", ["REQ-1"])).toEqual({ id: "REQ-1" });
    expect(findCollision("REQ-1", ["REQ-2", "REQ-1", "REQ-3"])).toEqual({ id: "REQ-1" });
  });

  test("no collision → null", () => {
    expect(findCollision("REQ-2", ["REQ-1"])).toBeNull();
  });

  test("empty existing → null", () => {
    expect(findCollision("REQ-1", [])).toBeNull();
  });

  // R3 regression lock (codex): membership ≠ whole-projection scan. A duplicate
  // ALREADY in the projection, unrelated to the incoming id, must NOT change the
  // add-one answer — otherwise pre-existing corruption would reject a valid add.
  test("pre-existing unrelated duplicate does NOT affect the incoming-id answer", () => {
    expect(findCollision("NEW", ["REQ-1", "REQ-1"])).toBeNull();
  });
});
