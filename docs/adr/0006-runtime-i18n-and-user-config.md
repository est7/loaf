# ADR-0006 — Runtime i18n and user locale config

- Status: **Accepted and implemented**
- Date: 2026-06-02
- Scope: loaf-cli CLI/TUI presentation layer; runtime i18n catalog; user-level
  locale preference
- Supersedes:
  - `protocol.md` §18 locale-resolution text (`LOAF_LANG > loaf.config.json
    locale.default_lang > $LANG > en`). This ADR is the new decision source;
    `protocol.md` is intentionally not edited in this pure-document step.
- Related:
  - `protocol.md` §10.7 / §10.12 / §18
  - `src/core/error-catalog.ts` `ERROR_CATALOG`
  - `i18n/en.json`, `i18n/zh.json`
  - `src/cli/command-context.ts`
  - `src/core/loaf-config.ts`

## Context

loaf-cli already ships `i18n/en.json` and `i18n/zh.json`, but runtime CLI
output still uses hardcoded English at command emit sites. The existing bundles
cover enum/help/diagnostic/status labels, yet no runtime loader resolves a
locale or routes user-visible text through the catalog.

Two existing facts constrain the design:

1. **JSON is a machine contract.** `CommandContext.success` already skips the
   human text renderer in JSON mode, and `CommandContext.failure` emits a
   structured JSON envelope. Localizing JSON payload fields would break
   automation.
2. **Presentation and stable core have different error costs.** Locale,
   labels, text templates, TUI badges, and human diagnostics are presentation
   concerns. Reducers, preflight, schema validation, journal mutation, and
   projection logic must not depend on runtime language choice.

The user-facing product need is also personal rather than project-global:
users want to set a language once and have loaf remember it. That conflicts
with the general config precedence rule where project config usually outranks
user config. Locale is the exception because it is a display preference, not a
project invariant.

## Decision

### 1. Add a narrow user config file

Introduce a new user-level config at:

```text
~/.loaf/config.json
```

P0 schema:

```json
{
  "schema_version": 1,
  "locale": {
    "default_lang": "en"
  }
}
```

The schema is strict. In the first implementation phase this file only stores
`locale.default_lang`; it is not a general global configuration surface. Future
global preferences need their own concrete need and ADR/plan entry before
expanding this file.

### 2. Resolve locale with user preference above project default

Runtime locale resolution order:

1. `--lang <en|zh>` when that future flag exists
2. `$LOAF_LANG`
3. `~/.loaf/config.json.locale.default_lang`
4. project `loaf.config.json.locale.default_lang`, only as a repo default
   fallback
5. parsed ambient locale from `$LANG`, `$LC_ALL`, `$LC_MESSAGES`
6. `en`

This is an explicit exception to the generic "project config outranks user
config" ordering. Locale is presentation preference; a repository may provide a
default, but it must not override a user's persistent display language.

Unsupported ambient locale values fall back to `en`. Explicit invalid values
from `$LOAF_LANG` or user config are user declarations and must fail strictly
with exit 2 once the locale infrastructure is wired.

### 3. Keep `LOAF_CONFIG` out of user locale resolution

`LOAF_CONFIG` only overrides the project config path. It is not a user-locale
source and does not replace `~/.loaf/config.json`.

If project-locale fallback reads project config, it follows the same
`LOAF_CONFIG` project-config path override as the existing project config
loader. The override affects only step 4 in the locale order above.

### 4. Defer project-locale fallback until dispatch/root is known

Project locale fallback must not be read eagerly from `process.cwd()` for every
command. Commands can address sessions by `--feature-dir`, registry lookup, or
other dispatch paths, and an eager cwd read can pick the wrong repository
default.

Implementation rule:

- before dispatch/root is known, resolve only flag/env/user/ambient sources;
- after dispatch/root is known, project config may contribute only the repo
  default fallback.

Presentation guards still run first. `parsePresentation` failures such as
invalid `--format` or mutually exclusive presentation flags must be reported
before any locale/config IO.

### 5. Make `en.json` the runtime source

`src/core/error-catalog.ts` owns diagnostic-code semantics and canonical
English templates. The `gen:i18n` generator derives the diagnostic sections of
`i18n/en.json` and `i18n/zh.json`; runtime `src/cli/i18n.ts` loads those
generated bundles.

### 6. Runtime fallback is graceful; tests are strict

Runtime lookup order for `t(keyPath, vars)`:

1. user override, if a later implementation explicitly adds one
2. selected built-in locale
3. built-in `en`
4. raw key path

Missing translations must not abort user operations. In particular, a missing
translation after a journal append must not throw and turn a successful mutation
into a failed CLI process.

Missing interpolation variables are rendered by leaving `{var}` in the output.
They do not throw at runtime. Tests must catch placeholder drift.

Test-time discipline is strict:

- every runtime-emitted i18n key exists in both `en` and `zh`;
- selected diagnostic placeholders match `ERROR_CATALOG`;
- dynamic key construction at call sites is disallowed unless hidden behind
  typed domain helpers with enum cross-product tests.

### 7. JSON is never localized

JSON mode is a hard no-localization boundary.

This includes:

- success JSON payload fields;
- failure JSON envelope fields, including `message`;
- stable IDs, codes, enum values, and machine-readable detail objects.

