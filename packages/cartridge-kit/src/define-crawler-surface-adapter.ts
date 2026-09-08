/**
 * defineCrawlerSurfaceAdapter — the classic crawler bundle as a
 * PublicationAdapter: canonical URL, OpenGraph, Twitter Card, and a
 * per-page sitemap entry, all derived from the post-Transformer snapshot.
 *
 * ## Why this is a framework primitive and not host-app code
 *
 * It is the AIO thesis made mechanical. A host that hand-maintains
 * `<head>` metadata derives the page title twice — once for the human
 * render, once for the crawler — and the two drift the moment anyone
 * edits one. Sourcing both from the same snapshot makes drift
 * structurally impossible, which is the same guarantee `PublicationAdapter`
 * already gives JSON-LD, feeds and MCP tools. Pair with `renderDocument`
 * + `headFromPublication` in `@airo-js/ssr` and the title a crawler sees
 * cannot differ from the title the page renders.
 *
 * `validate()` blocks publish on a missing canonical, so a page that
 * cannot say where it canonically lives does not reach a crawler at all.
 *
 * ## Selectors, not a field-path map
 *
 * The factory cannot know your snapshot's shape, and the seam for that is
 * one user-supplied pure function per field — the same answer
 * `defineSSRSafeRenderer` gives with its `template(ctx)`.
 *
 * A dot-path map (`{ title: 'seo.title' }`) was considered and rejected:
 * it is string-typed and unrefactorable, it returns `unknown` so every
 * read needs a runtime guard, and above all it CANNOT COMPUTE. Real
 * canonical URLs are composed (`siteUrl` + `pathPrefix` + `slug`, with
 * trailing-slash normalisation), and descriptions are truncated and
 * stripped of markup. A path can express none of that.
 *
 * cartridge-kit does use dot-paths elsewhere (`globalConfigKey`,
 * `hotSwapKeys`, `SchemaFieldRef.path`) — but every one of those exists
 * because the path must SERIALISE into editor metadata for a studio to
 * render a form. There is no form here, so the justification does not
 * transfer.
 *
 * ## Where the M13 line sits on sitemaps
 *
 * This emits ONE `SitemapEntry` for the page it was given. That is
 * snapshot-shaped, derivable from `(snapshot, ctx)` with no extra I/O,
 * and inert — the framework never reads it back or acts on it, exactly
 * like `refreshCadence` and `DataSource.cacheTtlMs`.
 *
 * The framework does NOT serialise `sitemap.xml`, enumerate or discover
 * pages, write, cache, ping search engines, or schedule regeneration.
 *
 * The next request is predictable — *"just ship `buildSitemapXml(entries)`,
 * it's a pure function"*. It is pure, and it is still wrong: to HAVE that
 * array you need a site-wide page inventory, and holding an inventory
 * means enumeration plus persistence, which is state the framework is not
 * allowed to own. Assembling the document from these entries is a host
 * job. See `examples/full-site` for what that looks like (~15 lines).
 *
 * Consequence worth stating: if sitemap.xml assembly ever lands here,
 * `changefreq` and `priority` stop being inert and this file becomes an
 * M13 violation.
 *
 * ## What this factory deliberately will not do
 *
 * No image-reachability checks, no taxonomy lookups, no title/description
 * length linting. The first two are network I/O the contract keeps out of
 * `generate()`; the third is content strategy, which best-practices §5.11
 * puts on the cartridge author, not the framework.
 *
 * Shape resurrected from a pre-0.9 `classic-crawler-surface` adapter that
 * existed only as untracked build output; its `generate`/`validate`
 * behaviour is preserved here with the field mapping generalised.
 */

