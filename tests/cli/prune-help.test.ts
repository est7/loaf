// prune slice 7 — lock the user-facing help contract for the destructive
// `loaf prune` surface. Not a brittle full-text snapshot: assert the
// safety-relevant lines (preview-default, --yes, --force-never-overrides-lock,
// recoverable trash vs --purge, the scopes, the restore subcommand) so an
// accidental reword that weakens the safety messaging fails loudly.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.tsx");

function help(args: string[]): string {
  const r = spawnSync("bun", [CLI_ENTRY, ...args, "--help"], { encoding: "utf8", cwd: REPO_ROOT });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("loaf prune --help (safety contract)", () => {
  const out = help(["prune"]);

  test("documents the recoverable-trash + terminal-only nature", () => {
    expect(out).toContain("recoverable trash");
    expect(out).toContain("terminal-only");
  });

  test("preview-by-default is stated on --yes", () => {
    // The whole destructive-safety posture: nothing happens without --yes.
    // (help wraps lines, so assert wrap-stable substrings, not one contiguous run)
    expect(out).toContain("--yes");
    expect(out).toContain("changes nothing");
  });

  test("--force never overrides a held lock", () => {
    expect(out).toContain("--force");
    expect(out).toContain("overrides a held lock");
  });

  test("--purge is the explicit hard-delete opt-out of trash", () => {
    expect(out).toContain("--purge");
    expect(out).toContain("Hard-delete");
  });

  test("lists the scope selectors + the restore subcommand", () => {
    expect(out).toContain("--in-cwd");
    expect(out).toContain("--project");
    expect(out).toContain("--all");
    expect(out).toContain("--orphans");
    expect(out).toContain("--history");
    expect(out).toContain("--trash");
    expect(out).toContain("restore"); // subcommand listed under Commands:
  });
});

describe("loaf prune restore --help", () => {
  test("documents the disambiguator", () => {
    const out = help(["prune", "restore"]);
    expect(out).toContain("--at");
  });
});
