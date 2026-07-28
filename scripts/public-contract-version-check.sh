#!/usr/bin/env bash
# Verify that a declared breaking public-contract set has a distinguishable
# package identity before it can enter the GA release flow.

set -euo pipefail

repo="$PWD"
manifest="docs/release-identity.json"

usage() {
  echo "Usage: public-contract-version-check.sh [--repo <path>] [--manifest <repo-relative-path>]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || { usage; exit 2; }
      repo="$2"; shift 2 ;;
    --manifest)
      [ $# -ge 2 ] || { usage; exit 2; }
      manifest="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "USAGE: unknown flag: $1" >&2
      usage
      exit 2 ;;
  esac
done

fail() {
  echo "$1: $2" >&2
  exit 1
}

package_path="$repo/package.json"
manifest_path="$repo/$manifest"
[ -d "$repo/.git" ] || fail "USAGE" "not a git repository: $repo"
[ -f "$package_path" ] || fail "USAGE" "package.json not found: $package_path"
[ -f "$manifest_path" ] || fail "RELEASE_IDENTITY_MANIFEST_MISSING" "$manifest_path"

read_json() {
  node -e '
    const fs = require("fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current === undefined || current === null) process.exit(3);
    console.log(Array.isArray(current) ? current.length : current);
  ' "$1" "$2"
}

current_version=$(read_json "$package_path" version) ||
  fail "RELEASE_IDENTITY_INVALID" "package.json.version is missing"
schema=$(read_json "$manifest_path" schema) ||
  fail "RELEASE_IDENTITY_INVALID" "manifest schema is missing"
baseline_tag=$(read_json "$manifest_path" baseline_tag) ||
  fail "RELEASE_IDENTITY_INVALID" "manifest baseline_tag is missing"
target_version=$(read_json "$manifest_path" target_version) ||
  fail "RELEASE_IDENTITY_INVALID" "manifest target_version is missing"
breaking_count=$(read_json "$manifest_path" breaking_changes) ||
  fail "RELEASE_IDENTITY_INVALID" "manifest breaking_changes is missing"

[ "$schema" = "1" ] || fail "RELEASE_IDENTITY_INVALID" "unsupported manifest schema: $schema"
[ "$breaking_count" -gt 0 ] ||
  fail "RELEASE_IDENTITY_INVALID" "breaking_changes must be non-empty"
git -C "$repo" rev-parse "$baseline_tag^{commit}" >/dev/null 2>&1 ||
  fail "RELEASE_BASELINE_MISSING" "tag is not reachable: $baseline_tag"

baseline_package=$(git -C "$repo" show "$baseline_tag:package.json") ||
  fail "RELEASE_BASELINE_MISSING" "package.json is absent at $baseline_tag"
baseline_version=$(printf '%s' "$baseline_package" | node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (typeof value.version !== "string") process.exit(3);
  console.log(value.version);
') || fail "RELEASE_IDENTITY_INVALID" "baseline package version is missing"

[ "$current_version" = "$target_version" ] ||
  fail "PUBLIC_CONTRACT_TARGET_MISMATCH" \
    "package version '$current_version' does not match manifest target '$target_version'"
[ "$current_version" != "$baseline_version" ] ||
  fail "PUBLIC_CONTRACT_VERSION_UNCHANGED" \
    "breaking contracts cannot retain baseline version '$baseline_version'"

node -e '
  const [base, target] = process.argv.slice(1).map((value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) process.exit(2);
    return match.slice(1).map(Number);
  });
  const valid = base[0] === 0
    ? target[0] === 0 && target[1] > base[1]
    : target[0] > base[0];
  if (!valid) process.exit(1);
' "$baseline_version" "$target_version" ||
  fail "PUBLIC_CONTRACT_VERSION_NOT_BREAKING" \
    "target '$target_version' is not a breaking SemVer successor to '$baseline_version'"

exit 0
