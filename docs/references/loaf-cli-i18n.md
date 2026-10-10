# loaf-cli runtime i18n — reference

How the CLI/TUI localization layer works and how to add a localized string.
Decision record: `docs/adr/0006-runtime-i18n-and-user-config.md`. Resolution
order: `protocol.md` §18.3. Shipped in v0.2.0.

## Mental model

- Catalogs are `i18n/en.json` + `i18n/zh.json`. `src/core/error-catalog.ts`
  owns diagnostic codes and canonical templates; `gen:i18n` derives each
  bundle's message/fix and variant sections from that catalog.
  `src/cli/i18n.ts` loads the generated bundles at runtime.
- `resolveLocale()` (pure, `src/cli/i18n.ts`) picks the locale; `createI18n()`
  builds `t(keyPath, vars)`. Wiring is in `src/cli.tsx` (after the presentation
  guard, before any command action) and injected into `CommandContext`.
- Locale order: `--lang` (future) > `$LOAF_LANG` > `~/.loaf/config.json`
  `locale.default_lang` > project `loaf.config.json` locale > parsed
  `$LANG`/`$LC_ALL`/`$LC_MESSAGES` > `en`.

## Hard invariants (do not break)

- **JSON is never localized.** Success payloads and failure JSON `message` are
  canonical English, including nested rendered check messages. The single
  diagnostic outlet uses `DEFAULT_I18N` for JSON and the resolved locale for
  text; success/advisory localization stays on the text leg.
- **Catalog detail is a contract.** Every diagnostic declares required detail
  keys; missing required rendering data is an internal contract violation,
  not a legacy-message fallback. English generated templates are complete;
  available Chinese message/fix translations are retained and absent ones
  fall back to English. Runtime-key and rendering tests detect missing keys
  and unresolved placeholders.
- **No dynamic keys at call sites.** No `t(\`x.${v}\`)` / `t("x." + v)`. Keys
  per closed enum go through typed helpers in `src/cli/runtime-i18n-keys.ts`
  (each map is `satisfies Record<Enum, string>`, so a new enum member fails
  typecheck). A test gate forbids dynamic-key construction.
- **Stable core stays i18n-free.** reducer / preflight / journal / projection /
  `src/core` import no i18n. Only `src/cli.tsx`, `command-context.ts`,
  `i18n.ts`, `runtime-i18n-keys.ts`, and the TUI render layer touch it.
- **Generated owners stay authoritative.** Use `gen:i18n` / `gen:errors` and
  `verify:codegen`; the C3 migration retains a rebuilt `dist/cli.mjs` without
  changing release identity. Publication/versioning remains driver-owned.

## Key namespaces

| Namespace | What | Helper |
|---|---|---|
| `status_indicator.*` `task_kind.*` `evidence_kind.*` `finding_*.*` `pending_kind.*` `phase.*` `sub_state.*` `task_status.*` `finding_status.*` | enum labels | `statusIndicatorKey` / `taskKindKey` / … in `runtime-i18n-keys.ts` |
| `diagnostic.<CODE>` / `diagnostic_fix.<CODE>` | code-owned message/fix | `ERROR_CATALOG`; `writeDiagnosticFailure` derives vars from structured detail |
| `diagnostic_variant.<context>` / `diagnostic_variant_fix.<context>` | existing site variants for broad/reused codes | catalog-owned `DIAGNOSTIC_VARIANTS`; `diagnosticVariant(context, detail)` preserves data and adds `detail.context` |
| `success.*` | command success stdout + stderr advisories | `SUCCESS_KEYS` |
| `chrome.status.*` `chrome.tasks.*` … `chrome.tui.*` | read-only command + TUI structural labels | `CHROME_KEYS`; TUI composition in `src/cli/tui/chrome.ts` |

## Adding a localized string

1. Pick the namespace. Enum labels use the typed helper map. Diagnostic
   message/fix changes belong in `ERROR_CATALOG`, including required detail
   and existing context variants; callers supply data, not template vars/keys.
2. Run `bun run gen:i18n` and `bun run gen:errors` for diagnostic changes.
   Add available Chinese translations to the catalog; no invented translation
   or hand-maintained generated mirror. Non-diagnostic keys go in both bundles.
3. Expected failures call `ctx.failure(diagnostic)`; pre-context guards call
   the same `writeDiagnosticFailure` outlet. Other text renderers use typed
   `i18n.t(KEY, vars)`; never localize JSON.
4. Count-sensitive text uses explicit `*_one` / `*_many` keys, not a `{plural}`
   placeholder (en/zh pluralization differ; the key gate catches asymmetry).
5. `bun run test` — the runtime-key gates (`tests/cli/runtime-i18n-keys.test.ts`)
   assert effective en/zh lookup, placeholder symmetry, and no dynamic keys.
   Diagnostic rendering fixtures independently cover all codes and variants.

## Deliberately English / raw (not a bug)

`next:` / `error:` prefixes; diagnostic CODE values; JSON payloads; ID/path-only
stdout; the `cursor` sub_state token; `en` fixed-column list cells (raw
single-token enums, scriptable); actionable command strings (the command itself
is data); technical schema/library reasons in detail. `INVALID_LOCALE` uses
pre-context locale selection and retains rejected input/source in detail.

## Failure consumer migration

Recoverable JSON is one stderr line `{ok:false,code,message,detail}`, exit 2.
The outlet retains detail fields and adds nested check messages only during
presentation. Text includes localized message/check rows and catalog fix/see.
Commander failures use `USAGE` with raw `detail.parser_code` / `detail.reason`;
automatic parser error/help stderr is suppressed, explicit help/version still
writes stdout with exit 0. Unexpected errors keep crash exit 1 and SIGINT 130.
Consumers should use code/detail rather than old prose or parser stderr.
Existing subcodes, exact schema issue fields, TASK_DEP arrays, and commit-state
proof remain unchanged. No persisted schema or journal-byte migration is part
of this output-contract change. External consumers need a breaking-minor
release checkpoint before publication; checkout tests cannot prove their absence.

## Resolved drift — user config path

ADR-0006 places the user **locale** preference at `~/.loaf/config.json`
(matching the `~/.loaf/` registry/crashes estate; a set-once display
preference). `protocol.md` §10.3 now defines that same path as the single
user-level loaf estate root, so locale resolution and general user config no
longer disagree.
