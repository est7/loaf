#!/usr/bin/env bash
# ga-package-smoke.sh — GA-cut packaged-artifact smoke test.
#
# Per codex r183/r184 (findings.md F-020), verifies the package can be
# packed and run from a clean install — NOT just from the repo dist.
# Smoke depth held to r183 minimum ceiling (--version / start / status /
# doctor --rebuild + loaf_version_required pin assertion); broader
# lifecycle smoke is a Phase 16 concern.
#
# Steps (first failure exits non-zero with a stable code on stderr):
#   1. DIST_MISSING       — $package_root/dist/cli.mjs missing
#   2. PACK_FAILED        — bun pm pack errored or produced no tarball
#   3. INSTALL_FAILED     — bun add of the tarball errored
#   4. VERSION_MISMATCH   — `loaf --version` != package.json.version
#   5. START_FAILED       — `loaf start` errored
#   6. STATUS_FAILED      — `loaf status` errored
#   7. DOCTOR_REBUILD_FAILED — `loaf doctor --rebuild` errored
#   8. PIN_MISMATCH       — state.json.loaf_version_required != expected-pin
#
# Usage:
#   scripts/ga-package-smoke.sh [--package-root <path>] [--expected-pin <literal>]
#
# Defaults:
#   --package-root  $PWD
#   --expected-pin  ^${package.json.version}  (strict literal equality)
#
# Cleanup: trap on EXIT removes pack dir + install dir under TMPDIR.
# Repo is never written to.

set -euo pipefail

package_root="$PWD"
expected_pin=""

usage() {
  cat >&2 <<EOF
Usage: ga-package-smoke.sh [--package-root <path>] [--expected-pin <literal>]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --package-root)
      [ $# -ge 2 ] || { echo "USAGE: --package-root requires a path" >&2; usage; exit 2; }
      package_root="$2"; shift 2 ;;
    --expected-pin)
      [ $# -ge 2 ] || { echo "USAGE: --expected-pin requires a literal" >&2; usage; exit 2; }
      expected_pin="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "USAGE: unknown flag: $1" >&2; usage; exit 2 ;;
  esac
done

fail() {
  echo "$1: $2" >&2
  exit 1
}

if [ ! -f "$package_root/package.json" ]; then
  fail "USAGE" "package.json not found in $package_root"
fi

# ── 1. DIST_MISSING ──────────────────────────────────────────────
if [ ! -f "$package_root/dist/cli.mjs" ]; then
  fail "DIST_MISSING" "$package_root/dist/cli.mjs not found; run 'bun run build' first"
fi

# Read package.json.version + name via Node (no jq per codex r184 Q1).
pkg_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$package_root/package.json")
pkg_name=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).name)" "$package_root/package.json")
if [ -z "$pkg_version" ] || [ -z "$pkg_name" ]; then
  fail "USAGE" "package.json missing name/version in $package_root"
fi

if [ -z "$expected_pin" ]; then
  expected_pin="^$pkg_version"
fi

# ── trap cleanup ─────────────────────────────────────────────────
packdir=$(mktemp -d -t "ga-pack-XXXXXX")
installdir=$(mktemp -d -t "ga-install-XXXXXX")
cleanup() {
  rm -rf "$packdir" "$installdir"
}
trap cleanup EXIT

# ── 2. PACK_FAILED ───────────────────────────────────────────────
# `bun pm pack --quiet --destination` writes the tarball there; --quiet
# emits only the filename on stdout. Run from package_root.
pack_out=""
if ! pack_out=$(cd "$package_root" && bun pm pack --quiet --destination "$packdir" 2>&1); then
  fail "PACK_FAILED" "bun pm pack errored: $pack_out"
fi
tarball=$(find "$packdir" -maxdepth 1 -name '*.tgz' -print -quit 2>/dev/null || true)
if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  fail "PACK_FAILED" "no tarball produced in $packdir (bun output: $pack_out)"
fi

# ── 3. INSTALL_FAILED ────────────────────────────────────────────
# Use absolute tarball path per codex r184 Q2. Run install in an
# isolated install dir; suppress lifecycle scripts to keep the smoke
# deterministic.
install_out=""
if ! install_out=$(cd "$installdir" && bun add "$tarball" --no-save --silent 2>&1); then
  fail "INSTALL_FAILED" "bun add failed: $install_out"
fi
loaf_bin="$installdir/node_modules/.bin/loaf"
if [ ! -x "$loaf_bin" ]; then
  fail "INSTALL_FAILED" "$loaf_bin missing or not executable after install"
fi

# ── 4. VERSION_MISMATCH ──────────────────────────────────────────
# Codex r185 BLOCK: substring matching (grep -qF) would let pkg '1.2.3'
# pass against a binary printing '1.2.30'. Enforce strict equality on
# the first line, after trimming trailing CR/LF. Accept either bare
# 'X.Y.Z' or 'loaf X.Y.Z' (future-proofing for a possible prefix), but
# nothing else.
version_out=""
if ! version_out=$("$loaf_bin" --version 2>&1); then
  fail "VERSION_MISMATCH" "loaf --version errored: $version_out"
fi
version_token=$(printf '%s' "$version_out" | head -n1 | tr -d '\r')
case "$version_token" in
  "$pkg_version"|"loaf $pkg_version") ;;
  *) fail "VERSION_MISMATCH" "loaf --version='$version_token' != '$pkg_version' (strict equality required; substring match disallowed per r185)" ;;
esac

# ── 5/6/7. Lifecycle smoke against an isolated feature dir ───────
workdir="$installdir/work"
mkdir -p "$workdir"
feature="ga-smoke"

start_out=""
if ! start_out=$("$loaf_bin" start "$feature" --ceremony quick --feature-dir "$workdir" --format json 2>&1); then
  fail "START_FAILED" "loaf start errored: $start_out"
fi

status_out=""
if ! status_out=$("$loaf_bin" status --feature "$feature" --feature-dir "$workdir" --format json 2>&1); then
  fail "STATUS_FAILED" "loaf status errored: $status_out"
fi

doctor_out=""
if ! doctor_out=$("$loaf_bin" doctor --rebuild --feature "$feature" --feature-dir "$workdir" 2>&1); then
  fail "DOCTOR_REBUILD_FAILED" "loaf doctor --rebuild errored: $doctor_out"
fi

# ── 8. PIN_MISMATCH ──────────────────────────────────────────────
# `--feature-dir <path>` makes <path> the literal feature dir; state.json
# lives at $workdir/snapshots/state.json (verified against current
# dist/cli.mjs on 2026-05-25, src/core/projection-schema.ts state surface).
state_path="$workdir/snapshots/state.json"
if [ ! -f "$state_path" ]; then
  fail "PIN_MISMATCH" "state.json not found at $state_path after lifecycle smoke"
fi
actual_pin=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).loaf_version_required)" "$state_path")
if [ "$actual_pin" != "$expected_pin" ]; then
  fail "PIN_MISMATCH" "state.json.loaf_version_required='$actual_pin' != expected='$expected_pin'"
fi

exit 0
