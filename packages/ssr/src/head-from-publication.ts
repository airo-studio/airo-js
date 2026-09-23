/**
 * headFromPublication — fold publication-adapter output into a
 * `DocumentHead` patch.
 *
 * This is the seam that lets `renderDocument` consume crawler metadata
 * without `@airo-js/ssr` knowing that `defineCrawlerSurfaceAdapter`
 * exists.
 *
 * ## Keys on SHAPE, never on adapter id
 *
 * An output contributes if it structurally carries head metadata — a
 * string `canonical`, a record `openGraph` / `twitterCard`. It is never
 * matched on `adapterId`, on `displayName`, or on a magic string. So a
 * hand-written adapter works identically to a factory-built one, and
 * renaming an adapter cannot silently empty a `<head>`.
 *
 * Same duck-typing discipline as `getDefaultRenderResolver` (keys on
 * `views[]` / `mailboxName`) and `filterServerSafeCartridge` (keys on
 * `capabilities` strings).
 *
 * ## The publish gate reaches the document here
 *
 * Results with `included: false` are SKIPPED. That is the whole point of
 * `onValidationFail: 'block-publish'`: an adapter whose `validate()`
 * rejected — a missing canonical, say — must not have its output reach a
 * crawler. This function is where that promise is kept for the `<head>`.
 */

import type { DocumentHead } from './render-document.js';
import type { AdapterRunResult } from './run-publication.js';

export interface HeadFromPublicationOptions {
  /**
   * Fold `format: 'json-ld'` outputs into `head.jsonLd`. Default FALSE.
   *
   * `renderAppWithPublication` already inlines those into the fragment it
   * returns, so folding them in here as well emits every block twice.
   * Set true only on the `renderAppToHTML` + `runPublicationAdapters`
   * composition path, where nothing has inlined them yet.
   */
  includeJsonLd?: boolean;
}

/** The structural shape this function recognises. All fields optional. */
interface CrawlerSurfaceLike {
  canonical?: unknown;
  openGraph?: unknown;
  twitterCard?: unknown;
  alternates?: unknown;
}

interface AlternateLike {
  hreflang: string;
  href: string;
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

/** `[{ hreflang, href }]`, both non-empty strings. Keyed on shape, like the rest. */
function isAlternates(v: unknown): v is readonly AlternateLike[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { hreflang, href } = entry as Partial<AlternateLike>;
    return typeof hreflang === 'string' && hreflang !== '' && typeof href === 'string' && href !== '';
  });
}

/**
 * Build a `DocumentHead` patch from adapter results. Spread it over your
 * own head fields:
 *
 *   head: { lang, title, ...headFromPublication(result.adapterResults) }
 *
 * Later adapters win on conflicting keys, and `openGraph` / `twitterCard`
 * records merge key-by-key rather than replacing wholesale — so one
 * adapter can contribute `og:image` without clobbering another's
 * `og:title`.
 *
 * `alternates: [{ hreflang, href }]` becomes `links: [{ rel: 'alternate',
 * href, attrs: { hreflang } }]` (0.11.2). `defineCrawlerSurfaceAdapter`
 * emits that field, and until 0.11.2 this function dropped it, so a
 * multi-language site served a canonical and no hreflang unless the host
 * mapped it itself. The patch REPLACES `links` rather than merging into
 * yours: spread it first and put your own `links` after it if you have any,
 * or fold your links into the adapter's `alternates` selector.
 */
export function headFromPublication(
  results: readonly AdapterRunResult[],
  opts: HeadFromPublicationOptions = {},
): Partial<DocumentHead> {
  const patch: Partial<DocumentHead> = {};
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const jsonLd: unknown[] = [];
  // Keyed by hreflang so a later adapter overrides an earlier one's href for
  // the same language, the way `openGraph` merges key-by-key. Insertion order
  // is the emitted order.
  const alternates = new Map<string, string>();

  for (const result of results) {
    // The hard publish gate. Never serve output that failed validation.
    if (!result.included) continue;

    if (result.format === 'json-ld') {
      if (opts.includeJsonLd) jsonLd.push(result.output);
      continue;
    }

    const output = result.output as CrawlerSurfaceLike | null | undefined;
    if (typeof output !== 'object' || output === null) continue;

    if (typeof output.canonical === 'string' && output.canonical) {
      patch.canonical = output.canonical;
    }
    if (isRecordOfStrings(output.openGraph)) Object.assign(openGraph, output.openGraph);
    if (isRecordOfStrings(output.twitterCard)) Object.assign(twitter, output.twitterCard);
    if (isAlternates(output.alternates)) {
      for (const { hreflang, href } of output.alternates) alternates.set(hreflang, href);
    }
  }

  if (Object.keys(openGraph).length > 0) patch.openGraph = openGraph;
  if (Object.keys(twitter).length > 0) patch.twitter = twitter;
  if (jsonLd.length > 0) patch.jsonLd = jsonLd;
  if (alternates.size > 0) {
    patch.links = [...alternates].map(([hreflang, href]) => ({
      rel: 'alternate',
      href,
      attrs: { hreflang },
    }));
  }

  return patch;
}
