# airo-js

**A cartridge framework for editable micro frontends that render for humans, search engines, and AI agents from one trusted snapshot.**

`airo-js` is a TypeScript framework for building UI cartridges: self-contained micro frontends with an explicit contract for data, configuration, pages, renderers, editor metadata, publication outputs, and agent-facing tools.

Use it when a widget cannot just be a bundle of JavaScript. An Airo cartridge can be mounted client-side, rendered on the server or edge, edited by a CMS-style studio, split into per-page chunks, and published with Schema.org JSON-LD, feeds, `llms.txt`, or MCP tools that all read the same post-transformer data.

## Why Airo

Most micro frontend systems solve "how do I mount code on a page?" Airo adds the missing product layer around that code:

- **Ultra-light by design.** The embed shell is budgeted at 5 KB minified / 2.5 KB gzip and only lazy-loads runtime code when an `<airo-app>` is actually present.
- **Horizontal or vertical composition.** Put many cartridges on one page, or let one cartridge own an entire multi-page journey.
- **Studio-editable by contract.** Cartridges declare templates, component schema, theme schema, style surfaces, data sources, gates, and hot-swap boundaries so a no-code studio can render safe configuration forms instead of reverse-engineering a bundle.
- **One snapshot, many audiences.** The rendered UI, JSON-LD, XML feeds, `llms.txt`, and MCP tools consume the same post-transformer snapshot. What the user sees is what crawlers index and what agents answer from.
- **Edge-ready rendering.** `@airo-js/ssr` is runtime-agnostic. Pass a `Document` from `linkedom`, `deno-dom`, or your runtime and render on Cloudflare Workers, Lambda@Edge, Deno, Node, or your own host.
- **Bundle discipline built in.** Browser cartridges can omit server-only adapters and MCP tools, while per-page view chunks self-register through cartridge mailboxes.
- **Headless framework, branded cartridges.** Airo owns rendering lifecycle, routing, isolation, orchestration, and contract metadata. Cartridges and host studios own UI, auth, drafts, tenancy, persistence, analytics, and business rules.

The shortest version: Airo lets a cartridge behave like a real product surface, not just a script tag.

## Core Concepts

```
DataSource
  -> Transformer pipeline
  -> post-transformer snapshot
      -> ViewDefinition render / hydrate
      -> PublicationAdapter outputs
      -> McpToolDefinition handlers
```

- **Cartridge**: the package boundary. It declares data, config, templates, views, adapters, tools, gates, and editor metadata.
- **Template**: the page graph a host app instantiates. This supports both single-page widgets and full user journeys.
- **ViewDefinition**: maps a `page.type` to a renderer factory. Renderers may support CSR, SSR, hydrate, subpages, and live style updates.
- **PublicationAdapter**: turns the same snapshot into JSON-LD, XML, TSV, `llms.txt`, MCP manifests, or other publishable outputs.
- **Studio metadata**: `componentSchema`, `themeSchema`, `defineStyleSurface`, and token helpers describe what a CMS-style editor can safely expose.
- **Runtime**: `mountCartridge` performs shell setup, optional fetch, pipeline, gates, mount, hydrate, and live updates.
- **Embed**: `defineAiroApp` registers the custom element customers paste into a page.

## Install

Requirements:

- Node.js `>=20`
- pnpm `>=9`

For client-side cartridge mounting:

```bash
pnpm add @airo-js/core @airo-js/cartridge-kit @airo-js/runtime @airo-js/log
```

For SSR or edge rendering:

```bash
pnpm add @airo-js/core @airo-js/cartridge-kit @airo-js/ssr @airo-js/log linkedom
```

For a customer-facing embed script:

```bash
pnpm add @airo-js/embed @airo-js/runtime @airo-js/core @airo-js/cartridge-kit @airo-js/log
```

For this monorepo:

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Current workspace packages are on the `0.8.x` line. The framework is pre-1.0, so read [`CHANGELOG.md`](./CHANGELOG.md) when upgrading.

## Micro Size Budget

Airo is built for embedded surfaces where every kilobyte matters. The default path keeps the customer-facing loader tiny, then loads only the runtime and page renderer code needed for the mounted cartridge.

Measured in this workspace with `esbuild --bundle --minify --platform=browser` and gzip:

