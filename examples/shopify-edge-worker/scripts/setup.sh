#!/usr/bin/env bash
# Setup script for examples/shopify-edge-worker on Cloudflare Workers.
#
# Walks through the four pieces of state that aren't in git:
#   1. Cloudflare KV namespace 'CONFIG' (created + id patched into wrangler.toml)
#   2. SHOPIFY_DOMAIN var (overrideable in wrangler.toml)
#   3. DEFAULT_PRODUCT_HANDLE var (overrideable in wrangler.toml)
#   4. SHOPIFY_STOREFRONT_TOKEN secret (pushed via `wrangler secret put`)
#
# Idempotent — re-running detects each piece of state and skips it.
# Safe — never edits git history, never pushes secrets without confirmation,
# leaves backups of wrangler.toml on every patch.
#
# Usage:
#   ./scripts/setup.sh
#
# Required tools: wrangler (workspace devDep, accessed via pnpm exec).
# Optional tools: bun (for the smoke step).

set -euo pipefail

# --- output helpers ---------------------------------------------------------
RED='\033[31m'; GREEN='\033[32m'; YELLOW='\033[33m'; BLUE='\033[34m'
BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

step() { echo; echo -e "${BLUE}${BOLD}==>${RESET} ${BOLD}$*${RESET}"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }
dim()  { echo -e "${DIM}$*${RESET}"; }

# Read with prompt; portable across bash + zsh.
ask() {
  local __var=$1 __prompt=$2 __reply
  printf "${BOLD}?${RESET} %s " "$__prompt"
  read -r __reply
  printf -v "$__var" '%s' "$__reply"
}

# --- locate the example dir -------------------------------------------------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
EXAMPLE_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
WRANGLER_TOML="$EXAMPLE_DIR/wrangler.toml"

cd "$EXAMPLE_DIR"

# --- locate wrangler --------------------------------------------------------
# Prefer the workspace-pinned wrangler (matches the version we built against).
if command -v wrangler >/dev/null 2>&1; then
  WRANGLER=(wrangler)
elif command -v pnpm >/dev/null 2>&1; then
  WRANGLER=(pnpm exec wrangler)
elif command -v npx >/dev/null 2>&1; then
  WRANGLER=(npx wrangler)
else
  err "No wrangler found. Install with: pnpm install"
  exit 1
fi

# --- prereq check -----------------------------------------------------------
step "Prereq check"

if [[ ! -f "$WRANGLER_TOML" ]]; then
  err "wrangler.toml not found at $WRANGLER_TOML"
  exit 1
fi
ok "wrangler.toml present"

