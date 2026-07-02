# shopify-edge-worker — multi-cartridge edge demo

One Cloudflare Worker. Two cartridges (Shopify product card + WordPress
blog post). Four audience surfaces for Shopify, three for WordPress. All
served from one render snapshot per request, no cache to bust.

## What ships

**Shopify product card** at `/shopify/`

- **Human HTML** — Schema.org Product JSON-LD inlined in `<head>`.
- **Schema.org JSON-LD** at `/shopify/schema.json` — same payload, standalone.
- **Google Merchant Center XML** at `/shopify/feed.xml` — RSS 2.0 + g: namespace; Google polls this URL daily for Shopping ads + free Shopping listings.
- **MCP tool manifest** at `/shopify/mcp` — `getProduct`, `getPrice`, `getAvailability`. Agent-readable.

**WordPress blog post** at `/wp/`

- **Human HTML** — Schema.org BlogPosting JSON-LD inlined.
- **Schema.org JSON-LD** at `/wp/schema.json`.
- **MCP tool manifest** at `/wp/mcp` — `getPost`, `getExcerpt`, `getPublishInfo`.

**Per-cartridge consistency**: a stable `snapshotId` (post-fetch SHA-256
hash, 16-hex) is visible across every surface that cartridge emits. Edit
the upstream source (Shopify admin or WordPress post) and the next request
to ANY surface sees the new data with a new matching snapshotId.

## Why this exists

Validates the airo-js cartridge contract at the edge with two different
data sources (Shopify Storefront GraphQL + WordPress REST), proving the
contract's portability claim. The two cartridges share the same render
path, the same snapshotId conventions, the same publication-adapter
flow — only the DataSource and schema differ.

Each PublicationAdapter declares its delivery mode:

- `delivery: 'inline-in-host'` — JSON-LD inlined directly into the HTML
  the worker renders. Used by both cartridges' JSON-LD adapters.
- `delivery: 'signed-feed-url'` — XML served at a stable URL Google polls
  on a schedule. Used by Shopify's Merchant Center adapter.

Design context:

- [`smithbn-studio-design-20260522-120754.md`](../../../../../../.gstack/projects/airo-js/smithbn-studio-design-20260522-120754.md) — the office-hours design doc that picked example-first.
- Airo-js-bridge thread `msg_mpgtzyld_19ef1e` — framework asks this
  example motivates: `DataSource.errorPolicy` (Ask 1),
  `RenderContext.snapshotId` (Ask 2), best-practices live-edge docs (Ask 3).
- Parallel spike in `dotter-monorepo` (Lambda@Edge / commerce cartridge) —
  co-signed all three asks.

## Setup

Prereq: a Cloudflare account, Wrangler, and a Shopify dev store with the
Storefront API enabled. WordPress requires no setup — REST API is public
on every WP site.

Fast path:

```bash
cd examples/shopify-edge-worker
./scripts/setup.sh    # or: pnpm bootstrap
```

It creates the KV namespace, patches `wrangler.toml`, prompts for your
Shopify domain + default product handle, and pushes
`SHOPIFY_STOREFRONT_TOKEN` as a Worker secret. Idempotent — safe to
re-run when you swap stores.

> Note: don't run `pnpm setup` — that's pnpm's own built-in for shell-PATH
> configuration and shadows our script. Use `pnpm bootstrap` or invoke
> `./scripts/setup.sh` directly. Same gotcha for `pnpm deploy` (use
> `pnpm ship` or `pnpm exec wrangler deploy`).

Manual flow if you prefer:

```bash
# 1. Install workspace deps from the airo-js repo root
pnpm install

# 2. Create the KV namespace
cd examples/shopify-edge-worker
pnpm exec wrangler kv namespace create CONFIG
# Copy the returned id into wrangler.toml under [[kv_namespaces]] id

# 3. Set the Shopify token as a Worker secret
pnpm exec wrangler secret put SHOPIFY_STOREFRONT_TOKEN
# Paste your Storefront API token at the prompt

# 4. For local dev, create .dev.vars (gitignored)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your token
```

