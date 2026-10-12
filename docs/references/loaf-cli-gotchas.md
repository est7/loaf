# loaf-cli — gotchas for consumers

> **Audience**: `loaf-skill` authors and other downstream consumers
> wrapping the `loaf` CLI. Each entry is a real pitfall someone has hit;
> the fix is documented so you don't have to re-derive it.

## 1. `bun` blocks the `prepare` lifecycle script for untrusted github installs

**Symptom**: `bunx github:est7/loaf --version` errors with
`could not determine executable to run for package`, and inspecting
the install shows `Blocked 1 postinstall. Run `bun pm untrusted` for
details.`

**Root cause**: bun (≥ 1.3) refuses to run `prepare` / `postinstall`
scripts for packages installed from a github URL by default — security
mitigation against arbitrary code execution from random repos.

**Fix in loaf-cli**: `dist/cli.mjs` is committed to the repo via a
`.gitignore` exception (`dist/*` + `!dist/cli.mjs`). Consumers do NOT
need a `prepare` script to build on install; the bundled binary is
already there.

**If you publish your own github-installable Node CLI**: either commit
your build artifact too (standard pattern for github-only distribution),
or document `bun add --trust github:user/repo` workaround. Do not rely
on `prepare` for untrusted installs.

## 2. `--feature-dir <path>` is the *literal* feature directory, not its parent

**Symptom**: you pass `--feature-dir $TMPDIR --feature foo`, then look
for state.json at `$TMPDIR/foo/snapshots/state.json` and it isn't
there.

**Root cause**: `--feature-dir` replaces `.loaf/<feature>` entirely.
The flag value IS the feature dir; the `<feature>` argument is
metadata stamped onto entries, not a path segment.

**Where things live with `--feature-dir $WORK --feature foo`**:

```
$WORK/journal.jsonl
$WORK/snapshots/state.json
$WORK/snapshots/_meta.json
$WORK/snapshots/tasks.json   # once a task plan exists
$WORK/snapshots/evidence.json
$WORK/snapshots/findings.json
$WORK/snapshots/pending.json
$WORK/attachments/<JE-id>/
$WORK/.lock
```

When you want multiple features in one parent dir, give each its own
`--feature-dir`: `--feature-dir $PARENT/foo` and `--feature-dir
$PARENT/bar`.

## 3. CLI exit codes — 0 / 2 / 1 / 130, and uninitialized reads exit 2

**Symptom**: a script that probed for "is a loaf session initialized
here?" via `loaf status` exit 0 / `state: null` (the rev-3.x scaffold
behavior) suddenly sees exit 2.

**Root cause**: Phase 15 SC3 unified the four read commands (`status`
/ `tasks list` / `pending list` / `finding list`) to exit 2 with
`FEATURE_NOT_FOUND` when selection cannot find a session, including an
empty or nonexistent feature directory. If selection reaches the projection
loader but no session journal exists, it returns `NO_SESSION`. `status`
previously was the odd one out (exit 0 + `state: null`).

**Exit code semantics**:

- `0` — success
- `2` — system error, invalid input, missing session, snapshot stale,
  preflight failure, etc. With `--format json`, stderr carries one
  `{ok:false,code,message,detail}` diagnostic line (`DiagnosticCode`, owned
  by `src/core/error-catalog.ts`). Text mode uses `error: CODE — message`
  with catalog fix/see information when available.
- `1` — unexpected crash (crash log).
- `130` — SIGINT. There is no reserved exit 3.

For "is a loaf session here?" probes, **inspect exit code AND the
`code` field on stderr JSON** rather than relying on stdout shape.

## 4. `loaf_version_required` accepts full semver, prerelease + build metadata

**Symptom**: passing `^0.1.0-rc.1` or `~1.2.3+build.5` as a version pin
worked silently in rev-3 scaffold but was rejected at session:started
in early rev-5; current code accepts it.

**Root cause**: the regex was widened in `e1bdc9c` (RC blocker fix)
from `/^[\^~]?\d+\.\d+(\.\d+)?$/` to
`/^[\^~]?\d+\.\d+(\.\d+)?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/`.
Legacy pins (`^0.1.0`, `~1.0`) still parse; semver prerelease/build
identifiers now also parse.

**For loaf-skill**: when constructing version pins to compare against
`state.json.loaf_version_required`, follow the same regex. Do not
strip prerelease/build segments — they are preserved verbatim through
journal → projection.

