#!/usr/bin/env bash
# ga-consistency-check.sh — GA-cut release parity gate.
#
# Per codex r183/r184 (findings.md F-020), verifies the repo state is
# safe to tag for GA release. Intended to run AFTER the release/checklist
# commit is committed and pushed. Uncommitted version bumps WILL fail
# WORKTREE_DIRTY by design.
#
# Checks (first failure exits non-zero with a stable machine-readable
# code on stderr):
#   1. WORKTREE_DIRTY     — git status --porcelain is non-empty
#   2. VERSION_TAG_MISMATCH — package.json.version != expected-tag minus v
#   3. CHANGELOG_MISSING  — no `## [<version>]` entry OR no matching
#                            `[<version>]: .../<expected-tag>` link line
#   4. HEAD_NOT_ORIGIN    — git HEAD != origin/main (after fetch unless
#                            --no-fetch)
#
# Usage:
#   scripts/ga-consistency-check.sh [--repo <path>] [--expected-tag <vX.Y.Z>] [--no-fetch]
#
# Env:
#   GA_REPO_ROOT — alternative to --repo (flag wins if both set)
#
# Failure codes go to stderr as `<CODE>: <human suffix>`. Tests assert
# the code, not the suffix.

set -euo pipefail

repo="${GA_REPO_ROOT:-$PWD}"
expected_tag=""
no_fetch=0

usage() {
  cat >&2 <<EOF
Usage: ga-consistency-check.sh [--repo <path>] [--expected-tag <vX.Y.Z>] [--no-fetch]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || { echo "USAGE: --repo requires a path" >&2; usage; exit 2; }
      repo="$2"; shift 2 ;;
    --expected-tag)
      [ $# -ge 2 ] || { echo "USAGE: --expected-tag requires a value" >&2; usage; exit 2; }
      expected_tag="$2"; shift 2 ;;
    --no-fetch)
      no_fetch=1; shift ;;
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

if [ ! -d "$repo/.git" ]; then
  fail "USAGE" "not a git repo: $repo"
fi
if [ ! -f "$repo/package.json" ]; then
  fail "USAGE" "package.json not found in $repo"
fi

# Read package.json.version via Node (no jq dependency per codex r184 Q1).
pkg_version=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).version)" "$repo/package.json")
if [ -z "$pkg_version" ]; then
  fail "USAGE" "package.json.version is empty in $repo"
fi

# Default expected_tag = v${pkg_version}.
if [ -z "$expected_tag" ]; then
  expected_tag="v$pkg_version"
fi

# ── 1. WORKTREE_DIRTY ─────────────────────────────────────────────
porcelain=$(git -C "$repo" status --porcelain)
if [ -n "$porcelain" ]; then
  fail "WORKTREE_DIRTY" "git status --porcelain is non-empty in $repo"
fi

# ── 2. VERSION_TAG_MISMATCH ───────────────────────────────────────
tag_without_v="${expected_tag#v}"
if [ "$pkg_version" != "$tag_without_v" ]; then
  fail "VERSION_TAG_MISMATCH" "package.json.version='$pkg_version' but --expected-tag='$expected_tag' (stripped='$tag_without_v')"
fi

# ── 3. CHANGELOG_MISSING ──────────────────────────────────────────
changelog="$repo/CHANGELOG.md"
if [ ! -f "$changelog" ]; then
  fail "CHANGELOG_MISSING" "CHANGELOG.md not found in $repo"
fi
# Entry header: `## [<version>]` allowing trailing date/suffix.
if ! grep -qE "^## \[${pkg_version//./\\.}\]" "$changelog"; then
  fail "CHANGELOG_MISSING" "CHANGELOG.md has no '## [$pkg_version]' entry"
fi
# Reference link: `[<version>]: .../<expected-tag>` somewhere in the file.
if ! grep -qE "^\[${pkg_version//./\\.}\]:.*${expected_tag//./\\.}([[:space:]]|$)" "$changelog"; then
  fail "CHANGELOG_MISSING" "CHANGELOG.md has no '[$pkg_version]: ...$expected_tag' link line"
fi

# ── 4. HEAD_NOT_ORIGIN ────────────────────────────────────────────
if [ "$no_fetch" -ne 1 ]; then
  if ! git -C "$repo" fetch origin --quiet 2>/dev/null; then
    fail "HEAD_NOT_ORIGIN" "git fetch origin failed; pass --no-fetch to skip"
  fi
fi
if ! git -C "$repo" rev-parse origin/main >/dev/null 2>&1; then
  fail "HEAD_NOT_ORIGIN" "origin/main ref does not exist in $repo"
fi
head_sha=$(git -C "$repo" rev-parse HEAD)
origin_sha=$(git -C "$repo" rev-parse origin/main)
if [ "$head_sha" != "$origin_sha" ]; then
  fail "HEAD_NOT_ORIGIN" "HEAD ($head_sha) != origin/main ($origin_sha) in $repo"
fi

exit 0
