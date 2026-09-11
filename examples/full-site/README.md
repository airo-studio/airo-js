# `full-site` — a whole website from one cartridge

A multi-page site root-mounted on Express. Real urls, per-URL SSR, per-page canonicals, a host-assembled sitemap, `llms.txt`, and MCP tools — **every surface off one snapshot** — plus a members area behind a sign-in gate, where none of that applies on purpose.

```bash
pnpm dev              # build + serve on :3000
PORT=4317 pnpm dev
pnpm smoke            # 99 assertions against a running server, including the OAuth round trip
pnpm test             # happy-dom: the gate with fetch mocked
pnpm e2e              # Playwright, Chromium: the gate paints, hydration adopts the server's DOM
```

| URL | |
|---|---|
| `/` | index — `200` |
| `/doc/why-snapshots` | a document — `200` |
| `/doc/unfinished-draft` | **`404`** — blocked by the publish gate |
| `/does-not-exist` | **`404`** — `fellBack.reason === 'unknown-page'` |
| `/members` | **`401`** shell + sign-in gate; **`200`** server-rendered for a session (`demo` / `demo`) |
| `/note/roadmap` | a member note — private, same rule |
| `/microdata/:slug` | Schema.org microdata — same facts, different encoding |
| `/sitemap.xml` `/llms.txt` `/robots.txt` `/mcp/tools` | machine surfaces — never see a member byte |
| `/auth/*` `/oauth/*` `/api/members/me` | host code: the relying party, the demo identity provider, the members API |

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

## The members area: private pages, the login gate, and where OAuth lives

The framework's thesis is many surfaces off one snapshot. A members area is the opposite: one signed-in human, never indexed, never cached, never in `llms.txt` or the MCP manifest. Two sentences the framework signs make both live in one cartridge:

1. **A Gate decides whether to paint; whether to serve is the host's, per request.** The gate is UX. The API and the SSR handler are the security boundary.
2. **Bots are never gated.** SSR never runs gates. Private pages are the one exception, and they are *refused*, not gated.

So the whole of "this page is for one signed-in visitor" is one field: `private: true` on the `members` and `note` pages of the template. Everything else follows from it.

**What the framework does.** `renderAppWithPublication` refuses a private entry with `skipped.reason === 'private'` — no adapters run, no JSON-LD, no canonical — unless the host passes `renderPrivate: true`, and then renders it adapter-free and reports `gates.satisfied: ['login']`. On the client, `loginGate` is `appliesTo: 'private'`: it runs only on mounts whose entry page is private, **before** the data fetch, asks `GET /auth/session`, and paints one `signInPanel` on a 401. `mountCartridge({ satisfiedGates })` skips it once on a page the server already rendered privately.

**What the host does (all of `src/auth/`, none of it framework).** A demo OAuth 2.0 identity provider — authorization code + PKCE S256, one registered client with an exact-match `redirect_uri`, one-shot 60 s codes, account `demo` / `demo` — and a relying party: `/auth/login` stashes state + verifier in a short-lived cookie and redirects; `/auth/callback` checks state, exchanges the code, sets an `HttpOnly; SameSite=Lax` session cookie (`Secure` behind a TLS terminator) and redirects to a same-origin `next`; `POST /auth/logout`; `GET /auth/session`. Every check in the provider carries a comment naming the attack it closes. Point `AUTH_ISSUER` at GitHub, Google or Auth0, register the same client, and the relying party does not change.

**The request, in order.** The wildcard calls the runner **without** `renderPrivate`. Public pages come back rendered. On a private refusal — and only then — it reads the cookie: no session → a **401 shell** (`<div id="app" data-airo-mode="csr" data-airo-source="members">`, `noindex` twice, `no-store`) that the client mounts in CSR mode, where the gate runs before any fetch and paints the panel; a session → the member slice is built, the runner is called again with `renderPrivate: true`, and the page ships server-rendered with `data-airo-gates-satisfied="login"`, `Cache-Control: private, no-store`, `Vary: Cookie`, `X-Robots-Tag: noindex`. Refuse first, then ask who is asking: the host never re-derives which page the URL names.