Human text may localize only through lazy presentation renderers:

```ts
textRenderer?: (i18n: I18n) => string
```

Existing zero-argument renderers remain source-compatible because the extra
argument can be ignored.

Advisory lines are stderr presentation, not JSON payload. They may localize,
but must stay lazy:

```ts
advisories?: SuccessAdvisories | ((i18n: I18n) => SuccessAdvisories)
```

### 8. Preserve diagnostic granularity

One-to-one diagnostic codes use:

```text
diagnostic.<CODE>
```

Broad codes such as `USAGE` do not collapse into one template. Site-specific
human messages use:

```text
failure.<site>.<reason>
```

The emitted machine code remains stable, for example `code: "USAGE"`.

`diagnostic.<CODE>.<reason>` is allowed only when the reason is reusable across
sites and genuinely belongs to the diagnostic-code abstraction.

The synchronization invariant is:

- every emitted failure has a known diagnostic `code`;
- every `diagnostic.<CODE>` root maps to a known `DiagnosticCode`;
- one-to-one diagnostic templates have placeholder parity with
  `ERROR_CATALOG`;
- broad/site keys explicitly map to their emitted code.

### 9. Keep locale out of stable core

Implementation layering:

- `src/core/user-config.ts`: pure IO/schema only for user config.
- `src/cli/i18n.ts`: locale resolver, bundle loading, `createI18n`, `t`.
- `src/cli.tsx` / `CommandContext`: wiring and presentation rendering.
- reducer, preflight, journal mutation, projection loading/writing, and stable
  schema modules: no locale/i18n imports.

This keeps the unavoidable i18n complexity in the CLI presentation layer and
prevents stable-core behavior from depending on user display preference.

## Consequences

- `protocol.md` §18 must be revised in a later doc/implementation step to point
  at this ADR and replace the stale locale-resolution order.
- P0 implementation can add a new user-visible failure path for explicit invalid
  locale. The correct acceptance criterion is "valid-input English output does
  not change", not "no UI behavior changes at all".
- Project locale is only a default. It cannot override a user's configured
  `~/.loaf/config.json` locale.
- Runtime fallback protects users from catalog drift, but strict tests prevent
  fallback from becoming a permanent hidden failure.
- JSON automation remains byte-stable across i18n migration phases.
- Broad diagnostic codes keep their machine meaning while allowing human text
  to stay precise per call site.

## Implementation gates

Implementation must proceed in phases:

1. ADR-0006 accepted.
2. P0 locale parser/resolver/user-config tests before CLI wiring.
3. P0 CLI wiring with no valid-input English text changes.
4. Runtime key inventory gate before migrating TUI/enum labels.
5. P1 presentation one-to-one migration.
6. P2 diagnostics, starting with one-to-one codes.
7. P3 success/advisory text.

Required regression checks:

- invalid `--format` plus invalid `$LOAF_LANG` reports `INVALID_FORMAT`;
- invalid explicit locale exits 2 in text and JSON modes;
- failure JSON `message` remains canonical English;
- `LOAF_LANG=zh --format=json` leaves representative success/failure JSON
  byte-stable;
- invalid user config tests inject home/path dependencies and do not touch real
  `~/.loaf`;
- project-locale fallback tests cover the dispatch/root rule, including
  `--feature-dir`;
- dynamic i18n keys are banned or covered by typed-helper enum cross-product
  tests.

## Alternatives considered

### A. Environment-only locale

Rejected. `$LOAF_LANG` is useful for CI and temporary overrides, but it does not
meet the product need to set a language once and have loaf remember it.

### B. Store user language primarily in project `loaf.config.json`

Rejected. A repository default is useful, but language is a personal display
preference. Project config overriding user preference would surprise users and
make switching between repositories unnecessarily noisy.

### C. Expose `ctx.i18n` broadly

Rejected for P0. A broad context handle encourages action bodies to translate
before output routing and mutation boundaries. Lazy renderers keep localization
inside presentation output paths and preserve JSON laziness.

### D. One template per `DiagnosticCode`

Rejected. `USAGE` and other broad codes have many site-specific human messages.
Forcing one template per code would erase useful meaning and create a shallow
catalog abstraction.

## Follow-ups

- Implement P0 locale infrastructure and tests.
- Update `protocol.md` §18 to reference this ADR and remove the stale locale
  resolution order.
- Add runtime key inventory tests before P1 TUI/enum migration.

## Amendment — 2026-07-19

Issue [#13](https://github.com/est7/loaf/issues/13) supersedes the path-related
parts of Decision §3 and resolves the documentation drift:

- `protocol.md` §10.3 no longer specifies an XDG user-config contract.
  `~/.loaf/config.json` is the user config within the established `~/.loaf/`
  estate for config, crashes, and registry state.
- `LOAF_CONFIG` is explicitly deprecated. It was never implemented and has zero
  runtime readers, so it does not override project config or participate in
  locale resolution.
- Platform convention, a customizable config root, config/state separation,
  and expectations created by published documentation were considered. The
  established `~/.loaf/` de-facto standard, including `config init --global`,
  outweighed those benefits.

This amendment records the correction without rewriting the historical
decision text above. The project-config path remains
`<cwd>/.loaf/.config/loaf.config.json`.
