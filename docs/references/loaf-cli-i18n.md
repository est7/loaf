# loaf-cli runtime i18n — reference

How the CLI/TUI localization layer works and how to add a localized string.
Decision record: `docs/adr/0006-runtime-i18n-and-user-config.md`. Resolution
order: `protocol.md` §18.3. Shipped in v0.2.0.

## Mental model

- Catalogs are `i18n/en.json` + `i18n/zh.json`. `src/core/error-catalog.ts`
  owns diagnostic codes and canonical templates; `gen:i18n` derives each
  bundle's `diagnostic` section from that catalog. `src/cli/i18n.ts` loads the
  generated bundles at runtime.
- `resolveLocale()` (pure, `src/cli/i18n.ts`) picks the locale; `createI18n()`
  builds `t(keyPath, vars)`. Wiring is in `src/cli.tsx` (after the presentation
  guard, before any command action) and injected into `CommandContext`.
- Locale order: `--lang` (future) > `$LOAF_LANG` > `~/.loaf/config.json`
  `locale.default_lang` > project `loaf.config.json` locale > parsed
  `$LANG`/`$LC_ALL`/`$LC_MESSAGES` > `en`.

## Hard invariants (do not break)

- **JSON is never localized.** Success payloads and failure JSON `message` are
  canonical English. `t()` runs only in text renderers (`textRenderer?: (i18n)
  => string`) and lazy advisories (`(i18n) => SuccessAdvisories`). The
  JSON/text split already exists in `CommandContext` — i18n hooks the text leg.
- **Graceful at runtime, strict at test time.** Lookup falls back
  locale → `en` → raw key; a missing key/var never aborts a command (missing
  var keeps `{var}` literal). Tests assert every runtime-emitted key exists in
  both `en` and `zh`.
- **No dynamic keys at call sites.** No `t(\`x.${v}\`)` / `t("x." + v)`. Keys
  per closed enum go through typed helpers in `src/cli/runtime-i18n-keys.ts`
  (each map is `satisfies Record<Enum, string>`, so a new enum member fails
  typecheck). A test gate forbids dynamic-key construction.
- **Stable core stays i18n-free.** reducer / preflight / journal / projection /
  `src/core` import no i18n. Only `src/cli.tsx`, `command-context.ts`,
  `i18n.ts`, `runtime-i18n-keys.ts`, and the TUI render layer touch it.
- **`dist/cli.mjs` rebuilt only on release** (`chore(release)`), never on a
  feature commit.

## Key namespaces

| Namespace | What | Helper |
|---|---|---|
| `status_indicator.*` `task_kind.*` `evidence_kind.*` `finding_*.*` `pending_kind.*` `phase.*` `sub_state.*` `task_status.*` `finding_status.*` | enum labels | `statusIndicatorKey` / `taskKindKey` / … in `runtime-i18n-keys.ts` |
| `diagnostic.<CODE>` | 1:1 diagnostic codes (INVALID_FORMAT, dispatch series, …) | `diagnosticKey(code)`; routed by `emitKeyedFailure` when the code is a `MIGRATED_DIAGNOSTIC_CODE` and `diagnosticVarsFor` can build its vars |
| `failure.<site>.<reason>` | broad/reused codes (USAGE, NO_SESSION, SCHEMA_VALIDATION_FAILED, INPUT_FILE_NOT_FOUND) | explicit `ctx.failureKeyed(<code>, FAILURE_SITE_KEYS.*, vars, detail)`. Mapped to a code + English template in `FAILURE_SITE_TEMPLATES` (independent of ERROR_CATALOG — broad codes are one-to-many) |
| `success.*` | command success stdout + stderr advisories | `SUCCESS_KEYS` |
| `chrome.status.*` `chrome.tasks.*` … `chrome.tui.*` | read-only command + TUI structural labels | `CHROME_KEYS`; TUI composition in `src/cli/tui/chrome.ts` |

## Adding a localized string

1. Pick the namespace. For an enum value, reuse / extend the typed helper map
   (it is `satisfies Record<Enum, string>`). For a broad-code failure, add a
   `FAILURE_SITE_KEYS` entry + `FAILURE_SITE_TEMPLATES` row.
2. Add the key to **both** `i18n/en.json` and `i18n/zh.json`. Placeholders
   (`{var}`) must match between locales and the template registry.
3. Render via `i18n.t(KEY, vars)` in the text renderer; never inline the string
   and never localize the JSON branch.
4. Count-sensitive text uses explicit `*_one` / `*_many` keys, not a `{plural}`
   placeholder (en/zh pluralization differ; the key gate catches asymmetry).
5. `bun run test` — the runtime-key gates (`tests/cli/runtime-i18n-keys.test.ts`)
   assert en+zh presence, placeholder symmetry, and no dynamic keys.

## Deliberately English / raw (not a bug)

`next:` / `error:` prefixes; diagnostic CODE values; JSON payloads; ID/path-only
stdout; the `cursor` sub_state token; `en` fixed-column list cells (raw
single-token enums, scriptable); actionable command strings (the command itself
is data); `INVALID_LOCALE` (locale-resolution failure cannot depend on a
resolved i18n instance).

## Resolved drift — user config path

ADR-0006 places the user **locale** preference at `~/.loaf/config.json`
(matching the `~/.loaf/` registry/crashes estate; a set-once display
preference). `protocol.md` §10.3 now defines that same path as the single
user-level loaf estate root, so locale resolution and general user config no
longer disagree.
