# ADR-0007 — Config init scaffolds full project config

- Status: **Accepted and implemented**
- Date: 2026-06-04
- Scope: loaf-cli config scaffold command; project `loaf.config.json`; user
  `~/.loaf/config.json`
- Related:
  - `docs/plans/loaf-config-init.md`
  - `docs/protocol.md` §4.11 / §10.7 / §10.8
  - `docs/schemas.ts` §21 `LoafConfig`
  - `src/core/loaf-config.ts`
  - `src/core/user-config.ts`

## Context

Users had no command to create a starting config file. The only available
reference was `loaf.config.example.json`, which is intentionally project-flavored
and includes example globs. Copying it by hand makes onboarding noisy and can
accidentally turn examples into policy.

The project config also has two ownership layers:

- loaf-cli owns the `LoafConfig` file syntax and default serialization.
- loaf-skill and other callers interpret some sections, especially `commands`
  and `constitution`.

The write-guard hook already reads only the write-guard slice
(`protected_files`, `stable_core`, `paths`). Coupling that hook to every
skill-owned section would make a malformed test command or ceremony preference
disable write-guard availability.

## Decision

### 1. Add `loaf config init`

Add a noun-first command:

```text
loaf config init
loaf config init --global
```

This follows the existing CLI grammar (`spec init`, `tasks add`,
`pending raise`, `gate decide`) and keeps future `loaf config get/set` room
under the same namespace. We intentionally did not add bare `loaf init`; within
this CLI, config initialization is a config operation, not a repository
bootstrap operation.

### 2. Project scaffold writes the full syntax default

`loaf config init` writes:

```text
<cwd>/.loaf/.config/loaf.config.json
```

The scaffold serializes the full §21 `LoafConfig` default with all six sections
and every key explicit:

- `protected_files`
- `stable_core`
- `paths`
- `commands`
- `constitution`
- `locale`

The written JSON also includes a top-level `_comment` pointing readers at the
schema documentation. `_comment` is output-only affordance, not semantic schema.
The semantic object is validated without relying on `_comment`.

The scaffold deliberately avoids hardcoded ecosystem examples. Android, TS, Rust,
or company-specific globs belong in a future preset/import layer, not the core
default.

### 3. User scaffold stays narrow

`loaf config init --global` writes:

```text
~/.loaf/config.json
```

It uses only the existing `UserConfig` shape:

```json
{
  "schema_version": 1,
  "locale": {
    "default_lang": "en"
  }
}
```

It must not write the project-level six-section config into the user file.

### 4. Runtime mirrors schema; docs are not runtime

Runtime adds a full `LoafConfig` schema/default source in
`src/core/loaf-config.ts`, mirroring `docs/schemas.ts` §21.

`src/` must not import `docs/schemas.ts`. The docs catalog remains the protocol
source; runtime mirrors the stable contract it needs to execute.

### 5. Serialization is not semantic ownership

loaf-cli serializes the whole config syntax, including skill-owned sections, but
does not interpret `commands` or `constitution` skill logic.

Slice readers remain separate:

- write-guard validates only `WriteGuardConfig`;
- user config validates only `UserConfig`;
- future command/constitution readers must validate only the sections they own.

A malformed skill-only section must not make write-guard fail closed. Only an
invalid write-guard slice should affect write-guard authorization.

### 6. Refuse overwrite

Both project and user config init refuse to overwrite an existing file:

```text
CONFIG_ALREADY_INITIALIZED
detail.config_path
exit 2
```

The command checks target existence before mkdir/write work, then uses exclusive
create (`wx`) for the final write so a race between check and write still refuses
instead of clobbering.

There is no `--force`. Users should edit the existing config or remove it before
re-running init. This matches the strict scaffold policy used by `loaf spec init`.

### 7. Dry-run classification

`loaf config init` is a scaffold-writer:

- it writes a file;
- it does not append a per-feature journal entry;
- it is not a derived projection writer.

`--dry-run` rejects with `DRY_RUN_NOT_APPLICABLE` and
`detail.command_type = "scaffold-writer"`. A preview mode would be an additional
surface area and is deferred until a concrete preset/import workflow exists.

## Consequences

- `src/core/loaf-config.ts` now has two schemas by design: full `LoafConfig`
  for syntax/default serialization, and `WriteGuardConfig` for hook slice
  validation.
- Adding fields to `docs/schemas.ts` §21 now requires updating the runtime mirror
  and the default serialization tests.
- Future `loaf config get/set` must preserve the same ownership boundary: owning
  syntax does not mean every reader validates every section.
- If preset scaffolds are added later, they should be explicit (`--from` or a
  plugin/skill mechanism) rather than changing the core default.
