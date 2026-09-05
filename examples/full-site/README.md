# `full-site` — a whole website from one cartridge

A multi-page site root-mounted on Express. Real urls, per-URL SSR, per-page canonicals, a host-assembled sitemap, `llms.txt`, and MCP tools — **every surface off one snapshot**.

```bash
pnpm dev              # build + serve on :3000
PORT=4317 pnpm dev
pnpm smoke            # 27 assertions against a running server
```

| URL | |
|---|---|
| `/` | index — `200` |
| `/doc/why-snapshots` | a document — `200` |
| `/doc/unfinished-draft` | **`404`** — blocked by the publish gate |
| `/does-not-exist` | **`404`** — `fellBack.reason === 'unknown-page'` |
| `/microdata/:slug` | Schema.org microdata — same facts, different encoding |
| `/sitemap.xml` `/llms.txt` `/robots.txt` `/mcp/tools` | machine surfaces |

## The server is not the point

`@airo-js/ssr` is pure functions over a `Document`. **There is no HTTP server in the framework, no file-based routing, no bundler, no dev server** — that is deliberate, not missing.

`src/server.ts` is ~180 lines of Express and none of it is framework-specific. Swap it for Hono, Fastify, a Cloudflare Worker or bare `node:http` and *nothing else changes*: the cartridge, the client entry and every surface are identical. The sibling [`shopify-edge-worker`](../shopify-edge-worker) example is the same framework calls behind a Worker `fetch` handler.

So the honest framing is **"your server + airo-js"**, and the server is genuinely any server.

## What it demonstrates

**One cartridge owns the whole site.** Two routable pages (`home`, `doc`), with the slug in the second path segment via `pathContextKey: 'slug'`. `enableRouter: { mode: 'path', basePath: '/', entryPageId: 'home' }` root-mounts it — and `entryPageId` is what gives the index **one** url instead of answering on both `/` and `/home`.

**The snapshot is per request.** The DataSource takes the requested slug and returns a snapshot scoped to *that* page. This is the load-bearing decision: it makes canonicals per-page, and it makes `validate()` a per-page gate rather than a per-feed one. Get it wrong and one unfinished entry blocks the entire site.

**The publish gate is real, and visible.** `content.ts` ships a doc with an empty `updatedAt`. The crawler adapter's `select.canonical` returns `''` for it, `validate()` blocks on a missing canonical, and the url 404s, stays out of the sitemap, and stays out of `llms.txt` — while every other page publishes normally. No custom validator: *"an unfinished page must not reach a crawler"* and *"a page that cannot say where it canonically lives must not reach a crawler"* turn out to be one rule.

**Four publication adapters, one snapshot.** Inline JSON-LD, the crawler bundle (canonical / OpenGraph / Twitter Card / sitemap entry), `llms.txt`, and Schema.org microdata. The last two are different *encodings* of the same facts for different readers — not different data — and the smoke suite asserts that the microdata headline, the `og:title` and the rendered `<h1>` are the same string.

**Every surface agrees.** The `<title>` a reader sees, the `og:title` a crawler indexes and the summary an agent cites are the same string because they read the same post-transformer snapshot. Drift is not discouraged, it is unavailable.

## Four things that are easy to get wrong

Each is commented at its site in `src/server.ts`.

1. **Static assets route BEFORE the wildcard.** `basePath: '/'` normalises to `''` and `''.startsWith('')` is true for *every* path, so the app claims the whole origin. The `validPages` allowlist is the only thing stopping `/favicon.ico` decoding as a page.

2. **Decode with `fragmentToState`, not `decodeNavHint`.** `decodeNavHint`'s allowlist fails closed, and a `null` hint is indistinguishable from "nothing requested" — so the runner never learns a page was asked for, `fellBack` never fires, and `/does-not-exist` answers `200`. Two gates in series, the outer silencing the inner. Here the runner is the gate: it validates the entry page and re-derives `navState.page` from the page it resolved, so a rejected id cannot reach a renderer. See best-practices §5.10a.

3. **Branch on `fellBack.reason`, never on its presence.** Only `'unknown-page'` is a missing url. `'disabled'` is a config state and `'gate-page'` is a real page — both legitimate `200`s.

4. **Register the root route explicitly.** Express 5's `/*splat` matches one-or-more segments and does **not** match `/`, so a wildcard-only route leaves the bare root falling through to Express's own 404 — on the one url a root-mounted site most needs to serve. Found by curling `/`, not by any test.

## Where the framework stops

The framework emits **one `SitemapEntry` per page** and will never assemble `sitemap.xml`. That is not a gap: having the full entry list requires a site-wide inventory, and an inventory means enumeration plus persistence — state the framework is not allowed to own. The host has the route list, so the host assembles it, in about 15 lines.

Same shape for the publication decision itself: adapters validate their *own* output independently, so a host serving several surfaces has to coordinate them. Both `/llms.txt` and `/microdata/:slug` check the crawler adapter's verdict before publishing, because advertising a url to an AI assistant that a crawler is forbidden to index — and that answers 404 — is exactly the drift this framework exists to prevent.

That trap is easy to walk into and it caught this example during development: the microdata route shipped a page the crawler adapter had blocked, because a non-empty fragment is all its own `validate()` checks. The smoke suite asserts it now. **Per-adapter validation is a verdict, not a policy** — the policy is yours.

## Provenance

This cartridge is the rescue of an earlier single-page `doc-page` cartridge that existed only as **untracked build output with its source deleted**. Its shape is preserved — schema, data source, transformer, MCP tools, renderer, publication adapters — extended to several pages, tracked, running, and using the 0.9.0 primitives (`defineCrawlerSurfaceAdapter`, `renderDocument`, `headFromPublication`, `escapeHtml`) instead of hand-rolling them.
