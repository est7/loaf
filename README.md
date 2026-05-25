# loaf-cli

Protocol kernel for the loaf feature-lifecycle workflow (rev 5.0 / [ADR-0005](docs/adr/0005-truth-model-single-typed-journal.md)).

Every state change is one `JournalEntry` appended to `.loaf/<feature>/journal.jsonl`. A reducer projects derived state (session / task / evidence / finding / pending) from that journal. There is no `state.json` source of truth — only the typed journal and its in-memory projection, with persisted snapshots in `.loaf/<feature>/snapshots/` that the reader fast-checks before consuming.

The CLI implements the worker workflow `TRIAGE → SPEC → EXECUTE → VERIFY → DONE` end-to-end.

A sibling layer `loaf-skill` (separate codebase, post-v0.1.0) handles workflow orchestration — see [`skills/CONTRACT.md`](skills/CONTRACT.md) for the boundary.

## Runtime

- **Node ≥ 22**, ESM only. The published binary is plain Node — Bun is not a runtime dependency.
- **Bun ≥ 1.3** for dependency management and local scripts.

## Install

Run directly from a GitHub release tag via `bunx` or `npx`:

```bash
bunx github:est7/loaf#v0.1.0 --version
npx  github:est7/loaf#v0.1.0 --version
```

Or add as a dependency:

```bash
bun add github:est7/loaf#v0.1.0
npm install github:est7/loaf#v0.1.0
```

The built `dist/cli.mjs` is committed for github-install support — consumers do not need bun, tsdown, or any post-install build step. Requires Node ≥ 22 to run.

The executable name is `loaf`.

## Usage

```bash
loaf start <feature> --ceremony <quick|light|standard|deep>
loaf status --feature <feature>
loaf spec init|submit|add-req|add-scenario|add-visual --feature <feature> [--input <file>]
loaf tasks submit|claim|list|next
loaf tasks step start|done
loaf pending raise|list|status|resolve
loaf evidence add --input <file>
loaf finding raise|list|close
loaf gate decide <gate-name> --approve|--reject --reason <…>
loaf deliver
loaf settle
loaf doctor [--rebuild]
```

The authoritative command surface lives in [`docs/protocol.md`](docs/protocol.md) §10.8.

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
src/core/      # stable core — journal, reducer, preflight, gates, mutator pipeline, projection loader
src/cli.tsx    # CLI surface (Commander + Ink + Zod)
docs/          # protocol spec, ADRs, schemas, reference notes
tests/core/    # real-FS integration + unit tests (no mocking)
```

## References

- [`docs/protocol.md`](docs/protocol.md) — protocol spec rev 5.0 (§10.8 = CLI surface)
- [`docs/schemas.ts`](docs/schemas.ts) — Zod source of truth + `ERROR_CATALOG` + `DiagnosticCode` enum
- [`docs/adr/0005-truth-model-single-typed-journal.md`](docs/adr/0005-truth-model-single-typed-journal.md) — current truth model
- [`skills/CONTRACT.md`](skills/CONTRACT.md) — loaf-cli ↔ loaf-skill boundary
- [`CHANGELOG.md`](CHANGELOG.md) — release notes

## License

MIT.
