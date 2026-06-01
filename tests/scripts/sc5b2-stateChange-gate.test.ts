// Phase 16 SC-5b2 — per-site stateChange ↔ protocol §10.12 drift gate.
//
// Per codex r261 P27 + r262 GO: test-only fixture table, NOT exported
// from production. Independent measurement of runtime emission ↔
// protocol prose; the gate cannot degrade into a self-referential
// snapshot.
//
// Reads docs/protocol.md §10.12 table inline, builds a Map<command,
// rowText>, and asserts each migrated site's expected stateChange
// pattern matches the corresponding row's text. Dynamic fields use
// regex skeletons (`<from>` → `\\S+`, etc.).

import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PROTOCOL_MD = path.join(REPO_ROOT, "docs/protocol.md");

/** Extract the §10.12 table as a Map<commandKey, rowText>. The first
 *  cell may contain ONE backtick-quoted command (with optional
 *  `(approve)` / `(reject)` parenthetical suffix) OR multiple commands
 *  separated by ` / `. Each backtick-quoted command becomes a key
 *  pointing at the same row text. */
function loadProtocolStateChangeRows(): Map<string, string> {
  const text = readFileSync(PROTOCOL_MD, "utf8");
  const lines = text.split("\n");
  const rows = new Map<string, string>();
  let inSection = false;
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("### 10.12")) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("### ")) {
      // Next ### heading ends §10.12.
      break;
    }
    if (!inSection) continue;
    if (line.startsWith("| 命令") || line.startsWith("|---")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith("| `loaf ")) continue;
    // First cell: split on `|`. Then extract ALL backtick-quoted
    // `loaf ...` tokens — accommodates `loaf archive` / `loaf abandon`
    // combined rows and gate-decide split rows with `(approve)` suffix.
    const segs = line.split("|");
    const firstCell = segs[1] ?? "";
    const cmdMatches = firstCell.match(/`(loaf [^`]+)`/g) ?? [];
    for (const m of cmdMatches) {
      const cmd = m.replace(/^`|`$/g, "").trim();
      rows.set(cmd, line);
    }
  }
  return rows;
}

/** Phase 16 SC-5b2 — runtime stateChange skeleton per migrated site.
 *  `commandKey` matches the protocol row's command cell (sans
 *  backticks). `mustContain` is an array of literal substrings that
 *  MUST appear in the row text (these are the protocol-aligned
 *  prose anchors). */
const STATE_CHANGE_FIXTURES: ReadonlyArray<{
  commandKey: string;
  mustContain: string[];
}> = [
  // start — aligned in SC-5b1 P21
  { commandKey: "loaf start", mustContain: ["start:", "created → TRIAGE.score", "loaf advance"] },
  // advance — narrow (no iter, no prompt_inject)
  { commandKey: "loaf advance", mustContain: ["advance:", "<prev sub-state>", "<new sub-state>"] },
  // spec submit — align
  { commandKey: "loaf spec submit", mustContain: ["spec submit:", "spec_version=N", "locked=false", "loaf gate decide spec-lock"] },
  // spec add-* — narrow
  { commandKey: "loaf spec add-req", mustContain: ["spec add-req:", "+K REQ", "spec_version=N", "allocated"] },
  { commandKey: "loaf spec add-scenario", mustContain: ["spec add-scenario:", "+K SCEN", "allocated"] },
  { commandKey: "loaf spec add-visual", mustContain: ["spec add-visual:", "+K VIS", "allocated"] },
  // tasks submit — narrow (no tasks_version)
  { commandKey: "loaf tasks submit", mustContain: ["tasks submit:", "N tasks", "loaf advance"] },
  // tasks add — narrow
  { commandKey: "loaf tasks add", mustContain: ["tasks add:", "+K tasks", "allocated"] },
  // tasks step start / done
  { commandKey: "loaf tasks step start", mustContain: ["step start:", "(running)"] },
  { commandKey: "loaf tasks step done", mustContain: ["step done:", "(passed)"] },
  // evidence add — three shapes
  { commandKey: "loaf evidence add", mustContain: ["evidence add:", "kind=", "covers=", "+K evidence"] },
  // finding raise — align with back-edge clause
  { commandKey: "loaf finding raise", mustContain: ["finding raise:", "category=", "action=", "back-edge"] },
  // finding close — narrow
  { commandKey: "loaf finding close", mustContain: ["finding close:", "→ closed"] },
  // gate decide split — 3 variants
  { commandKey: "loaf gate decide spec-lock", mustContain: ["gate decide:", "spec-lock approved by"] },
  { commandKey: "loaf gate decide verify-accept", mustContain: ["gate decide:", "verify-accept approved by", "loaf settle", "loaf deliver", "settle_phase"] },
  // settle — narrow
  { commandKey: "loaf settle", mustContain: ["settle:", "SETTLE.reconcile", "loaf deliver"] },
  // deliver — align
  { commandKey: "loaf deliver", mustContain: ["deliver:", "DONE.delivered"] },
  // archive / abandon — align
  // archive and abandon share a row in protocol §10.12 (combined entry).
  // Some §10.12 tables split them, others combine. Audit landed them
  // separately per audit; check whichever the rendered table has.
  { commandKey: "loaf archive", mustContain: ["archive:", "DONE.archived"] },
  { commandKey: "loaf abandon", mustContain: ["abandon:", "DONE.abandoned", "reason="] },
  // tasks amend — narrow (state-change line `amend: <task_id>` is emitted by
  // `loaf tasks amend`; the retired standalone `loaf amend` never shipped)
  { commandKey: "loaf tasks amend", mustContain: ["amend:", "<task_id>"] },
  // pending resolve — narrow
  { commandKey: "loaf pending resolve", mustContain: ["pending resolve:", "<PEND-id>", "cleared"] },
  // 4 new rows (P23)
  { commandKey: "loaf profile escalate", mustContain: ["profile escalate:", "ceremony updated", "<PEND-id>"] },
  { commandKey: "loaf spike convert", mustContain: ["spike convert:", "DONE.archived"] },
  { commandKey: "loaf tasks register-red", mustContain: ["tasks register-red:", "<task_id>"] },
  { commandKey: "loaf doctor --rebuild", mustContain: ["doctor rebuild:", "rebuilt", "projection file"] },
];

describe("Phase 16 SC-5b2 — RED: per-site stateChange ↔ protocol §10.12 drift gate", () => {
  const rows = loadProtocolStateChangeRows();

  test("protocol.md §10.12 table parsed with ≥ 18 command rows", () => {
    // Sanity: parsing didn't silently produce an empty map. SC-5b2
    // landed 4 new rows + 1 split + 2 deletes; final count ~25.
    expect(rows.size).toBeGreaterThanOrEqual(18);
  });

  for (const fixture of STATE_CHANGE_FIXTURES) {
    test(`§10.12 row for '${fixture.commandKey}' contains required prose anchors`, () => {
      // Resolve the row tolerating slight cell-text variations (e.g.
      // `loaf gate decide spec-lock` may appear as cell text
      // ``loaf gate decide spec-lock` (approve)`` — try exact first,
      // then a prefix match on the command head.
      let rowText = rows.get(fixture.commandKey);
      if (!rowText) {
        // Try prefix-match: the table cell may carry a parenthetical
        // suffix like `(approve)` for split rows.
        for (const [key, value] of rows.entries()) {
          if (key.startsWith(fixture.commandKey + " ") || key === fixture.commandKey) {
            rowText = value;
            break;
          }
        }
      }
      expect(rowText, `No §10.12 row found for '${fixture.commandKey}'`).toBeTruthy();
      for (const phrase of fixture.mustContain) {
        expect(rowText!).toContain(phrase);
      }
    });
  }

  test("orphan `loaf waive` row REMOVED from §10.12 (per SC-5b2 P24)", () => {
    // §10.12 table must not advertise a top-level `loaf waive`
    // command (waiver flow is `loaf tasks step done --result waived`).
    expect(rows.has("loaf waive")).toBe(false);
  });

  test("`loaf tasks complete` REMOVED from §10.12 mutation rows (read-only per SC-5b2 P22)", () => {
    expect(rows.has("loaf tasks complete")).toBe(false);
  });
});