## Run locally

```bash
pnpm dev      # wrangler dev — listens on http://localhost:8787
pnpm smoke    # fixture-based render test, no Shopify/WP fetch needed
pnpm ship     # deploy to your Cloudflare account
```

Local URLs (with default config):

| URL | What |
|---|---|
| `http://localhost:8787/` | landing index (links to both cartridges) |
| `http://localhost:8787/shopify/` | Shopify product card HTML |
| `http://localhost:8787/shopify/?product=<handle>` | per-request product override |
| `http://localhost:8787/shopify/schema.json` | Schema.org Product JSON-LD |
| `http://localhost:8787/shopify/feed.xml` | Google Merchant Center XML feed |
| `http://localhost:8787/shopify/mcp` | MCP tool manifest |
| `http://localhost:8787/shopify/mcp/tools/getPrice` | price tool (returns snapshotId) |
| `http://localhost:8787/wp/` | WordPress blog post HTML |
| `http://localhost:8787/wp/?post=<slug>` | per-request slug override |
| `http://localhost:8787/wp/?site=<host>` | per-request site override (any WP site) |
| `http://localhost:8787/wp/schema.json` | Schema.org BlogPosting JSON-LD |
| `http://localhost:8787/wp/mcp/tools/getExcerpt` | excerpt tool |

## The demo gesture

Open three windows for whichever cartridge you're showing off:

**Shopify version:**

1. Browser tab: `http://localhost:8787/shopify/?product=<handle>`
2. Terminal: `wrangler tail` (or split — `curl /shopify/mcp/tools/getPrice | jq`)
3. Shopify admin tab: product detail page

Change the price in admin, save. Refresh the browser tab + re-curl. New
price + new matching snapshotId across HTML, JSON-LD (view-source), the
Merchant Center XML feed (`curl /shopify/feed.xml`), and the MCP tool
response. Four audiences, one snapshot, no cache to bust.

**WordPress version:**

Same shape but edit a post in `wp-admin` instead of Shopify. Refresh the
demo URL + re-curl `/wp/mcp/tools/getExcerpt`. Title/excerpt update with
a new matching snapshotId.

## Architecture

```
Browser / curl  ─────►  Cloudflare Worker  ─────►  cartridge.dataSources[0].fetch
                              │                      │
                              │                      └──►  Live API (Shopify GraphQL / WP REST)
                              ▼
                       compute snapshotId
                              │
                              ▼
              renderAppWithPublication(cartridge, snapshot, ...)
                   ├──►  runPublicationAdapters(formats: ['json-ld'])
                   │       └──►  inline JSON-LD <script> before widget HTML
                   ├──►  view.factory().renderSSR(container, ctx)
                   │       └──►  product/blog card HTML
                   └──►  wrap with <!DOCTYPE> + <meta name="airo:snapshot-id">

/feed.xml         ─────►  runPublicationAdapters(formats: ['xml'])
                              └──►  Merchant Center XML (signed-feed-url)

/mcp/tools/<name> ─────►  cartridge.dataSources[0].fetch
                              ├──►  same snapshot, fresh fetch
                              └──►  tool.handler(input, { data, config, schema })
                                       └──►  { result, snapshotId }
```

Each request fetches the upstream data on demand. No persistent cache,
no webhook, no rebuild. Cartridge contract guarantees the same snapshot
reaches the view + the adapters + the MCP tools when invoked from the
same render. `snapshotId` makes that consistency verifiable across
out-of-band routes (`/mcp`, `/schema.json`, `/feed.xml`) too — for v0
the hash is computed in the cartridge's `DataSource.fetch`; future
framework support (Ask 2 on the bridge) will move it to
`RenderContext.snapshotId`.

## Code map

