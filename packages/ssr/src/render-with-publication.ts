/**
 * renderAppWithPublication — SSR + inline-host publication outputs in
 * one call.
 *
 * The SEO landing helper. Renders the cartridge's entry page to HTML
 * (via `renderAppToHTML`), runs the cartridge's PublicationAdapters
 * (via `runPublicationAdapters`), and inlines the `inline-in-host`
 * outputs as `<script type="application/ld+json">` tags before the
 * widget markup. Returns the combined HTML plus per-adapter results
 * so the host app can audit / log / publish non-inline outputs separately.
 *
 * What gets inlined:
 *   - format `'json-ld'` adapters with `delivery: 'inline-in-host'`,
 *     where `included === true` (passed validation, or
 *     `onValidationFail: 'publish-with-warnings'`).
 *
 * What's NOT inlined:
 *   - non-`json-ld` formats (XML feeds, MCP-tool manifests, etc).
 *     Host apps deliver these via signed URLs / out-of-band channels.
 *     They still appear in `adapterResults` for visibility.
 *   - `inline-in-host` adapters that failed validation under the default
 *     `'block-publish'` policy. Output is in the result (`included: false`)
 *     for diagnostic, but never served.
 *
 * Inline placement: JSON-LD scripts go BEFORE the widget HTML. Host apps
 * embedding the SSR response into a `<head>`-or-`<body>` slot on the page
 * get the structured data and the widget markup as one blob.
 */

import type {
  AppConfig,
  PageRendererFactory,
} from '@airo-js/core';
import type {
  Cartridge,
  PublicationContext,
} from '@airo-js/cartridge-kit';
import { getDefaultRenderResolver } from '@airo-js/cartridge-kit';
import { logger } from '@airo-js/log';

import {
  renderAppToHTML,
  type RenderToHTMLDeps,
} from './render-app.js';
import {
  runPublicationAdapters,
  type AdapterRunResult,
  type RunPublicationOptions,
} from './run-publication.js';

const log = logger('ssr');

export interface RenderWithPublicationOptions<
  TData,
  TConfig,
  TPageType extends string = string,
> {
  /** The cartridge being rendered. */
  cartridge: Cartridge<TData, TConfig>;
  /** AppConfig the framework consumes — typically built from a Template. */
  appConfig: AppConfig<TPageType>;
  /** Post-Transformer snapshot — the same data views and adapters consume. */
  snapshot: TData;
  /** Per-render publication context (locale, country, currency, …). */
  publicationCtx: PublicationContext<TConfig>;
  /** Document for SSR DOM construction. Required server-side. */
  document?: Document;
  /**
   * Page-renderer resolver. Defaults to `cartridge.views[]` lookup; override
   * for multi-cartridge host apps using `registry.resolverFor(cartridgeId)`.
   */
  resolveRenderer?: (
    pageType: TPageType,
  ) => PageRendererFactory<TPageType, unknown> | undefined;
  /** Predicate identifying gate pages (e.g. age verification). */
  isGatePage?: (pageType: TPageType) => boolean;
  /**
   * Filter which adapters run. Default: all `format: 'json-ld'` +
   * `delivery: 'inline-in-host'` adapters. Pass to override (e.g. include
   * non-inline adapters in the same run for cache warming).
   */
  publicationFilter?: RunPublicationOptions;
}

export interface RenderWithPublicationResult {
  /** Combined HTML: inline JSON-LD scripts followed by widget markup. */
  html: string;
  /** Per-adapter run result. Inspect for warnings, failed validation, non-inline outputs. */
  adapterResults: AdapterRunResult[];
  /**
   * Set when the entry page's view declared `capabilities: ['csr-only']`
   * — the SSR runner refuses to render it server-side. Adapter results
   * still ran normally; `html` contains the JSON-LD inline scripts (or
   * empty string if no adapters matched). The client bundle will mount
   * via mountCartridge as usual; this branch is the SEO partial-win.
   */
  skipped?: { pageType: string; reason: 'csr-only' };
}

/**
 * Render the cartridge's entry page with inline publication outputs.
 *
 * Failure modes:
 *   - No Document available → throws.
 *   - No renderer for entry page → throws.
 *   - Adapter `generate()` throws → propagates (wrap in try/catch for
 *     partial-success semantics).
 *   - Adapter validation fails under `onValidationFail: 'fail-loud'` → throws.
 *   - Adapter validation fails under default `'block-publish'` → output
 *     dropped from inline; included in `adapterResults` with `included: false`.
 */
