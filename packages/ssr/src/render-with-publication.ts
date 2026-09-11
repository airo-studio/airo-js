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
 *
 * ## Private pages (0.11.0)
 *
 * A page carrying `Page.private: true` exists for one signed-in visitor.
 * This runner never publishes it: no adapter runs, nothing is inlined, and
 * unless the host asserts `renderPrivate: true` (it verified a session for
 * this request) no HTML is rendered either — the result is
 * `skipped: { reason: 'private' }`, which a host maps to 401 the way it
 * maps `fellBack.reason === 'unknown-page'` to 404. With `renderPrivate`
 * the page renders as HTML only; the host serves it
 * `Cache-Control: private, no-store` with `noindex`. Bots are never gated,
 * and private pages are refused rather than gated.
 *
 * ## Gates (0.11.0)
 *
 * The runner never runs gates — server-rendered HTML is un-gated by
 * guarantee. It reports which gates the client's mount will run
 * (`gates.pending`, for hosts that ship a hide in the initial HTML so no
 * frame paints before the gate) and which the host's private render has
 * already met (`gates.satisfied`: the `appliesTo: 'private'` gates when
 * `renderPrivate` is set — the gate that exists to establish the session
 * is satisfied by the render that required it). The host prints the latter
 * on the mount root and the client passes it to
 * `mountCartridge({ satisfiedGates })`.
 */

import {
  describeEntryResolution,
  type AppConfig,
  type EntryFallbackReason,
  type NavigationState,
  type Page,
  type PageRendererFactory,
} from '@airo-js/core';
import type {
  Cartridge,
  PublicationContext,
} from '@airo-js/cartridge-kit';
import { getDefaultRenderResolver, selectGates } from '@airo-js/cartridge-kit';
import { logger } from '@airo-js/log';

import { buildJsonLdScript } from './build-json-ld-script.js';

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
   * Mount-time navigation state. The runner derives the entry page
   * from `initialNavState.page` (validated: must exist, be enabled,
   * not be a subpage, not be a gate page; otherwise falls back to
   * the default entry). All other fields seed `ctx.navState` so the
   * renderer reads context-specific keys (productId, category, query
   * params).
   *
   * Typical pairing with `decodeNavHint`:
   *
   *   const initialNavState = decodeNavHint(req.query.nav, validPages);
   *   const result = await renderAppWithPublication({
   *     ...,
   *     initialNavState,  // undefined falls back to default entry
   *   });
   *
   * When the specified page isn't found, isn't enabled, or is a gate
   * page, the runner falls back to the default entry selection — keeps
   * deeplinks safe against tampered URLs without erroring.
   *
   * Contract: state must be derivable on both server and client from
   * the same inputs. Never serialised into SSR HTML — the client
   * recomputes from the same inputs the server saw.
   */
  initialNavState?: Partial<NavigationState>;
  /**
   * Filter which adapters run. Default: all `format: 'json-ld'` +
   * `delivery: 'inline-in-host'` adapters. Pass to override (e.g. include
   * non-inline adapters in the same run for cache warming).
   */
  publicationFilter?: RunPublicationOptions;
  /**
   * The host asserts it verified a session for THIS request, so a private
   * entry page may be rendered (HTML only — adapters never run for a
   * private page). Default `false`: a private entry is refused with
   * `skipped: { reason: 'private' }`.
   *
   * Set it only after your handler has verified the session. The framework
   * never verifies anything (rendering-only); it also never reads any other
   * input to make this decision — a country- or locale-scoped host must
   * not unlock private pages by accident, so the unlock is this one
   * explicit flag.
   *
   * `true` is shorthand for "this render satisfies every `appliesTo:
   * 'private'` gate" — right when the sign-in gate is the only one, which
   * is what a verified session satisfies. A host with a second
   * private-scoped gate (a paywall tier, a step-up) names exactly the gates
   * its render met: `{ satisfiedGates: ['login'] }`. The runner echoes what
   * the host asserts, restricted to gates that apply to this entry, and the
   * rest stay `pending` for the client. An EMPTY list is not an unlock —
   * `{ satisfiedGates: [] }` refuses like `false` — so a list computed per
   * request cannot open a private page on its anonymous branch.
   */
  renderPrivate?: boolean | { satisfiedGates: ReadonlyArray<string> };
}

