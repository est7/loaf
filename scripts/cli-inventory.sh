#!/usr/bin/env bash
# cli-inventory.sh — JSON emitter for the v0.1.0-implemented loaf CLI surface.
#
# Calls the SAME collector module used by the inventory test harness
# (tests/scripts/inventory/help-collector.ts) — codex r190 constraint:
# no second parser in a shell wrapper. The TS entrypoint at
# tests/scripts/inventory/cli-entry.ts re-uses collectInventory() and
# prints the result as JSON to stdout.
#
# Usage:
#   bash scripts/cli-inventory.sh           # emit JSON to stdout
#   bun run inventory                       # same, via package.json script
#
# Output: a JSON object with { globalFlags, commands } as defined in
# tests/scripts/inventory/help-collector.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

exec bun run --silent "$REPO_ROOT/tests/scripts/inventory/cli-entry.ts" "$@"
