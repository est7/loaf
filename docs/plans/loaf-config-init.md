# Plan — `loaf config init` (project + `--global` user config scaffold)

**Status:** DESIGN LOCKED — codex signed off all decisions on the
`review/cli-lifecycle-plan` thread (2026-06-04). Ready for RED.
**Type:** new CLI command. `PUBLIC_IMPACT=true` (new surface; protocol §10.8 +
cli-inventory + catalog/i18n obligations).
**Self-contained:** this doc is the authoritative spec; a fresh context can
execute it without re-deriving. Per-cycle ground truth still lands in thick
commit bodies.

---

## 1. Goal

Fill the onboarding gap: there is no command to generate a config file. Add a
scaffold so users get a starting config instead of hand-copying
`loaf.config.example.json`.

```
loaf config init             → scaffold project config  <repoRoot>/.loaf/.config/loaf.config.json
loaf config init --global    → scaffold user config     ~/.loaf/config.json
```

Both: no journal entry (config is not in the per-feature journal). Refuse to
overwrite an existing file.

## 2. Command shape (Q1 — LOCKED)

- New `loaf config` namespace; `init` subcommand; `--global` scope flag.
- Rationale: loaf's CLI is **noun-first** (`spec init`, `tasks add`,
  `pending raise`, `gate decide`). `loaf spec init` is the direct precedent —
  scaffold under the noun it initializes. Internal consistency (Ousterhout:
  same thing same way *within this system*) over copying git's bare `init`.
  `--global` matches `git config --global` and clearly means cross-project
  user config. `config` namespace stays free for the protocol-anticipated
  `loaf config get/set` (§10.8 line 960).

## 3. What gets written

### Project (`loaf config init`) — Q2 + Q3 LOCKED
- Serialize the **full §21 `LoafConfig` defaults** (docs/schemas.ts:2273) —
  all 6 sections, **every key explicit**: `protected_files: []`,
  `stable_core: []`, `paths.{source:["src/**"], tests:[...], docs:[...], ui:[],
  public_api:[], schema:[], security:[]}`, `commands.{run:[],lint:[],...}`,
  `constitution.{tdd_strictness:"preferred", default_ceremony_label:"standard",
  ...}`, `locale.{default_lang:"en"}`, plus `schema_version`.
- Add a top-level `_comment` pointing at the schema doc (discoverability). The
  `_comment` is an **output affordance only** — NOT part of the parsed semantic
  schema. **NO hardcoded example globs** (no Android/TS/Rust presets — those are
  skill/plugin land or a future `--from`, not core).
- Write **all 6 sections incl. skill-owned `commands` / `constitution`**.
  Override semantics make this clean: each reader takes its own sections, ignores
  the rest.

### User (`--global`) — LOCKED
- Write **ONLY** the existing `UserConfig` shape: `{schema_version, locale:{
  default_lang}}` to `~/.loaf/config.json`. **Do NOT** write the 6-section
  project config under `--global`.

## 4. Runtime schema source (Q3 consequence — the one real prep)

To derive the full project scaffold from a single source, runtime needs the
**complete `LoafConfig` schema/defaults**. Currently `src/core/loaf-config.ts`
mirrors ONLY the write-guard slice (`WriteGuardConfig` =
protected_files+stable_core+paths).

**Do:**
- Add a runtime full-schema/default source: `src/core/loaf-config-schema.ts`
  (sibling) OR extend `loaf-config.ts`. Mirror §21 `LoafConfig`.
- **Keep `WriteGuardConfig` slice + its parser SEPARATE** — the write-guard hook
  keeps reading only its slice. A malformed skill-only section
  (`commands`/`constitution`) must **NOT** make write-guard fail closed; only an
  invalid write-guard slice does.
- **Do NOT import `docs/schemas.ts` into runtime.** docs is the catalog; runtime
  mirrors it (docs may later import/mirror runtime, never the reverse — matches
  the existing "runtime mirrors a subset of docs/schemas.ts" pattern).