| Bundle | Minified | Gzip | What it includes |
|---|---:|---:|---|
| `@airo-js/embed` package budget | 5,030 B | 2,211 B | Custom element loader, lifecycle, SSR-hydrate handoff, missing-view recovery. Runtime is lazy-loaded. |
| README hello cartridge only | 2,438 B | 1,293 B | The hello cartridge contract, data source, template, and SSR-safe view. |
| README hello CSR app | 24,583 B | 8,235 B | `mountCartridge`, core runtime pieces, and the hello cartridge in one browser bundle. |
| README hello custom embed entry | 6,958 B | 3,098 B | `defineAiroApp` plus the tiny hello cartridge, with `@airo-js/runtime` still external/lazy. |

Those numbers are a starting budget, not a ceiling for every real cartridge. Real product views often get heavier because of maps, carousels, personalization, animation, analytics hooks, or commerce UI. The framework's answer is not "ship one giant widget bundle"; it is "start simple, then split page renderers when they become the weight."

## Packages

| Package | Role |
|---|---|
| [`@airo-js/core`](./packages/core/README.md) | Rendering engine: `createApp`, `PageManager`, routing, events, style isolation, theme injection, registry mailboxes, and pipeline primitives. |
| [`@airo-js/cartridge-kit`](./packages/cartridge-kit/README.md) | Cartridge contract: `Cartridge`, `DataSource`, `ViewDefinition`, `Template`, `Gate`, `PublicationAdapter`, MCP tools, editor schema, and SSR-safe renderer helpers. |
| [`@airo-js/runtime`](./packages/runtime/README.md) | Browser mount orchestration: shell setup, fetch or preloaded data, transformer pipeline, gates, mount, hydrate, and live update dispatch. |
| [`@airo-js/ssr`](./packages/ssr/README.md) | Runtime-agnostic SSR and publication helpers: `renderAppToHTML`, `runPublicationAdapters`, and `renderAppWithPublication`. |
| [`@airo-js/embed`](./packages/embed/README.md) | Tiny custom-element bootstrap for customer pages. Loads config, resolves cartridges, lazy-loads runtime, hydrates SSR HTML when present, and recovers missing view chunks. |
| [`@airo-js/mcp`](./packages/mcp/src/index.ts) | MCP tool emission helpers for agent-facing cartridge capabilities. |
| [`@airo-js/log`](./packages/log/README.md) | Structured sink-based logging across framework packages. |

## Hello World Cartridge

Create one cartridge, then run it three ways: CSR, SSR/hydrate, and edge render with JSON-LD.

