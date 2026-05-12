/**
 * @airo-js/ssr — runtime-agnostic edge SSR dispatch.
 *
 * Three helpers:
 *
 *   - `renderAppToHTML(config, deps)` — pure App → HTML. No cartridge
 *     awareness. Use when you want the widget markup and nothing else.
 *
 *   - `runPublicationAdapters(cartridge, snapshot, ctx, opts?)` — execute
 *     a cartridge's PublicationAdapters and return per-adapter results.
 *     Use for non-HTML outputs (XML feeds, MCP-tool manifests) or when
 *     running adapters on a schedule independent of widget render.
 *
 *   - `renderAppWithPublication(opts)` — combines the above. Renders the
 *     entry page AND inlines the cartridge's `inline-in-host` JSON-LD
 *     outputs as `<script type="application/ld+json">` tags. The SEO
 *     value-prop landing path.
 *
 * Schema-specific feed adapters (mapping a particular data source's shape
 * onto a cartridge schema) belong in cartridges or host-app code, not here.
 */

export type {
  RenderToHTMLDeps,
  RenderToHTMLResult,
} from './render-app.js';
export { renderAppToHTML } from './render-app.js';

export type {
  RunPublicationOptions,
  AdapterRunResult,
} from './run-publication.js';
export { runPublicationAdapters } from './run-publication.js';

export type {
  RenderWithPublicationOptions,
  RenderWithPublicationResult,
} from './render-with-publication.js';
export { renderAppWithPublication } from './render-with-publication.js';

export type { FilterServerSafeCartridgeOptions } from './filter-server-safe-cartridge.js';
export { filterServerSafeCartridge } from './filter-server-safe-cartridge.js';

export const PACKAGE_NAME = '@airo-js/ssr';
