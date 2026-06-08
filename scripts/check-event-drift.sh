#!/usr/bin/env bash
# check-event-drift.sh — flag canonical-event-name drift across design docs.
#
# Background:
#   schemas.ts §41 (Event-name registry — canonical homes) is the single
#   source of truth for event-style names. moni-review.md §2 surfaced
#   three drift names that appeared in external docs (plan.md M1 /
#   design.html) but do NOT exist in any canonical home:
#
#     finding_close   →  use FindingsEvent.event = "closed"
#     spec_init       →  no canonical event; usually meant either the
#                        state-change verb "spec submit" (protocol.md
#                        §10.12) or the hook event "session-start"
#                        (HookEvent enum, §36)
#     StepStarted     →  no canonical event; closest analogs are the
#                        state-change verb "step start" (§10.12) plus
#                        the TaskExecutionStep.started_at field (§14)
#
# This script greps a configurable scan target (default: the
# loaf-cli-design directory) for each drift name and exits non-zero on
# any hit. Hooks: pre-commit, CI on protocol-doc changes, or manual
# `bash scripts/check-event-drift.sh` invocation.
#
# Usage:
#   scripts/check-event-drift.sh                # scan current repo
#   scripts/check-event-drift.sh path/to/dir    # scan a specific path
#
# Exit codes:
#   0  no drift hits
#   1  at least one drift name was found
#   2  invocation error (missing dir, no grep, etc.)

set -euo pipefail

# ──────────────────────────────────────────────────────────────────
# Canonical drift list. Each entry: "<drift-name> <pipe> <canonical>"
# The drift name is what we grep for; the canonical hint is shown
# alongside any hit so the reader knows the fix immediately.
# Add new entries here when a future audit surfaces additional drift.
# Keep in lockstep with schemas.ts §41 "Known drift names" block.
# ──────────────────────────────────────────────────────────────────

DRIFT_ENTRIES=(
  "finding_close|FindingsEvent.event = \"closed\" (no trailing 'd' is wrong)"
  "spec_init|no canonical event; use state-change \"spec submit\" or hook \"session-start\""
  "StepStarted|no canonical event; use state-change \"step start\" or TaskExecutionStep.started_at"
)

# Files / paths that LEGITIMATELY mention the drift names because they
# are documenting the drift itself (this script, the §41 block in
# schemas.ts, the moni-review audit source, the matching ADR
# annotation, and these script comments themselves). Exclude them
# from grep — otherwise the script is permanently red.
EXCLUDE_PATHS=(
  "scripts/check-event-drift.sh"
  "schemas.ts"
  "moni-review.md"
  "adr/0004-moni-audit-resolution.md"
)

# Two reasons a directory is excluded:
#  (a) different namespace that legitimately reuses a drift-spelled identifier
#      (i18n/<lang>.json CLI-help keys like "spec_init" — translation keys, NOT events);
#  (b) generated or runtime output that is not canonical source and may echo a
#      documented drift term (dist/ bundles+sourcemaps, coverage/ reports, .agent-mail/
#      AMQ message store). Canonical src/ docs/ tests/ stay scanned.
EXCLUDE_DIRS=(
  ".git"
  ".agent-mail"
  "dist"
  "coverage"
  "i18n"
  "node_modules"
  "WangSnapshots"
)

# Default scan root — caller may override on argv.
SCAN_ROOT="${1:-.}"

if [[ ! -d "$SCAN_ROOT" ]]; then
  echo "error: scan root '$SCAN_ROOT' is not a directory" >&2
  exit 2
fi

if ! command -v grep >/dev/null 2>&1; then
  echo "error: grep not available on PATH" >&2
  exit 2
fi

# Build a single ERE pattern from drift names for one fast grep pass.
PATTERN=""
for entry in "${DRIFT_ENTRIES[@]}"; do
  drift="${entry%%|*}"
  if [[ -n "$PATTERN" ]]; then
    PATTERN="${PATTERN}|"
  fi
  PATTERN="${PATTERN}${drift}"
done

# Build grep exclude args.
EXCLUDE_ARGS=()
for d in "${EXCLUDE_DIRS[@]}"; do
  EXCLUDE_ARGS+=(--exclude-dir="$d")
done
for p in "${EXCLUDE_PATHS[@]}"; do
  EXCLUDE_ARGS+=("--exclude=$(basename "$p")")
done

# Run the scan. -rIn = recursive / skip binaries / show line numbers.
# We deliberately use ERE (-E) because the drift list may grow to
# include alternation later.
HITS_RAW=$(grep -rInE "$PATTERN" "${EXCLUDE_ARGS[@]}" "$SCAN_ROOT" 2>/dev/null || true)

if [[ -z "$HITS_RAW" ]]; then
  echo "check-event-drift: PASS (scanned '$SCAN_ROOT'; 0 drift hits)"
  exit 0
fi

# ──────────────────────────────────────────────────────────────────
# Reformat hits so each entry shows: path:line: <drift name>
#   --> canonical: <fix hint>
# Group output by drift name for readability.
# ──────────────────────────────────────────────────────────────────

echo "check-event-drift: FAIL — canonical event-name drift detected"
echo
echo "Scanned root: $SCAN_ROOT"
echo "Canonical registry: schemas.ts §41 (Event-name registry — canonical homes)"
echo

for entry in "${DRIFT_ENTRIES[@]}"; do
  drift="${entry%%|*}"
  canonical="${entry#*|}"
  drift_hits=$(printf "%s\n" "$HITS_RAW" | grep -E ":[0-9]+:.*${drift}" || true)
  if [[ -z "$drift_hits" ]]; then
    continue
  fi
  echo "---"
  echo "Drift name : ${drift}"
  echo "Canonical  : ${canonical}"
  echo "Hits:"
  printf "%s\n" "$drift_hits" | sed 's/^/  /'
done

echo
echo "Fix: replace each drift name with the canonical form above. See"
echo "schemas.ts §41 for the full registry of canonical event names."
exit 1