```
src/
├── shopify/                         # commerce cartridge
│   ├── adapters.ts                  # JSON-LD adapter + Merchant Center XML adapter
│   ├── cartridge.ts                 # envelope, DataSource, ViewDefinition
│   ├── client.ts                    # Shopify Storefront GraphQL client
│   ├── jsonld.ts                    # Schema.org Product mapper
│   ├── mcp.ts                       # getProduct, getPrice, getAvailability
│   ├── merchant-center.ts           # Google Shopping XML serializer
│   └── types.ts                     # ProductSnapshot, ShopifyConfig, ProductJsonLd
├── wp/                              # content cartridge
│   ├── adapters.ts                  # BlogPosting JSON-LD adapter
│   ├── cartridge.ts                 # envelope, DataSource, ViewDefinition
│   ├── client.ts                    # WordPress REST client (with ?_embed)
│   ├── jsonld.ts                    # Schema.org BlogPosting mapper
│   ├── mcp.ts                       # getPost, getExcerpt, getPublishInfo
│   └── types.ts                     # PostSnapshot, WpConfig, PostJsonLd
├── demo-config.ts                   # per-cartridge AppConfig + fallback config
├── snapshot-id.ts                   # shared SHA-256 hash helper (v0 Ask 2 placeholder)
├── styles.ts                        # inline stylesheet for both cards + landing
└── worker.ts                        # Worker entry, routes for both cartridges
```

## Framework asks this example motivates

See airo-js-bridge thread `msg_mpgtzyld_19ef1e` for full context + co-signs
from the dotter-monorepo team.

1. **`DataSource.errorPolicy`** — currently each cartridge's `fetch()`
   uses inline `try/catch`. Framework should formalize
   `'fail-render' | 'serve-fallback' | 'serve-stale'`.
2. **`RenderContext.snapshotId`** — currently computed per-cartridge in
   `snapshot-id.ts` and stuffed onto the snapshot type. Framework
   should compute post-pipeline-pre-PostProcessor and expose via
   `ctx.snapshotId`.
3. **Live-edge best-practices doc** — write up the `errorPolicy` decision
   tree, snapshotId convention, and `ctx.signal` abort-propagation patterns.

The Merchant Center adapter motivates a fourth, smaller ask:

4. **`signed-feed-url` delivery hosting helper** — every cartridge with
   an XML adapter needs a host-app route that serves the latest output.
   Pattern is identical across cartridges; a `@airo-js/ssr` helper
   `serveSignedFeed(adapter, snapshot, ctx)` could wrap the
   `runPublicationAdapters({ formats: ['xml'] })` → validation-gate →
   Response shape so each consumer doesn't re-derive it.

## Future work

- **Wizard studio** — separate Pages app that writes cartridge config to
  the same KV namespace. Deferred until demo lands per the design doc.
- **Embed bundle integration** — wrap `<airo-app airo-ssr="hydrate">`
  around the SSR output + load `@airo-js/embed` for client interactivity.
- **HTMLRewriter optimization** — for routes that don't need
  `doc.createElement`, Workers' HTMLRewriter is faster than linkedom.
  Already true in v0: `/shopify/schema.json`, `/shopify/feed.xml`, and
  `/*/mcp/*` routes skip linkedom entirely.
- **GTIN / category mapping for Merchant Center** — current XML output
  marks `identifier_exists: no` if Shopify hasn't returned a GTIN/MPN.
  Real production feeds should map Shopify metafields → GTIN + Google
  Product Category.
- **WordPress.com hosted sites** — current client hits
  `<host>/wp-json/...`. WordPress.com sites use a different REST endpoint
  (`public-api.wordpress.com/wp/v2/sites/...`). Detect-and-dispatch in
  `client.ts` would broaden site support.
- **Third cartridge** — proves the framework against a non-commerce,
  non-content backend. Candidates: weather/finance/transit live data,
  WooCommerce, third-party CMS (Sanity, Contentful), or a SaaS data
  source (Airtable, Notion).