export interface RenderWithPublicationResult {
  /** Combined HTML: inline JSON-LD scripts followed by widget markup. */
  html: string;
  /** Per-adapter run result. Inspect for warnings, failed validation, non-inline outputs. */
  adapterResults: AdapterRunResult[];
  /**
   * Set when the runner refused to render the entry page server-side.
   *
   *   - `'csr-only'`: the entry page's view declared
   *     `capabilities: ['csr-only']`. Adapter results still ran normally
   *     and `html` contains the JSON-LD inline scripts (or empty string if
   *     no adapters matched) — the SEO partial-win — unless the page is
   *     also `private`, in which case no adapter ran and `html` is empty.
   *     The client bundle mounts via `mountCartridge` as usual.
   *   - `'private'`: the entry page is `private: true` and the host did
   *     not pass `renderPrivate`. Nothing ran, nothing was inlined,
   *     `html` is empty and `adapterResults` is empty. This is a 401 for a
   *     root-mounted host. `fellBack` MAY accompany it: when the requested
   *     id was rejected and the default entry it fell back to is private,
   *     both are set. Read `fellBack.reason === 'unknown-page'` FIRST — an
   *     unknown url is a 404 whatever the fallback page's privacy — and
   *     only then map a private skip to 401. Read `skipped` before any
   *     "no canonical → 404" rule: a private refusal has no canonical.
   *
   * Open union (the 0.10.0 `AdapterSkipped.reason` precedent): branch on
   * the reason with a default, never on presence alone.
   */
  skipped?: { pageType: string; reason: 'csr-only' | 'private' | (string & {}) };
  /**
   * Set when `initialNavState.page` named a page the runner REJECTED,
   * substituting the default entry. Forwarded verbatim from
   * `renderAppToHTML` — see `RenderToHTMLResult.fellBack`.
   *
   * A root-mounted app reads this to answer 404. Without it,
   * `/does-not-exist` serves the home page with a 200 and a canonical of
   * `/` — a soft 404 that nothing errors about.
   */
  fellBack?: { requested: string; reason: EntryFallbackReason };
  /**
   * What the client's mount will do about gates, reported so the host can
   * ship the right initial HTML. `pending`: ids of the enabled gates
   * `mountCartridge` will run for this entry page (emit
   * `data-airo-gate="pending"` and hide under it if you need zero painted
   * frames). `satisfied`: ids of the `appliesTo: 'private'` gates this
   * private render already met (emit them as
   * `data-airo-gates-satisfied` and pass them to
   * `mountCartridge({ satisfiedGates })`). Both empty when the cartridge
   * has no gates or no entry page resolved.
   */
  gates: { pending: string[]; satisfied: string[] };
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
  // PostProcessors are browser-only BY CONTRACT — they run after render,
  // against a DOM, and this path builds a string. There is no pipeline
  // here and there never will be. Warn rather than stay silent: a
  // cartridge author who puts something load-bearing in a post-processor
  // and then renders it server-side gets no DOM, no error and no output,
  // which is exactly the silent class of failure the 0.9.0 wiring fixed
  // on the client. See best-practices §1.4.
  //
  // Test `.length`, NOT truthiness. `postProcessors: []` is a real and
  // deliberate shape — a consumer ships the declaration slot with an empty
  // array on purpose — and an empty array is truthy, so `if (postProcessors)`
  // would warn on every crawler hit to a JSON-LD or feed route. Do not
  // "simplify" this.
  if ((opts.cartridge.postProcessors?.length ?? 0) > 0) {
    log.warn(
      `cartridge "${opts.cartridge.id}" declares ${opts.cartridge.postProcessors!.length} postProcessor(s); they are browser-only and do NOT run on the SSR path. Anything load-bearing belongs in a Transformer (pre-render, snapshot-shaped) instead.`,
      { cartridgeId: opts.cartridge.id, phase: 'publication' },
    );
  }

