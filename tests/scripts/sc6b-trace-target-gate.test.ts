// Phase 16 SC-6b — static guard: every `.action(` block in
// src/cli.tsx records a trace target (or explicit `// no-feature`
// opt-out).
//
// codex r270/r271 G2.1: broaden the regex past one-line
// `.action(async (opts) => {` signatures so it covers multi-line
// signatures and positional-first signatures (loaf start, advance,
// gate decide, spike convert, profile escalate, tasks claim/abandon/
// step/amend, pending raise, finding raise, spec init/submit, etc.).
//
// Window: 80 lines from each `.action(` start covers all current
// action bodies (codex r271 acceptance: 45 was generous for current;
// we widened to 60 to absorb long pre-validation bodies — profile
// escalate, tasks amend, evidence add, spec submit — whose featureDir
// resolution sits past 45 lines from the `.action(` open).
// SC-8b biome formatting expands action bodies; widen to 80 so the
// static locality guard still covers the same dispatch markers after format.
//
// Also asserts protocol.md + .gitignore invariants: `--debug` row no
// longer has `inventory:future`, §13.2 no longer advertises current
// `state.debug=true`, and `.gitignore` excludes trace.jsonl.

import { describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readRepo(rel: string): Promise<string> {
  return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
}

describe("SC-6b — static guard: every .action( records trace target", () => {
  test("every .action( block has ctx.recordTraceTarget(...) or // no-feature within 80 lines", async () => {
    const source = await readRepo("src/cli.tsx");
    const lines = source.split("\n");
    const actionLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^\s*\.action\(/.test(line));

    expect(actionLines.length).toBeGreaterThanOrEqual(33);

    const misses: string[] = [];
    for (const block of actionLines) {
      const slice = lines.slice(block.index, block.index + 80).join("\n");
      // SC-8: `dispatchOrFail(opts)` records traceTarget internally
      // (resolves §10.3 dispatch + mutates opts + calls
      // ctx.recordTraceTarget). Action handlers that call dispatchOrFail
      // are SC-6b-compliant via the helper.
      // SC-15b: `dispatchForHookOptional(opts)` is the hook read-side
      // sibling — same §10.3 resolution + ctx.recordTraceTarget on the
      // success path (silent skip on absence), so it is equally compliant.
      const hasMarker =
        /ctx\.recordTraceTarget\(/.test(slice) ||
        /dispatchOrFail\(/.test(slice) ||
        /dispatchForHookOptional\(/.test(slice) ||
        /\/\/\s*no-feature/.test(slice);
      if (!hasMarker) {
        misses.push(`line ${block.index + 1}: ${block.line.trim()}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("SC-6b — static guard: protocol + .gitignore invariants", () => {
  test("docs/protocol.md `--debug` row has no inventory:future annotation", async () => {
    const md = await readRepo("docs/protocol.md");
    // Find the --debug row in the globalFlags table.
    const debugRowMatch = md.match(/^\| `--debug`[^\n]*$/m);
    expect(debugRowMatch).not.toBeNull();
    expect(debugRowMatch![0]).not.toContain("inventory:future");
  });

  test("docs/protocol.md §13.2 no longer advertises current state.debug=true", async () => {
    const md = await readRepo("docs/protocol.md");
    // Grep for the legacy phrasing that promised three behaviors when
    // `state.debug=true`. After SC-6b, the prose is split into
    // "v0.1.0 当前实现" (trace only) + "未来扩展" (other two).
    expect(md).not.toMatch(/`state\.debug=true` 时额外产出/);
  });

  test(".gitignore excludes **/trace.jsonl pattern", async () => {
    const gi = await readRepo(".gitignore");
    expect(gi).toMatch(/trace\.jsonl/);
  });
});
