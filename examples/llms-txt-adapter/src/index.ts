/**
 * llms.txt PublicationAdapter — a worked example.
 *
 * `llms.txt` (https://llmstxt.org/) is a site-root manifest — the AI-era
 * sibling of `robots.txt`/`sitemap.xml` — that hands an LLM a curated,
 * extraction-friendly index of a site's content: a title, a one-line
 * summary, and sections of `[title](url): description` links. App
 * frameworks (TanStack Start's LLMO guide, others) document it as a
 * convention you hand-author per site.
 *
 * The point of this file: in `@airo-js` it isn't a convention you maintain
 * by hand — it's ONE `PublicationAdapter`. The same primitive that emits
 * Schema.org JSON-LD and Merchant Center XML emits `llms.txt`, off the SAME
 * post-Transformer snapshot. So the AI-discovery manifest can't drift from
 * the rendered widget, the JSON-LD, or the MCP tools: all four answer the
 * same question because they read the same data. That's the contract's
 * "snapshot fidelity" guarantee doing the work an app-framework convention
 * leaves to author discipline.
 *
 * Unlike the publication-adapter-skeleton (stubs only), `generate` and
 * `validate` here are REAL — the example is small enough to implement end
 * to end, and the manifest format is the interesting part.
 *
 * NOT a throwaway type test. It compiles AND produces a correct manifest
 * for the sample snapshot in `__demo` at the bottom.
 */

import type {
  PublicationAdapter,
  PublicationContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
} from '@airo-js/cartridge-kit';

// ─── Schema (a slice mirroring a store cartridge's post-Transformer data) ──
// Kept deliberately close to publication-adapter-skeleton's ProductSnapshot
// so the two examples read as siblings off one notional cartridge schema.

interface StoreSnapshot {
  /** Absolute base URL for the catalogue. Links in the manifest derive from this. */
  siteUrl: string;
  categories: Array<{
    slug: string;
    name: string;
    /** One-line, factual. LLMs extract these verbatim — write them like answers. */
    summary: string;
  }>;
  products: Array<{
    slug: string;
    title: string;
    summary: string;
    offers: Array<{
      price: number;
      currency: string;
      availability: 'in_stock' | 'out_of_stock' | 'preorder';
    }>;
  }>;
}

interface StoreConfig {
  brandName: string;
  /** One-sentence positioning line — becomes the manifest's `>` summary blockquote. */
  tagline: string;
}

/** The adapter's typed output: the manifest text plus a little provenance. */
interface LlmsTxtOutput {
  /** The full `llms.txt` file body, ready to serve at `/llms.txt`. */
  text: string;
  /** Link count — host apps log this; validation cross-checks it's non-zero. */
  linkCount: number;
}

// ─── Manifest builder (pure — no Date.now(), no globals) ───────────────────
// llmstxt.org structure:
//   # Title
//   > summary blockquote
//   ## Section
//   - [name](absolute-url): description

