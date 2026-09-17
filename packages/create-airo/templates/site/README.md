# __DISPLAY_NAME__

An [airo-js](https://github.com/airo-studio/airo-js) site: pages rendered on the
server that the browser takes over without redrawing, plus search-engine and
AI-agent surfaces built from the same data.

> **Scaffolded with `create-airo@__CREATE_AIRO_VERSION__`, a beta.** This project
> uses `@airo-js` __TARGET_LINE__. The framework's API freezes at 1.0; when it
> ships, the [changelog](https://github.com/airo-studio/airo-js/blob/main/CHANGELOG.md)
> will carry migration notes for projects created with this beta. Your
> `package.json` records which build created it under `"airo"`. Nothing
> upgrades on its own: the `^` ranges here stay on __TARGET_LINE__.

## Run it

```bash
npm install
npm run dev          # build, then serve on http://localhost:3000
```

| Command | |
|---|---|
| `npm run dev` | Build and serve |
| `npm run build` | Compile the server and bundle `src/client.ts` into `dist/public/client.js` |
| `npm start` | Serve the last build |
| `npm test` | Check the server and browser render identical markup |
| `npm run typecheck` | Type-check source and tests |
| `npm run smoke` | HTTP checks against a running server (start it first) |

`PORT` changes the port.

## What is where

| File | What it is |
|---|---|
| `src/content.ts` | Your content. Replace it with your CMS, markdown or database |
| `src/cartridge.ts` | How the site renders: data shape, data source, views, page graph, CSS. This is the browser half |
| `src/cartridge.server.ts` | Search-engine metadata, JSON-LD, `llms.txt`, and the tools agents can call. Server only |
| `src/server.ts` | Express. Every route, and how status codes are decided |
| `src/client.ts` | The browser entry |

## The urls

| Url | |
|---|---|
| `/` | The index |
| `/post/<slug>` | A post |
| `/post/unfinished` | 404, deliberately: a post without an `updatedAt` is kept off search engines and out of the index. Delete it from `content.ts` once you have seen it |
| `/sitemap.xml`, `/robots.txt` | For search engines |
| `/llms.txt` | For AI assistants |
| `/mcp/tools`, `POST /mcp/call` | Tools an AI agent can call |

Try an agent call:

```bash
curl -s localhost:3000/mcp/call -H 'content-type: application/json' \
  -d '{"name":"get_section","arguments":{"id":"where-to-start"},"slug":"hello"}'
```

The answer is the same section `/post/hello` renders. That is the idea the
whole project is built on: every audience reads one snapshot, so they cannot
disagree.

## Before you deploy

- Set `SITE.url` in `src/content.ts` to your real origin. Canonical urls, the
  sitemap and agent answers are all built from it.
- `server.ts` builds snapshots per request. With a slow data source, cache
  `/sitemap.xml` and `/llms.txt` rather than rebuilding them on every hit.

## Things this starter already decides for you

Each is easy to get wrong and fails without an error. The comments at each
spot say why.

- The data source calls `schema.parse()`. The framework never does.
- Views and template pages share one `PageType` union, so a typo is a compile
  error rather than a blank page.
- Status codes come from the renderer's reasons (`fellBack.reason`, then
  `skipped.reason`), in that order.
- The adapter that puts metadata in the page is built with
  `defineCrawlerSurfaceAdapter`. A hand-written one with `format: 'custom'`
  would never run on page renders.
- Only fields an adapter truly cannot do without are `required: 'always'`.
  Over-declaring one silently stops that adapter publishing.
- Adapters and agent tools live in `cartridge.server.ts`, so browsers never
  download them.
- A failed agent call is logged on the server, and its underlying error is
  never sent back to the caller.

## Going further

- **Members-only pages:** add `private: true` to a page in `siteTemplate`. The
  server answers 401 until you verify a session; `server.ts` marks the spot.
  `examples/full-site` in the airo-js repo shows the whole sign-in flow.
- **More pages:** add a type to `PageType`, a view to `siteCartridge.views`
  and a page to `siteTemplate.pages`.
- **Authoring guide:** [best practices](https://github.com/airo-studio/airo-js/blob/main/docs/best-practices.md).

## Tooling versions

The dev dependencies (`typescript`, `vitest`, `esbuild`, `happy-dom`) are
pinned to the versions this starter is tested with. Upgrading them is
fine; run `npm test` and `npm run smoke` afterwards.