export async function renderAppWithPublication<
  TData,
  TConfig,
  TPageType extends string = string,
>(
  opts: RenderWithPublicationOptions<TData, TConfig, TPageType>,
): Promise<RenderWithPublicationResult> {
  // Default filter: inline JSON-LD only. Host apps that want everything
  // pass an empty filter or explicit overrides.
  const filter: RunPublicationOptions = opts.publicationFilter ?? {
    formats: ['json-ld'],
    deliveries: ['inline-in-host'],
  };

  // Run adapters first — surfaces validation errors before we commit to
  // rendering. Cheaper to abort here than after a full SSR pass. Also
  // means CSR-only views still get their JSON-LD surfaced to crawlers.
  const adapterResults = await runPublicationAdapters(
    opts.cartridge,
    opts.snapshot,
    opts.publicationCtx,
    filter,
  );

  // Build the inline JSON-LD blocks up front — emitted regardless of
  // whether the widget renders.
  const inlineScripts = adapterResults
    .filter(
      (r) =>
        r.included &&
        r.format === 'json-ld' &&
        r.delivery === 'inline-in-host',
    )
    .map((r) => buildJsonLdScript(r.output))
    .join('\n');

  // Gap 4 — capability gate. Walk the cartridge's views to find the entry
  // page's view; if it declared `csr-only`, refuse SSR and return the
  // JSON-LD blocks alone. Host app's client bundle mounts as usual.
  // Mailbox-only cartridges (chunk-registered views) skip the check —
  // capability info isn't available before the chunk loads. Cartridges
  // that need the gate must ship a static `views[]` entry.
  //
  // This check runs BEFORE `getDefaultRenderResolver` so csr-only
  // cartridges (typically lighter — no resolver registry needed) don't
  // pay the resolver-construction cost on the SSR-skip path.
  const isGate = opts.isGatePage ?? (() => false);
  const entryPage = opts.appConfig.pages.find(
    (p) => p.enabled && !p.parent && !isGate(p.type),
  );
  if (entryPage) {
    const entryView = opts.cartridge.views?.find((v) => v.pageType === entryPage.type);
    if (entryView?.capabilities?.includes('csr-only')) {
      log.info(
        `renderAppWithPublication: skipping SSR for csr-only view '${entryView.id}' (pageType: ${entryPage.type}). JSON-LD still inlined.`,
        { pageType: entryPage.type, viewId: entryView.id, phase: 'capability-gate' },
      );
      return {
        html: inlineScripts,
        adapterResults,
        skipped: { pageType: entryPage.type, reason: 'csr-only' },
      };
    }
  }

  // Default the renderer resolver via cartridge-kit's getDefaultRenderResolver.
  // Supports both static `views[]` and per-cartridge chunk mailboxes
  // (`cartridge.mailboxName`). Cast: registry returns its heterogeneous
  // ChunkFactory shape; the call site narrows to TPageType — sound because
  // every factory the registry returns originated from this cartridge's
  // `views[]` or `pushToMailbox(cartridge.mailboxName, ...)`.
  const resolveRenderer =
    opts.resolveRenderer ??
    (getDefaultRenderResolver(opts.cartridge) as (
      pageType: TPageType,
    ) => PageRendererFactory<TPageType, unknown> | undefined);

  const renderDeps: RenderToHTMLDeps<TPageType, unknown> = {
    document: opts.document,
    resolveRenderer,
    isGatePage: opts.isGatePage,
    appContext: {
      cartridgeId: opts.cartridge.id,
      config: opts.publicationCtx.config,
      data: opts.snapshot,
    },
  };

  const { html: widgetHtml } = renderAppToHTML(opts.appConfig, renderDeps);

  const html = inlineScripts ? `${inlineScripts}\n${widgetHtml}` : widgetHtml;
  return { html, adapterResults };
}

/**
 * Serialise a JSON-LD payload into a `<script type="application/ld+json">`
 * tag. Escapes the closing-script sequence so an attacker controlling
 * a snapshot field can't break out of the script context.
 *
 * Note: `<` is the JSON-safe encoding for `<`. JSON-LD payloads are
 * data only (no executable JS), so the only XSS surface is the literal
 * `</script>` substring in a string field. Replacing the `<` defeats it.
 */
function buildJsonLdScript(payload: unknown): string {
  const safe = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${safe}</script>`;
}