- **Boundary rule (write this into the ADR):** loaf-cli OWNS the full
  `LoafConfig` **syntax** (schema + default serialization) but does NOT
  **interpret** `commands`/`constitution` skill logic. Serialization ≠ semantic
  ownership. Do NOT make every runtime config reader validate every section
  (that would couple write-guard availability to skill-only config edits).

## 5. Overwrite policy (Q4 + A — LOCKED)
- Refuse if the target file exists. Code `CONFIG_ALREADY_INITIALIZED` (aligned to
  `SPEC_ALREADY_INITIALIZED`), exit 2, detail `{config_path}`.
- Check existence **before any write/scaffold I/O** (mkdir, temp write,
  validation-write). The existence check is itself I/O — phrase it precisely.
- Use **exclusive create (`wx`)** on the final write so a race between check and
  write still yields the refusal (no `--force`, so no clobber path).
- **No `--force`** — consistency with `loaf spec init` (refuse + "edit or remove
  before re-init"). Do NOT retrofit `spec init --force`.

## 6. Mechanical (spec-init precedent — LOCKED)
- `mkdir -p` the target dir (`.loaf/.config/` or `~/.loaf/`).
- Validate the composed **semantic** config (post-parse) against the full
  `LoafConfig` zod before writing — zero partial-write risk.
- Output: `ctx.success({ ok:true, config_path }, text)`; JSON mode same shape.
- `repoRoot = process.cwd()` (test-injectable; comment it **cwd-root**, NOT
  git-root discovery — project config resolution is fixed to cwd).
- `--global` uses `os.homedir()` (test-injectable home, per existing
  `userConfigPath(homeDir)`).
- Pretty, stable JSON (sorted/deterministic) so re-scaffolds diff cleanly.

## 7. Surface obligations (PUBLIC_IMPACT)
- **protocol/docs:** `docs/protocol.md` §10.8 command table — add `loaf config`
  / `loaf config init` rows; add the `loaf config` scope note (project default +
  `--global` user). Resolve dry-run classification (§10.7 + sc6c): a scaffold
  that writes a file but no journal entry — classify like `spec init` (decide
  read-only-reject vs wrapping). **OPEN — resolve during impl.**
- **inventory gate:** `tests/scripts/cli-inventory.test.ts` baseline +
  `inventory/help-collector` + `protocol-parser` will demand the new command be
  present in both help and protocol §10.8 (cross-checked).
- **catalog + i18n:** `CONFIG_ALREADY_INITIALIZED` → `docs/schemas.ts`
  DiagnosticCode enum + ERROR_CATALOG (message_template / fix_template /
  doc_anchor) + `i18n/en.json` + `i18n/zh.json` (placeholder symmetry — sc5a
  gate). NOTE: gate-check/explicit-message codes can render via emitFailure
  graceful fallback, but a top-level scaffold refusal should have a proper
  catalog+i18n entry.
- **help text:** `init` description must state the default project path and that
  `--global` writes `~/.loaf/config.json`.

## 8. ADR (B — LOCKED, write it)
- `docs/adr/0007-config-init-scaffolds-full-project-config.md` (next ADR number;
  current max is 0006).
- Capture: full-config scaffold includes **skill-owned** sections while runtime
  refuses to **interpret** skill logic; "schema/default serialization ≠ semantic
  ownership"; "write-guard remains slice-validated"; why kept under `config`
  (noun-first internal consistency) not bare `loaf init`.

## 9. Implementation order (one sub-cycle = one commit, RED→impl→codex audit→commit)
1. **Runtime full-schema source** — mirror §21 `LoafConfig` into runtime; keep
   `WriteGuardConfig` slice separate. RED: defaults round-trip + match §21; a
   malformed skill-only section does NOT fail the write-guard slice parse.
2. **Diagnostic code** — `CONFIG_ALREADY_INITIALIZED` → catalog + en/zh i18n.
   RED: sc5a placeholder symmetry + catalog membership.
3. **Command** — register `loaf config` namespace + `init` + `--global` in
   `src/cli.tsx` (model on `spec init` ~line 5679 + a noun-namespace like
   `tasksCmd`). RED (cli.test.ts real-FS): project init writes valid 6-section
   file + `_comment`; re-run → CONFIG_ALREADY_INITIALIZED; `--global` writes
   `{schema_version, locale}` only; validate-before-write; `wx` race; output
   shape (text + JSON); dry-run classification behavior.
4. **Surface** — protocol §10.8 (+ scope note + dry-run row); cli-inventory
   baseline; help text. RED: cli-inventory green.
5. **ADR** — 0007.
6. **codex independent audit** → commit (thick body: decisions + RED + boundary
   rationale + residual risk).

## 10. Key files / pointers
- `src/cli.tsx` — `spec init` precedent ≈ line 5679 (refuse-overwrite via
  `access` + `emitFailure(SPEC_ALREADY_INITIALIZED)`, `mkdir {recursive}`,
  validate-before-write, `ctx.success({ok,...path})`). Noun-namespace pattern:
  `tasksCmd`/`specCmd`. `runMutator`/`mctxFor` NOT used (no journal entry).
- `src/core/loaf-config.ts` — `WriteGuardConfig` slice, `loafConfigPath(repoRoot)`
  = `<repoRoot>/.loaf/.config/loaf.config.json`. Add full-schema source here/sibling.
- `LOAF_CONFIG` was never implemented and is deprecated; it is not a project-config
  path override.
- `src/core/user-config.ts` — `UserConfig` ({schema_version, locale}),
  `userConfigPath(homeDir)` = `<home>/.loaf/config.json`.
- `docs/schemas.ts:2273` — §21 `LoafConfig` (the full schema to mirror).
- `loaf.config.example.json` — reference for the `_comment` text (do NOT
  hardcode its example globs).
- `CONTEXT.md` — config-scope glossary (project vs user config; kernel- vs
  skill-owned sections) — already written this session.
- Gates: `tests/scripts/cli-inventory.test.ts` (+ `inventory/diagnostic-baseline.json`),
  `tests/scripts/sc5a-surface-gate.test.ts` (catalog↔i18n), `sc6c` (dry-run table).

## 11. Open items to resolve during impl
- **Dry-run classification** of `loaf config init` (§10.7 + sc6c READ_ONLY table):
  it writes a file, no journal entry. Decide reject-`--dry-run` (like a wrapping
  / projection-writer) vs a dry-run preview. Lean: reject `--dry-run` (scaffold
  is a one-shot write; preview adds surface). Confirm against §10.7 categories.
- **`_comment` vs strict parse:** confirm the full `LoafConfig` zod strips
  unknown top-level keys (so the written `_comment` round-trips through validate-
  before-write). If the schema is `.strict()`, either validate the config WITHOUT
  `_comment` (validate the semantic object, attach `_comment` only to the written
  JSON) or relax. codex flagged: "validation target is semantic config after
  parse; written JSON may carry `_comment`."

## 12. Decision log (codex sign-off 2026-06-04, thread review/cli-lifecycle-plan)
Q1 `loaf config init` + `--global` (noun-first; git scope word) ✅
Q2 full explicit defaults + `_comment` (output-only); validate post-parse; no hardcoded examples ✅
Q3 all 6 sections; runtime full-schema source + separate WriteGuardConfig slice; no docs→runtime import; write-guard slice-validated; serialization ≠ interpretation ✅
Q4 refuse-overwrite, `CONFIG_ALREADY_INITIALIZED`, check-before-write-IO, `wx` exclusive create ✅
A no `--force`, no spec-init retrofit ✅
B write ADR 0007 ✅