```ts
// hello-cartridge.ts
import {
  defineSSRSafeRenderer,
  type Cartridge,
  type CartridgeAppContext,
  type DataSource,
  type PublicationAdapter,
  type SchemaDefinition,
  type Template,
  type ValidationResult,
  type ViewDefinition,
} from '@airo-js/cartridge-kit';

type HelloData = {
  title: string;
  body: string;
  url: string;
};

type HelloConfig = {
  locale: string;
  ctaLabel: string;
};

type HelloPageType = 'home';
type HelloContext = CartridgeAppContext<HelloData, HelloConfig>;

const ok: ValidationResult = { valid: true, errors: [], warnings: [] };

function parseHelloData(input: unknown): HelloData {
  const value = input as Partial<HelloData>;
  if (
    typeof value.title !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.url !== 'string'
  ) {
    throw new Error('Expected { title, body, url }');
  }
  return { title: value.title, body: value.body, url: value.url };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escapes[char] ?? char;
  });
}

const schema: SchemaDefinition<HelloData> = {
  parse: parseHelloData,
  safeParse(input) {
    try {
      return { success: true, data: parseHelloData(input) };
    } catch (error) {
      return { success: false, error: error as Error };
    }
  },
  toJsonSchema: () => ({
    type: 'object',
    required: ['title', 'body', 'url'],
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      url: { type: 'string', format: 'uri' },
    },
  }),
};

const inlineDataSource: DataSource<HelloData, HelloConfig> = {
  id: 'inline',
  displayName: 'Inline content',
  onboardingShape: {
    kind: 'custom',
    descriptor: 'Pass { title, body, url } in dataSourceInput.payload',
  },
  async fetch(input) {
    if (input.kind === 'custom') return schema.parse(input.payload);
    return {
      title: 'Hello from Airo',
      body: 'A tiny cartridge rendered from one snapshot.',
      url: 'https://example.com/hello',
    };
  },
  cacheTtlMs: 60_000,
};

const helloView: ViewDefinition<HelloData, HelloConfig> = {
  id: 'hello-card',
  displayName: 'Hello card',
  pageType: 'home',
  capabilities: ['responsive', 'ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<HelloPageType, HelloContext>({
    template(ctx) {
      const { data, config } = ctx.app;
      return `
        <article style="max-width:42rem;padding:24px;border:1px solid #d9dee7;border-radius:8px;font:16px/1.5 system-ui,sans-serif;color:#172033;background:#fff">
          <p style="margin:0 0 8px;color:#1f6f4e;font-size:12px;font-weight:700;text-transform:uppercase">Airo cartridge</p>
          <h1 style="margin:0 0 10px;font-size:32px;line-height:1.1">${escapeHtml(data.title)}</h1>
          <p style="margin:0">${escapeHtml(data.body)}</p>
          <a data-hello-cta href="${escapeHtml(data.url)}" style="display:inline-flex;margin-top:12px;color:#0b5cad;font-weight:700">
            ${escapeHtml(config.ctaLabel)}
          </a>
        </article>
      `;
    },
    hydrate(root, ctx) {
      const cta = root.querySelector<HTMLAnchorElement>('[data-hello-cta]');
      const onClick = () => {
        root.dispatchEvent(
          new CustomEvent('airo:hello-click', {
            bubbles: true,
            detail: { cartridgeId: ctx.app.cartridgeId, url: ctx.app.data.url },
          }),
        );
      };
      cta?.addEventListener('click', onClick);
      return () => cta?.removeEventListener('click', onClick);
    },
  }),
};

const template: Template<HelloConfig, HelloPageType> = {
  id: 'hello',
  displayName: 'Hello',
  description: 'One-page hello world cartridge.',
  pages: [{ id: 'home', type: 'home', enabled: true }],
  defaultConfig: {
    locale: 'en-US',
    ctaLabel: 'Read more',
  },
};

const jsonLdAdapter: PublicationAdapter<HelloData, Record<string, unknown>, HelloConfig> = {
  id: 'hello-json-ld',
  displayName: 'Article JSON-LD',
  description: 'Inline Schema.org Article JSON-LD for the hello cartridge.',
  format: 'json-ld',
  requires: [
    { path: 'title', required: 'always' },
    { path: 'body', required: 'always' },
    { path: 'url', required: 'always' },
  ],
  async generate(snapshot, ctx) {
    return {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: snapshot.title,
      description: snapshot.body,
      url: snapshot.url,
      inLanguage: ctx.locale,
    };
  },
  validate(output) {
    const value = output as Record<string, unknown>;
    if (typeof value.headline === 'string' && typeof value.url === 'string') {
      return ok;
    }
    return {
      valid: false,
      errors: [{ code: 'invalid-json-ld', message: 'Missing headline or url.' }],
      warnings: [],
    };
  },
  refreshCadence: { min: { ms: 0 }, max: { ms: 6 * 60 * 60 * 1000 } },
  delivery: 'inline-in-host',
  onValidationFail: 'block-publish',
};

export const helloCartridge: Cartridge<HelloData, HelloConfig> = {
  id: 'hello',
  industry: 'Documentation',
  displayName: 'Hello Cartridge',
  description: 'A minimal cartridge with CSR, SSR, hydration, and JSON-LD output.',
  version: '0.1.0',
  schema,
  dataSources: [inlineDataSource],
  views: [helloView],
  templates: [template],
  publicationAdapters: [jsonLdAdapter],
  defaultConfig: template.defaultConfig,
  defaultTemplateId: template.id,
  mailboxName: '__AIRO_HELLO_PAGES__',
};
```

## Hello World CSR

Mount the cartridge directly in a browser app.

```html
<div id="hello-widget"></div>
<script type="module" src="/src/main.ts"></script>
```

```ts
// src/main.ts
import { mountCartridge } from '@airo-js/runtime';
import { helloCartridge } from './hello-cartridge';

const template = helloCartridge.templates.find(
  (item) => item.id === helloCartridge.defaultTemplateId,
)!;

await mountCartridge({
  cartridge: helloCartridge,
  config: helloCartridge.defaultConfig,
  template,
  host: document.querySelector<HTMLElement>('#hello-widget')!,
  styleIsolation: 'shadow',
  enableRouter: { mode: 'hash' },
  dataSourceInput: {
    kind: 'custom',
    payload: {
      title: 'Hello CSR',
      body: 'This cartridge mounted client-side through @airo-js/runtime.',
      url: 'https://example.com/csr',
    },
  },
});
```

`mountCartridge` sets up the render shell, runs the data source, runs transformers, evaluates gates, creates the cartridge app context, and mounts the active page renderer.

## Hello World SSR + Hydrate

Render HTML and JSON-LD on the server, then hydrate the same cartridge in the browser.