# TTY guard. pnpm's run-script wrapper sometimes strips stdin's TTY, which
# triggers wrangler v3 to refuse OAuth credentials and demand a
# CLOUDFLARE_API_TOKEN env var. If we're not on a TTY and there's no API
# token, bail early with a useful message instead of letting wrangler fail
# halfway through.
if [[ ! -t 0 ]] && [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  err "No TTY detected on stdin AND no CLOUDFLARE_API_TOKEN env var set."
  err ""
  err "This usually means you ran 'pnpm bootstrap' instead of invoking the"
  err "script directly. wrangler v3 refuses cached OAuth credentials in"
  err "non-interactive contexts."
  err ""
  err "Two fixes:"
  err "  1. Run the script directly (preserves TTY):"
  err "       ./scripts/setup.sh"
  err ""
  err "  2. Get a Cloudflare API token and export it (works under pnpm too):"
  err "       https://dash.cloudflare.com/profile/api-tokens"
  err "       export CLOUDFLARE_API_TOKEN=<your-token>"
  err "       pnpm bootstrap"
  exit 1
fi

# Cloudflare login — wrangler is permissive about prompting, but check early
# so the user knows what's coming.
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then
  warn "Not logged in to Cloudflare."
  ask CONFIRM_LOGIN "Run 'wrangler login' now? [Y/n]"
  if [[ -z "$CONFIRM_LOGIN" || "$CONFIRM_LOGIN" =~ ^[Yy] ]]; then
    "${WRANGLER[@]}" login
  else
    err "Cloudflare login required to continue."
    exit 1
  fi
fi
ACCOUNT=$("${WRANGLER[@]}" whoami 2>&1 | grep -E 'account' -i | head -1 || true)
ok "Logged in to Cloudflare"
[[ -n "$ACCOUNT" ]] && dim "  $ACCOUNT"

# --- step 1: KV namespace ---------------------------------------------------
step "KV namespace 'CONFIG'"

# Look for the line `id = "..."` inside the [[kv_namespaces]] block.
CURRENT_KV_ID=$(awk '
  /^\[\[kv_namespaces\]\]/ { in_kv=1; next }
  /^\[/ { in_kv=0 }
  in_kv && /^id = / { gsub(/^id = "|"$/, ""); print; exit }
' "$WRANGLER_TOML")

if [[ "$CURRENT_KV_ID" == "REPLACE_WITH_KV_NAMESPACE_ID" || -z "$CURRENT_KV_ID" ]]; then
  echo "Creating KV namespace 'CONFIG'..."
  # Capture wrangler's output so we can parse the new id.
  KV_OUTPUT=$("${WRANGLER[@]}" kv namespace create CONFIG 2>&1 || true)
  echo "$KV_OUTPUT" | awk '{print "  "$0}'

  # Parse the id from wrangler's output. v3 + v4 both print:
  #   id = "abcd1234..."
  # (sometimes wrapped in a code block). Grab the first hex-ish run inside id = "...".
  KV_ID=$(echo "$KV_OUTPUT" | grep -E '^[[:space:]]*id = "' | head -1 \
    | sed -E 's/.*id = "([a-f0-9]+)".*/\1/')

  if [[ -z "$KV_ID" || "$KV_ID" == "$KV_OUTPUT" ]]; then
    err "Could not parse KV namespace id from wrangler output above."
    err "Copy the id from the output and run manually:"
    err "  sed -i '' 's|REPLACE_WITH_KV_NAMESPACE_ID|YOUR_ID|' wrangler.toml"
    exit 1
  fi

  # Patch wrangler.toml in place. The -i.bak form works on macOS + GNU sed.
  sed -i.bak "s|id = \"REPLACE_WITH_KV_NAMESPACE_ID\"|id = \"$KV_ID\"|" "$WRANGLER_TOML"
  rm -f "$WRANGLER_TOML.bak"
  ok "KV namespace created: $KV_ID"
  ok "Patched wrangler.toml"
else
  ok "KV namespace already configured: $CURRENT_KV_ID"
  dim "  (re-run with the wrangler.toml id reset to 'REPLACE_WITH_KV_NAMESPACE_ID' to recreate)"
fi

# --- step 2: SHOPIFY_DOMAIN -------------------------------------------------
step "SHOPIFY_DOMAIN var"

CURRENT_DOMAIN=$(awk '/^SHOPIFY_DOMAIN = / { gsub(/^SHOPIFY_DOMAIN = "|"$/, ""); print; exit }' "$WRANGLER_TOML")
echo "Current: $CURRENT_DOMAIN"

if [[ "$CURRENT_DOMAIN" == "demo-store.myshopify.com" ]]; then
  warn "That's the placeholder default — the demo will 404 against it."
fi

ask NEW_DOMAIN "Press Enter to keep, or paste your storefront domain (e.g. mystore.myshopify.com)"
if [[ -n "$NEW_DOMAIN" ]]; then
  sed -i.bak "s|^SHOPIFY_DOMAIN = .*|SHOPIFY_DOMAIN = \"$NEW_DOMAIN\"|" "$WRANGLER_TOML"
  rm -f "$WRANGLER_TOML.bak"
  ok "Updated SHOPIFY_DOMAIN = $NEW_DOMAIN"
else
  dim "  Kept: $CURRENT_DOMAIN"
fi

# --- step 3: DEFAULT_PRODUCT_HANDLE -----------------------------------------
step "DEFAULT_PRODUCT_HANDLE var"

CURRENT_HANDLE=$(awk '/^DEFAULT_PRODUCT_HANDLE = / { gsub(/^DEFAULT_PRODUCT_HANDLE = "|"$/, ""); print; exit }' "$WRANGLER_TOML")
echo "Current: $CURRENT_HANDLE"
dim "  (you can also override per-request with ?product=<handle> in the URL)"

ask NEW_HANDLE "Press Enter to keep, or paste a real product handle from your store"
if [[ -n "$NEW_HANDLE" ]]; then
  sed -i.bak "s|^DEFAULT_PRODUCT_HANDLE = .*|DEFAULT_PRODUCT_HANDLE = \"$NEW_HANDLE\"|" "$WRANGLER_TOML"
  rm -f "$WRANGLER_TOML.bak"
  ok "Updated DEFAULT_PRODUCT_HANDLE = $NEW_HANDLE"
else
  dim "  Kept: $CURRENT_HANDLE"
fi

# --- step 4: secret ---------------------------------------------------------
step "SHOPIFY_STOREFRONT_TOKEN secret"

cat <<'EOF'
The Shopify Storefront API token is the only piece of state that can't go in
git. Two ways to get one:

  Production deploy:
    Shopify Admin → Apps → Develop apps → Create app → API credentials
    → Storefront API access tokens → Install + reveal the token.

  Local dev only (.dev.vars):
    Same token; just paste into .dev.vars (gitignored).

EOF

ask CONFIRM_SECRET "Push SHOPIFY_STOREFRONT_TOKEN as a deployed Worker secret now? [y/N]"
if [[ "$CONFIRM_SECRET" =~ ^[Yy] ]]; then
  echo "wrangler will prompt for the token next. Paste it at the prompt:"
  "${WRANGLER[@]}" secret put SHOPIFY_STOREFRONT_TOKEN
  ok "Secret pushed"
else
  warn "Skipped. The deployed Worker will return 500 until you run:"
  warn "  ${WRANGLER[*]} secret put SHOPIFY_STOREFRONT_TOKEN"
fi

# --- step 5: .dev.vars for local dev ----------------------------------------
step ".dev.vars (local dev only)"

if [[ -f "$EXAMPLE_DIR/.dev.vars" ]]; then
  ok ".dev.vars already present (gitignored)"
else
  ask CREATE_DEVVARS "Create .dev.vars from .dev.vars.example so 'wrangler dev' works locally? [Y/n]"
  if [[ -z "$CREATE_DEVVARS" || "$CREATE_DEVVARS" =~ ^[Yy] ]]; then
    cp "$EXAMPLE_DIR/.dev.vars.example" "$EXAMPLE_DIR/.dev.vars"
    ok "Created .dev.vars — edit it and replace the placeholder with your token."
    warn "  .dev.vars is gitignored; safe to put a real token there."
  else
    dim "  Skipped. Create later by copying .dev.vars.example."
  fi
fi

# --- step 6: optional smoke + dev launch ------------------------------------
step "Verify"

cat <<EOF
Optional next checks (in order of how much they confirm):

  ${BOLD}pnpm typecheck${RESET}   — confirm the source still compiles
  ${BOLD}pnpm smoke${RESET}       — fixture-based render test (no Shopify call; needs bun)
  ${BOLD}pnpm dev${RESET}         — local 'wrangler dev' against .dev.vars
  ${BOLD}pnpm deploy${RESET}      — push to your Cloudflare account

The 'wrangler dev' URL is http://localhost:8787; the deploy URL is the
*.workers.dev subdomain wrangler prints when 'pnpm deploy' completes.

EOF

ask START_DEV "Start 'wrangler dev' now? [y/N]"
if [[ "$START_DEV" =~ ^[Yy] ]]; then
  if [[ ! -f "$EXAMPLE_DIR/.dev.vars" ]]; then
    warn "Cannot start dev without .dev.vars (Shopify token required)."
    warn "Create .dev.vars then re-run."
    exit 0
  fi
  exec "${WRANGLER[@]}" dev
fi

# --- done -------------------------------------------------------------------
step "Setup complete"

cat <<EOF
${GREEN}All pieces of state configured.${RESET}

Demo gesture once deployed:
  1. Open the deployed URL in a browser tab
  2. Open ${BOLD}view-source${RESET} in a second tab — note the inline JSON-LD + airo:snapshot-id meta
  3. Open a terminal: ${BOLD}curl -s <url>/mcp/tools/getPrice | jq${RESET}
  4. In Shopify admin: change the product price
  5. Refresh browser tab + re-run curl
     → Both surfaces show the new price
     → snapshotId moved forward in lockstep across all three audiences

Three audiences, one snapshot, no cache to bust.

Bridge thread: msg_mpgtzyld_19ef1e on airo-js-bridge
Plan / measurements: scripts/smoke.mjs + Phase 1 close response on the bridge
EOF