import type {
  Duration,
  PublicationAdapter,
  PublicationContext,
  SchemaFieldRef,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './publication-adapter.js';

/** A single sitemap URL entry. `changefreq` / `priority` are inert hints — see the docblock. */
export interface SitemapEntry {
  loc: string;
  /** ISO-8601. */
  lastmod?: string;
  changefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority?: number;
}

export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

/** What this adapter emits. Drops straight into `renderDocument`'s `DocumentHead`. */
export interface CrawlerSurfaceOutput {
  canonical: string;
  /** `'og:title'` → value. */
  openGraph: Record<string, string>;
  /** `'twitter:card'` → value. */
  twitterCard: Record<string, string>;
  sitemap: SitemapEntry;
  alternates?: readonly HreflangAlternate[];
}

/** A pure projection from the snapshot (plus publication context) to one field. */
export type CrawlerSurfaceSelect<TData, TConfig, R> = (
  snapshot: TData,
  ctx: PublicationContext<TConfig>,
) => R;

export interface CrawlerSurfaceSelectors<TData, TConfig> {
  /** Absolute canonical URL. `validate()` blocks publish without it. */
  canonical: CrawlerSurfaceSelect<TData, TConfig, string>;
  title: CrawlerSurfaceSelect<TData, TConfig, string>;
  description: CrawlerSurfaceSelect<TData, TConfig, string>;
  siteName?: CrawlerSurfaceSelect<TData, TConfig, string | undefined>;
  /** Absolute image URL. Drives `og:image` and the Twitter card variant. */
  image?: CrawlerSurfaceSelect<TData, TConfig, string | undefined>;
  /** ISO-8601 → `sitemap.lastmod`. */
  lastModified?: CrawlerSurfaceSelect<TData, TConfig, string | undefined>;
  /** `og:type`. Defaults to `'website'`. */
  ogType?: CrawlerSurfaceSelect<TData, TConfig, string>;
  /** Merged LAST, so it can override a base key. `article:published_time`, `product:price:amount`, … */
  extraOpenGraph?: CrawlerSurfaceSelect<TData, TConfig, Record<string, string>>;
  extraTwitter?: CrawlerSurfaceSelect<TData, TConfig, Record<string, string>>;
  /** Merged over `{ loc: canonical, lastmod }`. */
  sitemap?: CrawlerSurfaceSelect<TData, TConfig, Partial<SitemapEntry>>;
  alternates?: CrawlerSurfaceSelect<TData, TConfig, readonly HreflangAlternate[]>;
}

export interface CrawlerSurfaceAdapterOptions<TData, TConfig> {
  /** Defaults to `'crawler-surface'`. */
  id?: string;
  displayName?: string;
  description?: string;
  /**
   * REQUIRED — no default, deliberately.
   *
   * Coverage gating (contract guarantee #2) is studio-facing metadata the
   * factory cannot infer: selectors are opaque functions, and
   * `SchemaFieldRef.path` is a path into the cartridge SCHEMA rather than
   * the snapshot. Defaulting to `[]` would silently disable the guarantee
   * for every cartridge that used this factory.
   *
   * A reasonable starting point:
   *
   *   requires: [
   *     { path: 'title',       required: 'always' },
   *     { path: 'description', required: 'always' },
   *     { path: 'slug',        required: 'always' },
   *     { path: 'updatedAt',   required: 'always' },
   *     { path: 'ogImage',     required: 'preferred' },
   *   ]
   *
   * `runPublicationAdapters` gates on the `required: 'always'` entries as of
   * 1.0: an adapter whose always-paths hold no value in the snapshot is
   * skipped before `generate()` and reported with the missing paths.
   * `'preferred'` and `'optional'` remain declared metadata for hosts and
   * studios. The schema-space→snapshot-space resolution this note once
   * called blocking turned out not to be: `SchemaDefinition<TData>.parse`
   * returns `TData`, so a schema path and a snapshot path name the same
   * place, and `getByPath` resolves both.
   *
   * Paths are typed against `TData`, which is one more reason to pass the
   * type arguments explicitly: with them, a path this snapshot cannot have
   * is a compile error here rather than a skipped bundle at publish time.
   */
  requires: readonly SchemaFieldRef<TData>[];
  select: CrawlerSurfaceSelectors<TData, TConfig>;
  /** Defaults to `{ min: 0ms, max: 24h }`. */
  refreshCadence?: { min: Duration; max: Duration };
  /** Defaults to `'block-publish'` — a page that can't name its canonical shouldn't reach a crawler. */
  onValidationFail?: 'block-publish' | 'publish-with-warnings' | 'fail-loud';
  /** Defaults to `'inline-in-host'`. */
  delivery?: 'inline-in-host' | 'signed-feed-url' | 'host-decides';
  /**
   * Defaults to `'head-meta'`. Overriding this opts OUT of the default
   * `renderAppWithPublication` filter, so the adapter will stop running on
   * the render path unless the caller passes an explicit `publicationFilter`.
   */
  format?: PublicationAdapter<TData, CrawlerSurfaceOutput, TConfig>['format'];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function isAbsoluteUrl(value: string): boolean {
  // `URL` is a web standard available in Workers, Deno, browsers and Node
  // — not a Node built-in — so this keeps the package runtime-agnostic.
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Build a `PublicationAdapter` that emits the classic crawler bundle from
 * a post-Transformer snapshot.
 *
 * `TData` appears only in selector parameter positions, so TypeScript
 * cannot infer it from the options object — pass the type arguments
 * explicitly, as with `defineSSRSafeRenderer`:
 *
 * ```ts
 * const crawlerSurface = defineCrawlerSurfaceAdapter<ArticleData, SiteConfig>({
 *   requires: [{ path: 'title', required: 'always' }],
 *   select: {
 *     canonical: (d, ctx) => `${ctx.config.siteUrl.replace(/\/$/, '')}/${d.slug}`,
 *     title: (d) => d.title,
 *     description: (d) => d.summary,
 *     image: (d) => d.heroImage,
 *     lastModified: (d) => d.updatedAt,
 *     ogType: () => 'article',
 *   },
 * });
 * ```
 */
export function defineCrawlerSurfaceAdapter<TData, TConfig = unknown>(
  opts: CrawlerSurfaceAdapterOptions<TData, TConfig>,
): PublicationAdapter<TData, CrawlerSurfaceOutput, TConfig> {
  const select = opts.select;

  return {
    id: opts.id ?? 'crawler-surface',
    displayName: opts.displayName ?? 'Crawler surface bundle',
    description:
      opts.description ??
      'Canonical URL, OpenGraph, Twitter Card, and a sitemap entry, derived from the post-Transformer snapshot. The host routes the bundle to its delivery points.',
    format: opts.format ?? 'head-meta',
    requires: [...opts.requires],
    refreshCadence: opts.refreshCadence ?? { min: { ms: 0 }, max: { ms: DAY_MS } },
    delivery: opts.delivery ?? 'inline-in-host',
    onValidationFail: opts.onValidationFail ?? 'block-publish',

    // eslint-disable-next-line @typescript-eslint/require-await -- contract is async; selectors are pure and sync
    async generate(snapshot, ctx): Promise<CrawlerSurfaceOutput> {
      const canonical = select.canonical(snapshot, ctx);
      const title = select.title(snapshot, ctx);
      const description = select.description(snapshot, ctx);
      const siteName = select.siteName?.(snapshot, ctx);
      const image = select.image?.(snapshot, ctx);
      const lastmod = select.lastModified?.(snapshot, ctx);

      const openGraph: Record<string, string> = {
        'og:type': select.ogType?.(snapshot, ctx) ?? 'website',
        'og:url': canonical,
        'og:title': title,
        'og:description': description,
      };
      // Omit rather than emit an empty value — an empty og:site_name is
      // worse than none, and crawlers treat the two differently.
      if (siteName) openGraph['og:site_name'] = siteName;
      if (image) openGraph['og:image'] = image;
      Object.assign(openGraph, select.extraOpenGraph?.(snapshot, ctx) ?? {});

      const twitterCard: Record<string, string> = {
        'twitter:card': image ? 'summary_large_image' : 'summary',
        'twitter:title': title,
        'twitter:description': description,
      };
      if (image) twitterCard['twitter:image'] = image;
      Object.assign(twitterCard, select.extraTwitter?.(snapshot, ctx) ?? {});

      const sitemap: SitemapEntry = {
        loc: canonical,
        ...(lastmod ? { lastmod } : {}),
        ...(select.sitemap?.(snapshot, ctx) ?? {}),
      };

      const alternates = select.alternates?.(snapshot, ctx);

      return {
        canonical,
        openGraph,
        twitterCard,
        sitemap,
        ...(alternates && alternates.length > 0 ? { alternates } : {}),
      };
    },

    validate(output): ValidationResult {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      if (!output.canonical) {
        errors.push({
          code: 'missing-canonical',
          path: 'canonical',
          message: 'Crawler bundle requires a canonical url.',
          remediation: 'Return an absolute url from `select.canonical`.',
        });
      } else if (!isAbsoluteUrl(output.canonical)) {
        // The most common real-world SEO defect, and a free string check:
        // a relative canonical resolves against whatever page a crawler
        // found it on, which silently canonicalises to the wrong url.
        errors.push({
          code: 'canonical-not-absolute',
          path: 'canonical',
          message: `Canonical url must be absolute, got "${output.canonical}".`,
          remediation: 'Compose it from an absolute site url in `select.canonical`.',
        });
      }

      if (!output.sitemap?.loc) {
        errors.push({
          code: 'missing-sitemap-loc',
          path: 'sitemap.loc',
          message: 'Sitemap entry requires loc.',
        });
      }

      if (!output.openGraph['og:title']) {
        errors.push({
          code: 'missing-og-title',
          path: 'openGraph.og:title',
          message: 'OpenGraph requires og:title.',
        });
      }

      if (!output.openGraph['og:description']) {
        warnings.push({
          code: 'missing-og-description',
          path: 'openGraph.og:description',
          message: 'OpenGraph description is empty — social previews will fall back to page text.',
        });
      }
      if (!output.openGraph['og:image']) {
        warnings.push({
          code: 'missing-og-image',
          path: 'openGraph.og:image',
          message: 'No og:image — the card renders as a small summary rather than a large image.',
        });
      }

      // Coverage over the OPTIONAL enrichment fields; the required ones
      // are errors above rather than coverage gaps.
      const optional = ['og:site_name', 'og:image'] as const;
      const covered = optional.filter((k) => Boolean(output.openGraph[k])).length;

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        coverage: { covered, total: optional.length },
      };
    },
  };
}