```ts
// server/render-hello.ts
import { templateToAppConfig } from '@airo-js/cartridge-kit';
import { filterServerSafeCartridge, renderAppWithPublication } from '@airo-js/ssr';
import { parseHTML } from 'linkedom';
import { helloCartridge } from '../src/hello-cartridge';

const config = helloCartridge.defaultConfig;
const snapshot = await helloCartridge.dataSources[0]!.fetch(
  {
    kind: 'custom',
    payload: {
      title: 'Hello SSR',
      body: 'The first response includes HTML plus application/ld+json.',
      url: 'https://example.com/ssr',
    },
  },
  { config },
);

const cartridge = filterServerSafeCartridge(helloCartridge);
const template = cartridge.templates.find((item) => item.id === cartridge.defaultTemplateId)!;
const appConfig = templateToAppConfig(template, 'hello-widget');
const { document } = parseHTML('<!doctype html><html><body></body></html>');

const result = await renderAppWithPublication({
  cartridge,
  appConfig,
  snapshot,
  publicationCtx: {
    config,
    locale: config.locale,
    country: 'US',
  },
  document,
});

export const html = `<!doctype html>
<html lang="en">
  <body>
    <div id="hello-widget">${result.html}</div>
    <script type="module" src="/src/hydrate.ts"></script>
  </body>
</html>`;
```

```ts
// src/hydrate.ts
import { mountCartridge } from '@airo-js/runtime';
import { helloCartridge } from './hello-cartridge';

const config = helloCartridge.defaultConfig;
const template = helloCartridge.templates.find(
  (item) => item.id === helloCartridge.defaultTemplateId,
)!;

const snapshot = await fetch('/api/hello-snapshot').then((res) => res.json());

await mountCartridge({
  cartridge: helloCartridge,
  config,
  template,
  host: document.querySelector<HTMLElement>('#hello-widget')!,
  mode: 'hydrate',
  styleIsolation: 'shadow',
  preloadedData: helloCartridge.schema.parse(snapshot),
});
```

The framework never serializes hidden app state into SSR output. Hydration recomputes from the same cartridge config and a trusted snapshot source, then the renderer's `hydrate()` attaches listeners without repainting.

## Hello World EdgeRender

EdgeRender is the Airo pattern of doing SSR plus publication output at the CDN edge. This Cloudflare Worker shape returns human HTML and inline JSON-LD from the same cartridge snapshot.

```ts
// worker.ts
import { templateToAppConfig } from '@airo-js/cartridge-kit';
import { filterServerSafeCartridge, renderAppWithPublication } from '@airo-js/ssr';
import { parseHTML } from 'linkedom';
import { helloCartridge } from './hello-cartridge';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const config = helloCartridge.defaultConfig;

    const snapshot = await helloCartridge.dataSources[0]!.fetch(
      {
        kind: 'custom',
        payload: {
          title: url.searchParams.get('title') ?? 'Hello from the edge',
          body: 'Rendered on the edge with JSON-LD generated from the same snapshot.',
          url: url.href,
        },
      },
      { config },
    );

    const cartridge = filterServerSafeCartridge(helloCartridge);
    const template = cartridge.templates.find((item) => item.id === cartridge.defaultTemplateId)!;
    const appConfig = templateToAppConfig(template, 'hello-edge');
    const { document } = parseHTML('<!doctype html><html><body></body></html>');

    const result = await renderAppWithPublication({
      cartridge,
      appConfig,
      snapshot,
      publicationCtx: {
        config,
        locale: config.locale,
        country: 'US',
      },
      document,
    });

    return new Response(`<!doctype html>
<html lang="en">
  <head>
    <title>${escapeHtml(snapshot.title)}</title>
    <meta name="description" content="${escapeHtml(snapshot.body)}">
  </head>
  <body>
    <main id="hello-edge">${result.html}</main>
  </body>
</html>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const escapes: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return escapes[char] ?? char;
  });
}
```

For a production edge cartridge, add a client embed or hydrate bundle when the UI needs interaction after first paint. For pure content cards, SSR output plus JSON-LD may be enough.

## Customer Embed

When customers should paste one tag into any site, wrap the runtime with `@airo-js/embed`:

```ts
import { defineAiroApp } from '@airo-js/embed';
import { helloCartridge } from './hello-cartridge';

