# loaf-cli

Protocol kernel for the loaf feature-lifecycle workflow (rev 5.2; truth model:
[ADR-0005](docs/adr/0005-truth-model-single-typed-journal.md)).

Every state change is one `JournalEntry` appended to `.loaf/<feature>/journal.jsonl`. A reducer projects derived state (session / task / evidence / finding / pending) from that journal. There is no `state.json` source of truth — only the typed journal and its in-memory projection, with persisted snapshots in `.loaf/<feature>/snapshots/` that the reader fast-checks before consuming.

The CLI implements the worker workflow
`TRIAGE → SPEC → EXECUTE → VERIFY → (SETTLE) → DONE` end-to-end; ceremony
flags determine which optional phases run.

A sibling layer `loaf-skill` (separate codebase, post-v0.1.0) handles workflow orchestration — see [`skills/CONTRACT.md`](skills/CONTRACT.md) for the boundary.

## Runtime

- **Node ≥ 22**, ESM only. The published binary is plain Node — Bun is not a runtime dependency.
- **Bun ≥ 1.3** for dependency management and local scripts.

## Install

Run directly from a GitHub release tag via `bunx` or `npx`:

```bash
bunx github:est7/loaf#v0.6.0 --version
npx  github:est7/loaf#v0.6.0 --version
```

Or add as a dependency:

```bash
bun add github:est7/loaf#v0.6.0
npm install github:est7/loaf#v0.6.0
```

The built `dist/cli.mjs` is committed for github-install support — consumers do not need bun, tsdown, or any post-install build step. Requires Node ≥ 22 to run.

The executable name is `loaf`.

## Usage

```bash
loaf start <feature> --ceremony <quick|light|standard|deep>
loaf status --feature <feature>
loaf spec init --feature <feature>
loaf spec status --feature <feature>
loaf spec submit --input <src> --feature <feature>
loaf spec edit --input <src> --feature <feature>  # strict JSON {"body":"<Markdown>"}; preserves frontmatter
loaf spec add-req|add-scenario|add-visual --input <src> --feature <feature>
loaf tasks submit --input <src>
loaf tasks add --input <src> [--finding <FND-N>]
loaf tasks amend <T-N> [--policy <json>|--input <src>] [--finding <FND-N>]
loaf tasks claim|list|next
loaf tasks step start|done
loaf pending raise|list|status|resolve
loaf evidence add --input <src>  # single object OR non-empty array (batch); `<src>` = `-` stdin / inline JSON / file path
loaf evidence list [--covers <id>] [--task <T-N>] [--kind <kind>]
loaf journal list [--after-seq <N>] [--limit <N>] [--kind <kind>] [--actor <prefix>]  # `loaf log` alias
loaf finding raise|list|close
loaf gate decide <gate-name> --approve|--reject --reason <…>
loaf advance <sub_state> --feature <feature>
loaf deliver
loaf settle
loaf resume
loaf handoff --reason <…>                                            # resume marker / handoff pack
loaf tui | board | sessions list [--in-cwd] | check <path>           # documentation shorthand: choose one command
loaf hook <session-start|write-guard|scope-track|closure-check>      # Claude Code hook entry points
loaf prune [restore <id>] [--in-cwd|--project <p>|--all|--orphans] [--purge|--history|--trash] [--yes]  # GC finished sessions → recoverable trash (previews unless --yes)
loaf doctor --rebuild --feature <feature>                            # other doctor modes are not wired
```

The authoritative command surface lives in [`docs/protocol.md`](docs/protocol.md) §10.8.

`loaf board` starts a read-only local browser board on loopback
(`http://127.0.0.1:41738/` by default). It reads the same registry and snapshot
projections as `loaf tui`; workflow writes still go through existing `loaf`
mutator commands. Use `loaf board --once --format json` for a one-shot
scriptable snapshot.

## Local development

```bash
bun install                    # dev install
bun run dev -- <args>          # bun run src/cli.tsx -- <args>
bun run typecheck              # tsc --noEmit
bun run test                   # vitest run (full suite)
bun run check                  # typecheck && test && build
```

Tests use **Vitest** (`bun run test` → `vitest run`). Do not invoke `bun test`.

## Build

```bash
bun run build
node dist/cli.mjs --version
```

`tsdown` emits `dist/cli.mjs` (single-file ESM bundle).

## GA cut workflow

Before tagging a release, run:

```bash
bun run ga:check
```

This chains three steps:

- `bun run build` — fresh `dist/cli.mjs`.
- `bun run ga:pack-smoke` — packs the package via `bun pm pack` into a temp dir, installs the tarball into a clean temp dir, runs the minimum lifecycle smoke (`--version` / `start` / `status` / `doctor --rebuild`), and asserts `state.json.loaf_version_required` matches the package version. Failure codes (stderr): `DIST_MISSING`, `PACK_FAILED`, `INSTALL_FAILED`, `VERSION_MISMATCH`, `START_FAILED`, `STATUS_FAILED`, `DOCTOR_REBUILD_FAILED`, `PIN_MISMATCH`.
- `bun run ga:consistency` — verifies `package.json.version` equals the expected tag without the `v` prefix, CHANGELOG has both a `## [<version>]` entry and a `[<version>]: …/tag/<expected-tag>` link line, working tree is clean, and `HEAD == origin/main` (after `git fetch`; pass `-- --no-fetch` for offline). Failure codes: `WORKTREE_DIRTY`, `VERSION_TAG_MISMATCH`, `CHANGELOG_MISSING`, `HEAD_NOT_ORIGIN`.

`ga:check` is intended to run AFTER the release commit is committed and pushed — an uncommitted version bump intentionally fails `WORKTREE_DIRTY`.

## Layout

```text
src/core/          # stable core — journal, reducer, gates, mutator pipeline, projections
src/core/reducer/  # reducer coordinator + split preflight policy families
src/cli.tsx        # CLI composition entry point
src/cli/commands/  # Commander command families, including split tasks/* modules
src/cli/           # presentation, dispatch, and command-support modules
docs/          # protocol spec, ADRs, schemas, reference notes
tests/core/    # real-FS integration + unit tests (no mocking)
```

## References

- [`docs/protocol.md`](docs/protocol.md) — protocol spec rev 5.2 (§10.8 = CLI surface)
- [`docs/machine-contract.md`](docs/machine-contract.md) — runtime machine-contract owner index + schema emission entry points
- [`docs/adr/0005-truth-model-single-typed-journal.md`](docs/adr/0005-truth-model-single-typed-journal.md) — current truth model
- [`skills/CONTRACT.md`](skills/CONTRACT.md) — loaf-cli ↔ loaf-skill boundary
- [`CHANGELOG.md`](CHANGELOG.md) — release notes

## License

MIT.