function joinUrl(base: string, path: string): string {
  // Trailing/leading slash hygiene — keeps links absolute and clean without
  // pulling in a URL lib (this must run unchanged on edge runtimes).
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function availabilityLabel(a: StoreSnapshot['products'][number]['offers'][number]['availability']): string {
  // Plain-language, because the audience is an extracting LLM, not a parser
  // keyed on schema.org enum URLs (that's the JSON-LD adapter's job).
  switch (a) {
    case 'in_stock':
      return 'in stock';
    case 'preorder':
      return 'available to preorder';
    case 'out_of_stock':
      return 'out of stock';
  }
}

function buildManifest(snapshot: StoreSnapshot, ctx: PublicationContext<StoreConfig>): LlmsTxtOutput {
  const lines: string[] = [];
  let linkCount = 0;

  lines.push(`# ${ctx.config.brandName}`);
  lines.push('');
  lines.push(`> ${ctx.config.tagline}`);
  lines.push('');

  if (snapshot.categories.length > 0) {
    lines.push('## Categories');
    lines.push('');
    for (const c of snapshot.categories) {
      const url = joinUrl(snapshot.siteUrl, `c/${c.slug}`);
      lines.push(`- [${c.name}](${url}): ${c.summary}`);
      linkCount++;
    }
    lines.push('');
  }

  if (snapshot.products.length > 0) {
    lines.push('## Products');
    lines.push('');
    for (const p of snapshot.products) {
      const url = joinUrl(snapshot.siteUrl, `p/${p.slug}`);
      const offer = p.offers[0];
      // Fold price + availability into the description so the LLM gets the
      // facts inline — it won't follow the link to find them.
      const facts = offer
        ? ` (${offer.price} ${offer.currency}, ${availabilityLabel(offer.availability)})`
        : '';
      lines.push(`- [${p.title}](${url}): ${p.summary}${facts}`);
      linkCount++;
    }
    lines.push('');
  }

  // Single trailing newline — POSIX text file convention.
  return { text: lines.join('\n').replace(/\n+$/, '\n'), linkCount };
}

// ─── The adapter ───────────────────────────────────────────────────────────

export const llmsTxtAdapter: PublicationAdapter<StoreSnapshot, LlmsTxtOutput, StoreConfig> = {
  id: 'llms-txt',
  displayName: 'llms.txt AI manifest',
  description:
    'Curated, extraction-friendly site index (llmstxt.org) served at /llms.txt. The AI-era sibling of robots.txt/sitemap.xml.',

  // 'custom' — llms.txt is a plain-text markdown manifest, not one of the
  // structured formats the framework routes specially. The host app serves
  // the `text` field at the well-known `/llms.txt` path.
  format: 'custom',

  // Coverage gating: the manifest is worthless without titles + the site
  // base URL. Summaries are 'preferred' — a manifest with bare links still
  // works, it's just weaker for extraction, so it warns rather than blocks.
  requires: [
    { path: 'siteUrl', required: 'always' },
    { path: 'product.title', required: 'always' },
    { path: 'product.summary', required: 'preferred' },
    { path: 'category.name', required: 'always' },
    { path: 'category.summary', required: 'preferred' },
  ],

  generate: async (
    snapshot: StoreSnapshot,
    ctx: PublicationContext<StoreConfig>,
  ): Promise<LlmsTxtOutput> => {
    return buildManifest(snapshot, ctx);
  },

  // Real validation — this is the "never publish a broken manifest" gate.
  validate: (output: LlmsTxtOutput): ValidationResult => {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!/^#\s+\S/m.test(output.text)) {
      errors.push({
        code: 'missing-title',
        path: 'text',
        message: 'llms.txt must start with an `# Title` heading.',
        remediation: 'Ensure config.brandName is non-empty.',
      });
    }

    if (output.linkCount === 0) {
      // An empty manifest is worse than none — it tells the LLM "this site
      // has nothing", actively suppressing discovery. Block it.
      errors.push({
        code: 'no-links',
        path: 'text',
        message: 'Manifest contains zero links; refusing to publish an empty index.',
        remediation: 'Check that the snapshot has at least one category or product.',
      });
    }

    // Every link must be absolute — a relative URL in a root manifest
    // resolves against the wrong origin once an LLM dereferences it.
    const relativeLink = /\]\((?!https?:\/\/)[^)]+\)/.exec(output.text);
    if (relativeLink) {
      errors.push({
        code: 'relative-link',
        path: 'text',
        message: `Manifest contains a non-absolute link: ${relativeLink[0]}`,
        remediation: 'Set snapshot.siteUrl to an absolute https:// base URL.',
      });
    }

    if (!/^>\s+\S/m.test(output.text)) {
      warnings.push({
        code: 'missing-summary',
        path: 'text',
        message: 'No `> summary` blockquote — LLMs use it as the site one-liner.',
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  },

  // Every render is fine to regenerate — it's cheap pure string work, no
  // external poll. Host app caches as aggressively as it likes within bounds.
  refreshCadence: { min: { ms: 0 }, max: { ms: 6 * 60 * 60_000 } },

  // Host serves it at the well-known path; it is neither inlined into the
  // widget HTML nor a signed external feed.
  delivery: 'host-decides',

  onValidationFail: 'block-publish',
};

// ─── Demo — proves generate+validate produce a correct manifest ────────────
// Not exported as part of the adapter; here so `tsc` type-checks a real call
// site and a reader can see the output shape without running anything.

const __demoSnapshot: StoreSnapshot = {
  siteUrl: 'https://shop.example.com',
  categories: [
    { slug: 'trail-running', name: 'Trail Running', summary: 'Grippy, lightweight shoes for off-road runs.' },
  ],
  products: [
    {
      slug: 'fellraiser-2',
      title: 'Fellraiser 2',
      summary: 'Aggressive 6mm-lug trail shoe for soft ground.',
      offers: [{ price: 135, currency: 'GBP', availability: 'in_stock' }],
    },
  ],
};

const __demoCtx: PublicationContext<StoreConfig> = {
  config: { brandName: 'Example Outdoors', tagline: 'Specialist trail and fell running kit.' },
  locale: 'en-GB',
  country: 'GB',
};

// Exported so a consumer (or a doctest) can assert against the rendered text.
export const __demo = {
  output: llmsTxtAdapter.generate(__demoSnapshot, __demoCtx),
  validate: (o: LlmsTxtOutput): ValidationResult => llmsTxtAdapter.validate(o),
};

/* __demo.output resolves to:

# Example Outdoors

> Specialist trail and fell running kit.

## Categories

- [Trail Running](https://shop.example.com/c/trail-running): Grippy, lightweight shoes for off-road runs.

## Products

- [Fellraiser 2](https://shop.example.com/p/fellraiser-2): Aggressive 6mm-lug trail shoe for soft ground. (135 GBP, in stock)

*/
