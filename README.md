# loaf-cli

A TypeScript CLI scaffold built around:

- **Ink + Commander** for the CLI surface
- **Zod** for validation
- **Vitest** for tests
- **tsdown** for builds
- **JSONL** for lightweight persistence

## Runtime

- **Node 22+**
- **Bun** for dependency management and local scripts

## Install

```bash
bun install
```

## Local development

```bash
bun run dev -- --help
bun run dev -- hello est9
bun run dev -- hello est9 --json
bun run dev -- history
```

## Validate the scaffold

```bash
bun run check
```

## Build

```bash
bun run build
node dist/cli.mjs hello est9
node dist/cli.mjs history
```

## Publish for `npx` / `bunx`

Once published to npm under the package name `loaf-cli`, the executable can be invoked as:

```bash
npx loaf-cli hello est9
bunx loaf-cli hello est9
```

The command name exposed by the package is `loaf`.

## Project layout

```text
src/
  cli.tsx             # Commander boundary and exit handling
  core/hello.ts       # Validated command logic
  core/jsonl-store.ts # JSONL persistence
  core/errors.ts      # Shared CLI error types and exit codes
  ui/screens.tsx      # Ink views
  ui/output.ts        # JSON/stderr output
tests/
  hello.test.ts       # Stable logic regression tests
  jsonl-store.test.ts # Persistence regression tests
```

## Default persistence path

By default, command history is appended to:

```text
.loaf-cli/history.jsonl
```

under the current working directory. Override it with `--data-file <path>`.
