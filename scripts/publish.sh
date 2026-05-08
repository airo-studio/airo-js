#!/usr/bin/env bash
# Publish @airo-js/core, @airo-js/cartridge-kit, @airo-js/ssr to npm.
#
# Order matters: core first (cartridge-kit and ssr depend on it), then
# cartridge-kit (ssr depends on it), then ssr.
#
# Tags:
#   - core, ssr           → 'latest' (default)
#   - cartridge-kit       → 'rc'     (it's a 0.2.0-rc.4 release; tagging it
#                                     'latest' would surface it to consumers
#                                     who don't opt into pre-releases)
#
# Usage:
#   ./scripts/publish.sh                # DRY-RUN: build + npm pack --dry-run per package
#   ./scripts/publish.sh --apply        # publish for real (prompts for confirmation)
#   ./scripts/publish.sh --apply --yes  # publish for real, skip confirmation
#
# pnpm publish runs `prepublishOnly` (which strips dist/.tsbuildinfo) and uses
# the workspace protocol to rewrite `workspace:*` deps to concrete versions
# in the published tarball. npm publish does NOT do this — always use pnpm.
#
# Currently passes --no-git-checks to allow publishing before the first push
# to GitHub. Once the repo is pushed and the upstream tracks main, REMOVE
# the flag from PUBLISH_FLAGS below to re-enable the dirty-tree / out-of-sync
# guard rails.
#
# Compatible with bash 3.2+ (macOS default).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

# ---- args ------------------------------------------------------------------

apply=0
yes=0
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    --yes)   yes=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "error: unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ---- config ----------------------------------------------------------------

# Order: core → cartridge-kit → ssr. Each entry: "<filter> [extra-flags]"
PACKAGES=(
  "@airo-js/core"
  "@airo-js/cartridge-kit --tag rc"
  "@airo-js/ssr"
)

# Flags applied to every `pnpm publish`. Drop --no-git-checks once the repo
# has been pushed to GitHub and main tracks origin/main.
PUBLISH_FLAGS="--no-git-checks"

# ---- preflight -------------------------------------------------------------

echo "==> Preflight"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required" >&2
  exit 1
fi

if [[ "$apply" == "1" ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    echo "error: not logged in to npm. Run 'npm login' first." >&2
    exit 1
  fi
  who="$(npm whoami)"
  echo "    npm user: $who"
fi

# ---- build -----------------------------------------------------------------

echo
echo "==> Building all packages (typecheck + tsc)"
# Filter to packages only — apps/* are workspace members for local dev (workspace:*
# linking) but are not published and must not gate the publish flow.
pnpm -r --filter './packages/*' typecheck >/dev/null
pnpm -r --filter './packages/*' build >/dev/null
echo "    OK"

# ---- dry-run preview -------------------------------------------------------

if [[ "$apply" != "1" ]]; then
  echo
  echo "==> Dry-run: previewing each package"
  echo "    (note: dist/.tsbuildinfo will appear here; prepublishOnly strips"
  echo "     it on actual publish, so the real tarball is ~17 kB smaller)"
  for entry in "${PACKAGES[@]}"; do
    set -- $entry
    pkg="$1"
    shift || true
    extra="$*"
    echo
    echo "--- $pkg ${extra:+(extra: $extra)} ---"
    pnpm --filter "$pkg" exec npm pack --dry-run 2>&1 \
      | grep -E 'npm notice (name|version|filename|package size|unpacked size|total files):' \
      | sed 's/^npm notice //' \
      || true
  done
  echo
  echo "Dry run complete. Re-run with --apply to publish for real."
  exit 0
fi

# ---- confirm ---------------------------------------------------------------

echo
echo "==> Ready to publish (in this order):"
for entry in "${PACKAGES[@]}"; do
  echo "    $entry"
done
echo
echo "    flags: $PUBLISH_FLAGS"

if [[ "$yes" != "1" ]]; then
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

# ---- publish ---------------------------------------------------------------

for entry in "${PACKAGES[@]}"; do
  set -- $entry
  pkg="$1"
  shift || true
  extra="$*"
  echo
  echo "==> Publishing $pkg ${extra:+($extra)}"
  # shellcheck disable=SC2086
  pnpm --filter "$pkg" publish $PUBLISH_FLAGS $extra
  echo "    published."
done

echo
echo "Done. Verify on npmjs.com:"
echo "  https://www.npmjs.com/package/@airo-js/core"
echo "  https://www.npmjs.com/package/@airo-js/cartridge-kit"
echo "  https://www.npmjs.com/package/@airo-js/ssr"
echo
echo "cartridge-kit is on the 'rc' dist-tag. Consumers opt in with:"
echo "  pnpm add @airo-js/cartridge-kit@rc"