defineAiroApp({
  loadConfig: async (id, token) => {
    const res = await fetch(`/widgets/${id}/load`, {
      headers: token ? { 'X-Embed-Token': token } : undefined,
    });
    if (!res.ok) throw new Error(`load failed: ${res.status}`);
    return await res.json();
  },
  resolveCartridge: async (id) => {
    if (id === 'hello') return helloCartridge;
    throw new Error(`Unknown cartridge: ${id}`);
  },
});
```

```html
<script type="module" src="https://cdn.example.com/airo-embed.js"></script>
<airo-app airo-id="wgt_123"></airo-app>
```

The embed package handles custom-element lifecycle, lazy runtime import, SSR hydrate handoff, and missing page-chunk recovery. Your host app owns load endpoints, auth, error UI, and telemetry.

## Splitting Large Views

The first version of a cartridge can ship all views in one browser bundle. When that bundle starts getting too large, split by page type instead of by layout family. A single mounted widget then pays for the one page it needs first, not every page the cartridge can ever show.

The browser cartridge can declare `views: []`, and each page chunk self-registers when loaded:

```ts
// product.chunk.ts
import { pushToMailbox } from '@airo-js/core';
import { ProductRenderer } from './ProductRenderer';

pushToMailbox('__AIRO_PRODUCT_PAGES__', {
  key: 'product',
  factory: () => new ProductRenderer(),
});
```

Then the embed host resolves missing renderers on demand:

```ts
import { defineAiroApp } from '@airo-js/embed';

defineAiroApp({
  loadConfig,
  resolveCartridge,
  resolveView: (cartridgeId, pageType) =>
    import(`https://cdn.example.com/cartridges/${cartridgeId}/${pageType}.js`),
});
```

When the active renderer is missing, Airo emits the miss, `@airo-js/embed` calls `resolveView`, waits for the chunk to register into the cartridge mailbox, then recovers the current render. On SSR pages it re-runs hydrate without wiping the server HTML; on CSR pages it navigates and paints fresh.

The server/full cartridge can still keep a static `views[]` list for SSR and capability gating. The split is a browser delivery choice, not a different product model.

## When To Use Airo

Airo is a good fit when:

- You need a reusable micro frontend that can be configured by non-developers.
- You need multiple pages or subpages inside one embedded surface.
- You need SSR, hydration, JSON-LD, feeds, `llms.txt`, or MCP tools to stay consistent with what the UI renders.
- You are building a studio or marketplace where cartridges are authored by one team and configured by another.
- You care about search and AI discoverability, but do not want every cartridge to hand-maintain structured data in parallel.

Airo is probably not the right fit when:

- You only need a single hard-coded component in one app.
- You want the framework to own auth, drafts, tenancy, storage, scheduling, or CMS data modeling.
- You do not need a cartridge contract, studio metadata, SSR, publication outputs, or multi-surface consistency.

## Examples

| Example | What it proves |
|---|---|
| [`examples/publication-adapter-skeleton`](./examples/publication-adapter-skeleton/src/index.ts) | Two publication adapters sharing one product snapshot. |
| [`examples/shopify-edge-worker`](./examples/shopify-edge-worker/README.md) | A Cloudflare Worker serving Shopify and WordPress cartridges as HTML, JSON-LD, feeds, and MCP tools from live data. |
| [`examples/llms-txt-adapter`](./examples/llms-txt-adapter/README.md) | `llms.txt` as a generated `PublicationAdapter`, not a hand-maintained file. |

## Best Practices

Start with [`docs/best-practices.md`](./docs/best-practices.md). The high-signal rules:

- Keep `TConfig` to editable cartridge surface. Do not put widget identity, tenancy, auth state, or `app.type` in cartridge config.
- Use `DataSource.fetch` for wire-shape pivots. Keep transformers shape-preserving.
- Split server-only MCP tools and publication adapters out of browser bundles with the two-envelope pattern.
- Declare renderer capabilities honestly. `csr-only` still allows JSON-LD to publish as an SEO partial win.
- Use `templateToAppConfig` for SSR and let `mountCartridge` use the same translation on the client.
- Treat cache TTLs, gate persistence, and publication cadence as metadata. Host apps implement behavior.

## Scope

Airo owns:

- Rendering lifecycle
- Page routing
- Style isolation mechanism
- Event bus
- Cartridge registry and view resolution
- Data pipeline orchestration
- Gates before render
- SSR and hydrate dispatch
- Publication adapter execution
- MCP tool emission helpers
- Editor-facing metadata contracts

Host apps own:

- Auth, tenancy, permissions, drafts, locks, history, persistence, scheduling, and compliance
- Load endpoints, credentials, rate limits, retry policies, and caches
- Studio UI, forms, themes, preview chrome, analytics, and error presentation
- Business-specific content strategy for SEO and AI optimization

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
