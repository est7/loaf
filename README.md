# loaf-cli

Protocol kernel for the loaf feature-lifecycle workflow (rev 5.0 / [ADR-0005](docs/adr/0005-truth-model-single-typed-journal.md)).

Every state change is one `JournalEntry` appended to `.loaf/<feature>/journal.jsonl`. A reducer projects derived state (session / task / evidence / finding / pending) from that journal. There is no `state.json` source of truth — only the typed journal and its in-memory projection, with persisted snapshots in `.loaf/<feature>/snapshots/` that the reader fast-checks before consuming.

The CLI implements the worker workflow `TRIAGE → SPEC → EXECUTE → VERIFY → DONE` end-to-end.

A sibling layer `loaf-skill` (separate codebase, post-v0.1.0) handles workflow orchestration — see [`skills/CONTRACT.md`](skills/CONTRACT.md) for the boundary.

## Runtime

- **Node ≥ 22**, ESM only. The published binary is plain Node — Bun is not a runtime dependency.
- **Bun ≥ 1.3** for dependency management and local scripts.

## Install

```bash
bun install
```

## Usage

Once published, invoke via `npx loaf-cli <args>` / `bunx loaf-cli <args>`. The executable name is `loaf`.

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