  // Entry resolution FIRST — before any adapter runs — via the shared core
  // helper. Same logic PageManager.mountInitial uses on the client, so SSR
  // and CSR pick the same page for any given `initialNavState.page`.
  // Invalid / unknown / disabled / gate / subpage ids fall back to the
  // default entry — keeps the SSR path safe against tampered or stale
  // deeplinks. It has to come first because a private entry page must
  // stop the adapters from running at all (below).
  const isGate = opts.isGatePage ?? (() => false);
  const entryResolution = describeEntryResolution(
    opts.appConfig.pages,
    isGate,
    opts.initialNavState?.page,
  );
  const entryPage = entryResolution.page;
  // Threaded onto every return path below, including both skips — a host
  // answering 404 must not have that decision depend on whether the
  // fallback page happened to be server-renderable.
  const fellBack = entryResolution.fellBack ? { fellBack: entryResolution.fellBack } : {};
  const hostSatisfied =
    typeof opts.renderPrivate === 'object' && opts.renderPrivate !== null
      ? opts.renderPrivate.satisfiedGates
      : undefined;
  // An empty list is NOT an unlock: a host computing
  // `{ satisfiedGates: session ? ['login'] : [] }` must not serve private
  // HTML to the anonymous branch. To render privately with no gate to
  // satisfy, pass `true`.
  const privateUnlock = opts.renderPrivate === true || (hostSatisfied !== undefined && hostSatisfied.length > 0);
  const gates = gatesFor(opts.cartridge, entryPage, opts.publicationCtx.config, privateUnlock, hostSatisfied);

  // ── The private / csr-only decision table ─────────────────────────────
  //
  //   page.private  renderPrivate  view csr-only  │ adapters  html     skipped
  //   ─────────────────────────────────────────────┼────────────────────────────
  //   false         —              false          │ run       widget   —
  //   false         —              true           │ run       json-ld  csr-only
  //   true          false          —              │ NONE      ''       private
  //   true          true           false          │ NONE      widget   —
  //   true          true           true           │ NONE      ''       csr-only
  //
  // Page-private is checked first and refusal wins: a private page's view
  // being csr-only must never turn into "inline the JSON-LD anyway".
  const isPrivate = entryPage?.private === true;
  if (entryPage && isPrivate && !privateUnlock) {
    log.info(
      `renderAppWithPublication: refusing private page '${entryPage.id}' (pageType: ${entryPage.type}) — no renderPrivate. Nothing rendered, nothing published.`,
      { pageType: entryPage.type, pageId: entryPage.id, phase: 'private-page' },
    );
    return {
      html: '',
      adapterResults: [],
      skipped: { pageType: entryPage.type, reason: 'private' },
      gates,
      ...fellBack,
    };
  }

  // Default filter: the two formats that belong on the render hot path —
  // JSON-LD (inlined into the returned fragment below) and head-meta
  // (returned in `adapterResults` for `headFromPublication` to fold into
  // a document head). Deliberately NOT `'custom'`: llms.txt and feed
  // adapters declare that, and running them on every page render would
  // do expensive work whose output this function then discards.
  //
  // Behaviour is unchanged for cartridges shipped before 0.9.0, since
  // nothing declared `'head-meta'` until it existed.
  const filter: RunPublicationOptions = opts.publicationFilter ?? {
    formats: ['json-ld', 'head-meta'],
    deliveries: ['inline-in-host'],
  };

