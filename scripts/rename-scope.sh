#!/usr/bin/env bash
# Rename the npm scope across the workspace: @ai-ro → @airo-js.
#
# Usage:
#   ./scripts/rename-scope.sh             # dry-run: print files that would change, exit
#   ./scripts/rename-scope.sh --apply     # do the substitution in place
#
# What it touches: every text file containing '@ai-ro', excluding node_modules,
# pnpm-lock.yaml, *.tsbuildinfo, dist/, .git/, and this script itself.
#
# Safe to re-run: idempotent. After --apply, a re-run finds zero matches.
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

OLD='@ai-ro'
NEW='@airo-js'

# Resolve repo root (parent of the scripts/ dir this file lives in).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SELF_REL="scripts/$(basename "${BASH_SOURCE[0]}")"

cd "$REPO_ROOT"

mode="${1:-}"

# Helper: list files containing OLD. Uses find + grep (portable, no ripgrep
# dependency). Prunes excluded dirs at the find level so we don't descend.
list_files() {
  find . \
    \( -path './node_modules' -o -path './.git' -o -name 'dist' -type d \) -prune \
    -o -type f \
    ! -name 'pnpm-lock.yaml' \
    ! -name '*.tsbuildinfo' \
    ! -path "./$SELF_REL" \
    -print0 2>/dev/null \
  | xargs -0 grep -l -F "$OLD" 2>/dev/null || true
}

# Collect into a newline-delimited string, then count.
files_str="$(list_files)"

if [[ -z "$files_str" ]]; then
  echo "No occurrences of '$OLD' found. Nothing to do."
  exit 0
fi

count=$(printf '%s\n' "$files_str" | wc -l | tr -d ' ')

echo "Files containing '$OLD' ($count):"
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  occ=$(grep -c -F "$OLD" "$f" 2>/dev/null || echo 0)
  printf '  %s  (%s occurrence(s))\n' "$f" "$occ"
done <<< "$files_str"

if [[ "$mode" != "--apply" ]]; then
  echo
  echo "Dry run. Re-run with --apply to substitute '$OLD' → '$NEW' in place."
  exit 0
fi

echo
echo "Applying substitution..."

# macOS BSD sed needs '' after -i; GNU sed does not. Detect:
if sed --version >/dev/null 2>&1; then
  sed_inplace_args=(-i)            # GNU sed
else
  sed_inplace_args=(-i '')         # BSD sed (macOS default)
fi

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  sed "${sed_inplace_args[@]}" "s|$OLD|$NEW|g" "$f"
done <<< "$files_str"

# Verify zero remaining matches in the same scoped scan.
remaining_str="$(list_files)"
if [[ -n "$remaining_str" ]]; then
  echo "warning: '$OLD' still appears in some files after substitution:" >&2
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    grep -n -F "$OLD" "$f" | sed "s|^|$f:|" >&2 || true
  done <<< "$remaining_str"
  exit 1
fi

echo "Done. $count file(s) updated. Zero occurrences of '$OLD' remain."
echo
echo "Next steps:"
echo "  pnpm install        # regenerate lockfile (workspace:* deps re-resolve under new names)"
echo "  pnpm -r build       # rebuild dist with new scope baked in"
echo "  pnpm -r typecheck   # confirm cross-package types still resolve"
