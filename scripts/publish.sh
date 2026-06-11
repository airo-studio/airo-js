#!/usr/bin/env bash
# Publish the @airo-js/* framework packages to npm.
#
# Packages (in dependency order):
#   @airo-js/log           — leaf, no airo deps; publishes first
#   @airo-js/core          — depends on log
#   @airo-js/cartridge-kit — depends on core (published with 'rc' dist-tag)
#   @airo-js/runtime       — depends on core + cartridge-kit
#   @airo-js/embed         — depends on log + cartridge-kit + runtime (peer)
#   @airo-js/ssr           — depends on core + cartridge-kit + log
#
# Tags:
#   - log, core, runtime, embed, ssr  → 'latest' (default)
#   - cartridge-kit                   → 'rc' (it's a 0.2.0-rc.x release;
#                                             tagging it 'latest' would
#                                             surface a pre-release to
#                                             consumers who don't opt in)
#
# Skip-if-already-published: each iteration reads the local version from
# package.json and queries `npm view <pkg>@<version>`. If the version is
# already on the registry, the package is skipped. This lets the script
# run end-to-end after a partial release without `set -e` aborting on a
# duplicate-version error from pnpm.
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
# Currently passes --no-git-checks to allow publishing without the dirty-tree
# / out-of-sync guard rails. Drop the flag from PUBLISH_FLAGS once the repo
# is fully pushed and you want those guards re-enabled.
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

# Order: log → core → cartridge-kit → runtime → embed → ssr.
#   - log is a leaf framework dep (no airo deps); publish first so the
#     others resolve workspace:* against a published version on apply.
#   - core depends on log.
#   - cartridge-kit depends on core.
#   - runtime depends on core + cartridge-kit.
#   - embed depends on log + cartridge-kit (type-only) + runtime (peer; not bundled).
#   - ssr depends on core + cartridge-kit + log.
# Each entry: "<filter> [extra-flags]"
PACKAGES=(
  "@airo-js/log"
  "@airo-js/core"
  "@airo-js/cartridge-kit"
  "@airo-js/runtime"
  "@airo-js/embed"
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

# Resolve the local version of a workspace package by reading its package.json.
# Uses `pnpm --filter --silent exec node -p` so this works without bash 4
# (no associative arrays needed). Whitespace stripped to handle trailing
# newlines from `node -p`.
local_version() {
  pnpm --filter "$1" --silent exec node -p 'require("./package.json").version' 2>/dev/null \
    | tr -d '[:space:]'
}

# Returns 0 if `<pkg>@<version>` exists on the registry, 1 otherwise.
# Network errors propagate as exit 1 (skip-on-failure would silently swallow
# real problems); the caller can re-run after a transient blip.
registry_has() {
  npm view "$1@$2" version >/dev/null 2>&1
}

for entry in "${PACKAGES[@]}"; do
  set -- $entry
  pkg="$1"
  shift || true
  extra="$*"

  version="$(local_version "$pkg")"
  if [[ -z "$version" ]]; then
    echo
    echo "==> $pkg"
    echo "    error: couldn't read local version from package.json" >&2
    exit 1
  fi

  echo
  echo "==> $pkg@$version ${extra:+($extra)}"

  # Skip if already on the registry — lets the script run end-to-end after
  # a partial release (e.g. one new package alongside several already-published
  # ones) without `set -e` aborting on the duplicate-version error.
  if registry_has "$pkg" "$version"; then
    echo "    already on registry; skipping."
    continue
  fi

  # shellcheck disable=SC2086
  pnpm --filter "$pkg" publish $PUBLISH_FLAGS $extra
  echo "    published."
done

echo
echo "Done. Verify on npmjs.com:"
echo "  https://www.npmjs.com/package/@airo-js/log"
echo "  https://www.npmjs.com/package/@airo-js/core"
echo "  https://www.npmjs.com/package/@airo-js/cartridge-kit"
echo "  https://www.npmjs.com/package/@airo-js/runtime"
echo "  https://www.npmjs.com/package/@airo-js/embed"
echo "  https://www.npmjs.com/package/@airo-js/ssr"
echo
echo "All packages publish to the 'latest' dist-tag (cartridge-kit is GA on the 0.8 line)."