  // Run adapters (public pages only) — surfaces validation errors before
  // we commit to rendering. Cheaper to abort here than after a full SSR
  // pass. Also means CSR-only views still get their JSON-LD surfaced to
  // crawlers. A private page gets NO adapter run: adapters are page-blind
  // and would happily publish whatever the private snapshot holds.
  const adapterResults: AdapterRunResult[] = isPrivate
    ? []
    : await runPublicationAdapters(opts.cartridge, opts.snapshot, opts.publicationCtx, filter);

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
  // JSON-LD blocks alone (empty for a private page, by construction). Host
  // app's client bundle mounts as usual. Mailbox-only cartridges
  // (chunk-registered views) skip the check — capability info isn't
  // available before the chunk loads. Cartridges that need the gate ship a
  // factory-less `views[]` entry carrying the capability.
  //
  // This check runs BEFORE `getDefaultRenderResolver` so csr-only
  // cartridges (typically lighter — no resolver registry needed) don't
  // pay the resolver-construction cost on the SSR-skip path.
  if (entryPage) {
    const entryView = opts.cartridge.views?.find((v) => v.pageType === entryPage.type);
    if (entryView?.capabilities?.includes('csr-only')) {
      log.info(
        `renderAppWithPublication: skipping SSR for csr-only view '${entryView.id}' (pageType: ${entryPage.type}). ${isPrivate ? 'Private page: nothing inlined.' : 'JSON-LD still inlined.'}`,
        { pageType: entryPage.type, viewId: entryView.id, phase: 'capability-gate' },
      );
      return {
        html: inlineScripts,
        adapterResults,
        skipped: { pageType: entryPage.type, reason: 'csr-only' },
        gates,
        ...fellBack,
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
    // Forward the full initialNavState so renderAppToHTML resolves the
    // same entry page AND seeds the same ctx.navState the capability-
    // gate branch saw. Both branches now agree on the page AND the
    // context fields (productId, category, query params) the renderer
    // reads.
    initialNavState: opts.initialNavState,
    appContext: {
      cartridgeId: opts.cartridge.id,
      config: opts.publicationCtx.config,
      data: opts.snapshot,
    },
    // The private decision was made above; the low-level renderer keeps
    // the same promise and must be told it was.
    renderPrivate: privateUnlock,
  };

  const { html: widgetHtml } = renderAppToHTML(opts.appConfig, renderDeps);

  const html = inlineScripts ? `${inlineScripts}\n${widgetHtml}` : widgetHtml;
  return { html, adapterResults, gates, ...fellBack };
}

/**
 * What the client's mount will do about gates for this entry page — the
 * same `selectGates` the runtime uses, so the two sides cannot disagree.
 * `satisfied` is the private-scoped subset when the host rendered privately.
 */
function gatesFor<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  entryPage: Page | undefined,
  config: TConfig,
  renderPrivate: boolean,
  hostSatisfied: ReadonlyArray<string> | undefined,
): { pending: string[]; satisfied: string[] } {
  // No entry page: `selectGates` fails closed (every gate), so the client
  // WILL run them all — report them as pending rather than nothing.
  const enabled = selectGates(cartridge.gates, entryPage).filter((g) => g.isEnabled(config));
  if (!entryPage) return { pending: enabled.map((g) => g.id), satisfied: [] };
  // `renderPrivate: true` is shorthand for "every private-scoped gate"; the
  // object form names exactly what the host verified. Either way only a
  // gate that applies to this entry can be satisfied — the host's list is
  // echoed, not trusted beyond the gates that would have run.
  const satisfiedByRender = renderPrivate && entryPage.private === true;
  const isSatisfied = (gate: (typeof enabled)[number]): boolean =>
    hostSatisfied ? hostSatisfied.includes(gate.id) : satisfiedByRender && gate.appliesTo === 'private';
  const pending: string[] = [];
  const satisfied: string[] = [];
  for (const gate of enabled) {
    if (isSatisfied(gate)) satisfied.push(gate.id);
    else pending.push(gate.id);
  }
  return { pending, satisfied };
}
