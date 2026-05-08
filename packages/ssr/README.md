# `@airo-js/ssr`

Runtime-agnostic edge SSR for the airo framework. Pure functions — no DOM globals required (pass a document from `linkedom` or `deno-dom` server-side).

> Status: **v0.x**. Surface still subject to refinement; consumers should target `^0.1` until `1.0` ships.

## What's in here

Three helpers, layered:

### `renderAppToHTML(config, deps)`

Pure App → HTML. No cartridge awareness, no `EventBus` subscriptions, no router wired, no listeners attached. The result is safe to inline in the host page's initial HTML response.

State is **never** serialised into the output — the client-side `createApp({ hydrate: true })` recomputes everything from `(config, appContext)` on hydrate. Removes the entire class of tampering bugs that come from trusting a state blob round-tripped through the host page.

Use when you want widget markup and nothing else.

### `runPublicationAdapters(cartridge, snapshot, ctx, opts?)`

Execute a cartridge's `PublicationAdapter`s and return per-adapter results. Use for non-HTML outputs (XML feeds, MCP-tool manifests) or when running adapters on a schedule independent of widget render. Includes validation results — when `onValidationFail: 'block-publish'` (the default) is in effect, failed outputs are returned with `included: false` so callers know not to serve them downstream.

Filterable by `id`, `format`, and `delivery`.

### `renderAppWithPublication(opts)`

Combines the above. Renders the entry page AND inlines the cartridge's `inline-in-host` JSON-LD outputs as `<script type="application/ld+json">` tags before the widget markup. The SEO landing path.

JSON-LD payloads are escaped against `</script>` breakout — safe to inline strings from snapshot fields without manual sanitisation.

## Install

```bash
pnpm add @airo-js/ssr
```

Peer-installs `@airo-js/core` and `@airo-js/cartridge-kit`.

## SSR environment

Server-side environments without a global `document` MUST pass one explicitly:

```ts
import { renderAppToHTML } from '@airo-js/ssr';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
const { html } = renderAppToHTML(appConfig, { document, resolveRenderer, appContext });
```

Browser-side, the global `document` is used by default and the `document` option can be omitted.

## License

Apache 2.0.