## 5. `loaf --version` output is exactly `X.Y.Z\n` — strict equality, no substring match

**Symptom**: a verification script doing `grep -qF "1.2.3"` on the
output sees `1.2.30` and incorrectly passes.

**Root cause**: codex r185 caught exactly this during SC-B review.
`bun pm pack` + install + run `loaf --version` outputs the package
version on a single line, no `loaf ` prefix today. **Always compare
the version token with strict equality** (after stripping the trailing
LF/CR), not substring containment.

**Reference implementation**: `scripts/ga-package-smoke.sh` step 4
uses a `case` pattern accepting either `X.Y.Z` or `loaf X.Y.Z`
verbatim:

```bash
version_token=$(printf '%s' "$version_out" | head -n1 | tr -d '\r')
case "$version_token" in
  "$pkg_version"|"loaf $pkg_version") ;;
  *) fail "VERSION_MISMATCH" "..." ;;
esac
```

## 6. Strict input boundaries — caller-supplied envelope fields are rejected

**Symptom**: a skill tries to construct a `JournalEntry` and pass an
explicit `seq` / `at` / `entry_id` to the CLI and gets an input-schema
rejection.

**Root cause**: CLI input schemas reject envelope fields. Internally,
`mutateBatch` additionally rejects caller-supplied `seq`, `entry_id`, and
batch envelope fields; CLI handlers supply `at` and actor provenance.
The public CLI owns these values:

- `seq` — monotonic, allocated server-side
- `entry_id` — `JE-NNNNNN`, allocated server-side
- `at` — wall-clock timestamp, CLI-owned

Same applies to allocator-owned IDs in payloads: `id` on
`add-req` / `add-scenario` / `add-visual` / `evidence add` /
`finding raise` / `pending raise` is rejected; the CLI's allocator
stamps it from max-serial + 1 zero-pad.

**For loaf-skill**: build the *payload* (the kind-specific shape),
pass it to the corresponding `loaf <command>` verb, and let the CLI
stamp the envelope. Never compose a full `JournalEntry` yourself.

## 7. Closed `z.enum`s have no `.passthrough()` — typos silently bypass invariants

**Symptom**: a skill misspells `gate_kind: "spec-lock"` as
`"spec_lock"` and the CLI accepts the entry, then a downstream
preflight check fires unexpectedly.

**Root cause**: closed-set fields use `.strict()` + closed `z.enum`,
NOT `.passthrough()`. Slice 3 SC1 r64 BLOCK was exactly this — a typo
like `gate-decision` vs `gate_decision` would bypass invariants if
passthrough were allowed.

**For loaf-skill**: ask the CLI for the relevant mutation-input schema with
`loaf <mutator> --schema --format=json` (or use the runtime owner indexed by
`docs/machine-contract.md`) and validate your payload before shelling out.
Don't trust the CLI to silently coerce.

## 8. Use `mutateBatch` (CLI verbs), never `appendEntry` / `appendMany` directly

**Symptom**: a tool that imported `appendEntry` from a deep
`src/core/` path bypasses preflight, reducer dry-run, and sidecar promote.
Subsequent CLI reads then fail with `TAIL_CORRUPTION` or `SNAPSHOT_STALE_REBUILD_REQUIRED`.

**Root cause**: `mutateBatch` is the *only* transactional API.
`appendEntry` / `appendMany` are low-level writers; the current runtime
append caller is `mutateBatch`. Calling them directly skips mutation
admission and gate evaluation. `loaf doctor --rebuild` replays the journal
and rewrites projections; it does not append journal entries.

**For loaf-skill**: always go through the public CLI commands
(`loaf spec add-req`, `loaf tasks step done`, `loaf evidence add`,
etc.). They invoke `mutateBatch` for you with the right pipeline.
If a verb you need doesn't exist yet, raise it as a `loaf-cli` issue
rather than reaching past the boundary.

---

## Reading map

- Protocol surface: [`../protocol.md`](../protocol.md) §10 CLI Surface
- Truth model: [`../adr/0005-truth-model-single-typed-journal.md`](../adr/0005-truth-model-single-typed-journal.md)
- Error catalog: [`../../src/core/error-catalog.ts`](../../src/core/error-catalog.ts)
  `ERROR_CATALOG`
- Skill boundary contract: [`../../skills/CONTRACT.md`](../../skills/CONTRACT.md)