**The redirect round trip.** The gate's `mount()` never settles — its link leaves the page. Re-entry is `precheck` on the next mount, where the session now exists. The return URL is the nav state: the panel links to `/auth/login?next=<pathname+search>`, and the callback redirects back to `next` (same-origin paths only; `https://evil.example` becomes `/`). A deep link to `/note/roadmap` survives the whole trip.

**What never happens.** No private byte rides a script block: every private mount, hydrate or shell, refetches through the `members` DataSource with the cookie, and `/api/members/me` answers 401 without one. The machine routes build their snapshots without a session, so they cannot carry a member. A signed-in visitor's public pages are byte-identical to an anonymous visitor's, which is what makes `Cache-Control: public` honest. The smoke asserts every one of these.

## Six things that are easy to get wrong

Each is commented at its site in `src/server.ts`.

1. **Static assets route BEFORE the wildcard.** `basePath: '/'` normalises to `''` and `''.startsWith('')` is true for *every* path, so the app claims the whole origin. The `validPages` allowlist is the only thing stopping `/favicon.ico` decoding as a page.

2. **Decode with `fragmentToState`, not `decodeNavHint`.** `decodeNavHint`'s allowlist fails closed, and a `null` hint is indistinguishable from "nothing requested" — so the runner never learns a page was asked for, `fellBack` never fires, and `/does-not-exist` answers `200`. Two gates in series, the outer silencing the inner. Here the runner is the gate: it validates the entry page and re-derives `navState.page` from the page it resolved, so a rejected id cannot reach a renderer. See best-practices §5.10a.

3. **Branch on `fellBack.reason`, never on its presence.** Only `'unknown-page'` is a missing url. `'disabled'` is a config state and `'gate-page'` is a real page — both legitimate `200`s.

4. **Register the root route explicitly.** Express 5's `/*splat` matches one-or-more segments and does **not** match `/`, so a wildcard-only route leaves the bare root falling through to Express's own 404 — on the one url a root-mounted site most needs to serve. Found by curling `/`, not by any test.

5. **Member data is keyed on the page, never on the session.** Adapters and MCP tools are page-blind; they publish whatever the snapshot holds. The member slice is built only inside the `skipped.reason === 'private'` branch, so a signed-in visitor's public pages are byte-identical to an anonymous visitor's and the machine routes, which never read a cookie, cannot leak a note. Read `skipped` before `fellBack`: a private refusal has no canonical, and a "no canonical → 404" rule written for public pages would turn every private page into a 404.

6. **A server-rendered private page still refetches on hydrate, by design.** No private byte rides a script block; the cost is one same-origin call the session already earned. What the server hands the client is its *verdict* (`data-airo-gates-satisfied`), so the hydrate never asks `/auth/session` — and if the session expired in between, the API says 401 and the client paints the sign-in panel.

## Where the framework stops

The framework emits **one `SitemapEntry` per page** and will never assemble `sitemap.xml`. That is not a gap: having the full entry list requires a site-wide inventory, and an inventory means enumeration plus persistence — state the framework is not allowed to own. The host has the route list, so the host assembles it, in about 15 lines.

Same shape for the publication decision itself: adapters validate their *own* output independently, so a host serving several surfaces has to coordinate them. Both `/llms.txt` and `/microdata/:slug` check the crawler adapter's verdict before publishing, because advertising a url to an AI assistant that a crawler is forbidden to index — and that answers 404 — is exactly the drift this framework exists to prevent.

That trap is easy to walk into and it caught this example during development: the microdata route shipped a page the crawler adapter had blocked, because a non-empty fragment is all its own `validate()` checks. The smoke suite asserts it now. **Per-adapter validation is a verdict, not a policy** — the policy is yours.

## Provenance

This cartridge is the rescue of an earlier single-page `doc-page` cartridge that existed only as **untracked build output with its source deleted**. Its shape is preserved — schema, data source, transformer, MCP tools, renderer, publication adapters — extended to several pages, tracked, running, and using the 0.9.0 primitives (`defineCrawlerSurfaceAdapter`, `renderDocument`, `headFromPublication`, `escapeHtml`) instead of hand-rolling them.
