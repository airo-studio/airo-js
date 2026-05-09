/**
 * AIO Score formula — "Lighthouse for AI" applied to an airo-js cartridge.
 *
 * v0 formula (per /plan-eng-review, 2026-05-08): five equal-weighted inputs,
 * 20% each, total 0-100. Recompute on save with a 300ms debounce in the
 * caller (this module is pure).
 *
 * The five inputs:
 *   1. Structured data present
 *      One PublicationAdapter declares format='json-ld' AND validates
 *      against the current data snapshot.
 *   2. Adapter coverage
 *      Across all adapters, the share of adapter `requires` paths whose
 *      cardinality='always' fields are populated in the data. Soft requirements
 *      ('preferred'/'optional') count proportionally.
 *   3. MCP tools available
 *      The cartridge declares at least one McpToolDefinition.
 *   4. llms.txt presence
 *      An adapter whose id or format signals an llms.txt-shaped output.
 *   5. Classic crawler completeness
 *      An adapter that emits canonical + sitemap + og + twitter (the design
 *      doc's "classic crawler bundle") AND validates.
 *
 * The formula is intentionally crude at v0. Iteration follows feedback once
 * studio-lite is shipping and we see real cartridges driving the editor.
 */

import type {
  Cartridge,
  PublicationAdapter,
  PublicationContext,
  SchemaFieldRef,
  ValidationResult,
} from '@airo-js/cartridge-kit';

export interface ScoreInputBreakdown {
  /** Stable id; stable across runs so UIs can render persistent rows. */
  id:
    | 'structured-data'
    | 'adapter-coverage'
    | 'mcp-tools'
    | 'llms-txt'
    | 'classic-crawler';
  label: string;
  /** 0-100, this dimension's contribution. */
  score: number;
  /** Weight of this dimension in the composite. v0: always 20. */
  weight: number;
  /** Short human-readable narrative on what would raise the score. */
  hint: string;
}

export interface AioScore {
  /** 0-100 composite. */
  total: number;
  breakdown: ScoreInputBreakdown[];
}

/** Default PublicationContext for score-time generate() calls. */
const SCORE_CONTEXT: PublicationContext<unknown> = {
  config: {},
  locale: 'en',
  country: 'US',
};

export async function computeAioScore<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  data: TData,
): Promise<AioScore> {
  const adapters = (cartridge.publicationAdapters ?? []) as PublicationAdapter<
    TData,
    unknown,
    TConfig
  >[];

  const breakdown: ScoreInputBreakdown[] = [
    await scoreStructuredData(adapters, data, cartridge.defaultConfig),
    await scoreAdapterCoverage(adapters, data),
    scoreMcpTools(cartridge),
    await scoreLlmsTxt(adapters, data, cartridge.defaultConfig),
    await scoreClassicCrawler(adapters, data, cartridge.defaultConfig),
  ];

  const total = Math.round(
    breakdown.reduce((acc, item) => acc + (item.score * item.weight) / 100, 0),
  );

  return { total, breakdown };
}

// ─────────────────────────── per-input scorers ───────────────────────

async function scoreStructuredData<TData, TConfig>(
  adapters: PublicationAdapter<TData, unknown, TConfig>[],
  data: TData,
  config: TConfig,
): Promise<ScoreInputBreakdown> {
  const ctx = { ...SCORE_CONTEXT, config } as PublicationContext<TConfig>;
  const jsonLd = adapters.find((a) => a.format === 'json-ld');
  if (!jsonLd) {
    return {
      id: 'structured-data',
      label: 'Structured data',
      score: 0,
      weight: 20,
      hint: 'Add a PublicationAdapter with format: \'json-ld\' (e.g. Schema.org).',
    };
  }
  const valid = await safeValidate(jsonLd, data, ctx);
  if (!valid.valid) {
    return {
      id: 'structured-data',
      label: 'Structured data',
      score: 50,
      weight: 20,
      hint: `JSON-LD adapter present, validation failing: ${describeErrors(valid)}`,
    };
  }
  return {
    id: 'structured-data',
    label: 'Structured data',
    score: 100,
    weight: 20,
    hint: 'Schema.org JSON-LD valid. Adopters: Google AI Overviews, Perplexity, Schema.org-aware indexers.',
  };
}

async function scoreAdapterCoverage<TData, TConfig>(
  adapters: PublicationAdapter<TData, unknown, TConfig>[],
  data: TData,
): Promise<ScoreInputBreakdown> {
  if (adapters.length === 0) {
    return {
      id: 'adapter-coverage',
      label: 'Adapter coverage',
      score: 0,
      weight: 20,
      hint: 'No PublicationAdapters declared. Author at least one (json-ld, llms.txt, crawler-bundle).',
    };
  }
  const required = adapters.flatMap((a) => a.requires ?? []);
  if (required.length === 0) {
    // No required fields at all — defensible 100% but flag in hint.
    return {
      id: 'adapter-coverage',
      label: 'Adapter coverage',
      score: 100,
      weight: 20,
      hint: 'No required fields declared by any adapter. Add `requires` paths to surface missing coverage.',
    };
  }
  const populated = required.filter((ref) => isFieldPopulated(data, ref.path));
  const ratio = populated.length / required.length;
  const score = Math.round(ratio * 100);
  const missing = required.length - populated.length;
  return {
    id: 'adapter-coverage',
    label: 'Adapter coverage',
    score,
    weight: 20,
    hint:
      missing === 0
        ? `All ${required.length} required adapter fields populated.`
        : `${missing} of ${required.length} required field path(s) missing.`,
  };
}

function scoreMcpTools<TData, TConfig>(cartridge: Cartridge<TData, TConfig>): ScoreInputBreakdown {
  const count = cartridge.mcpTools?.length ?? 0;
  if (count === 0) {
    return {
      id: 'mcp-tools',
      label: 'MCP tools',
      score: 0,
      weight: 20,
      hint: 'No MCP tools declared. Add at least one read-only tool so agents can query this cartridge.',
    };
  }
  // 100 at >= 2 tools, 60 at 1.
  const score = count >= 2 ? 100 : 60;
  return {
    id: 'mcp-tools',
    label: 'MCP tools',
    score,
    weight: 20,
    hint:
      count === 1
        ? '1 MCP tool. Add a second to cover both list and detail queries (60 → 100 at 2+).'
        : `${count} MCP tools available to agents.`,
  };
}

async function scoreLlmsTxt<TData, TConfig>(
  adapters: PublicationAdapter<TData, unknown, TConfig>[],
  data: TData,
  config: TConfig,
): Promise<ScoreInputBreakdown> {
  const ctx = { ...SCORE_CONTEXT, config } as PublicationContext<TConfig>;
  const adapter = adapters.find(
    (a) => a.id.includes('llms') || a.displayName.toLowerCase().includes('llms.txt'),
  );
  if (!adapter) {
    return {
      id: 'llms-txt',
      label: 'llms.txt',
      score: 0,
      weight: 20,
      hint: 'No llms.txt adapter declared. Add a PublicationAdapter that emits an llms.txt fragment.',
    };
  }
  const valid = await safeValidate(adapter, data, ctx);
  return valid.valid
    ? {
        id: 'llms-txt',
        label: 'llms.txt',
        score: 100,
        weight: 20,
        hint: 'llms.txt fragment present and valid.',
      }
    : {
        id: 'llms-txt',
        label: 'llms.txt',
        score: 50,
        weight: 20,
        hint: `llms.txt adapter present, validation failing: ${describeErrors(valid)}`,
      };
}

async function scoreClassicCrawler<TData, TConfig>(
  adapters: PublicationAdapter<TData, unknown, TConfig>[],
  data: TData,
  config: TConfig,
): Promise<ScoreInputBreakdown> {
  const ctx = { ...SCORE_CONTEXT, config } as PublicationContext<TConfig>;
  const adapter = adapters.find(
    (a) =>
      a.id.includes('crawler') ||
      a.displayName.toLowerCase().includes('crawler') ||
      a.displayName.toLowerCase().includes('canonical'),
  );
  if (!adapter) {
    return {
      id: 'classic-crawler',
      label: 'Classic crawler',
      score: 0,
      weight: 20,
      hint: 'No crawler-surface adapter (canonical / sitemap / OG / Twitter Card).',
    };
  }
  const valid = await safeValidate(adapter, data, ctx);
  return valid.valid
    ? {
        id: 'classic-crawler',
        label: 'Classic crawler',
        score: 100,
        weight: 20,
        hint: 'Canonical, sitemap, OpenGraph, and Twitter Card surfaces all valid.',
      }
    : {
        id: 'classic-crawler',
        label: 'Classic crawler',
        score: 50,
        weight: 20,
        hint: `Crawler adapter present, validation failing: ${describeErrors(valid)}`,
      };
}

// ─────────────────────────── helpers ─────────────────────────────────

async function safeValidate<TData, TConfig>(
  adapter: PublicationAdapter<TData, unknown, TConfig>,
  data: TData,
  ctx: PublicationContext<TConfig>,
): Promise<ValidationResult> {
  try {
    const out = await adapter.generate(data, ctx);
    return adapter.validate(out);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, errors: [{ code: 'generate-threw', message }], warnings: [] };
  }
}

function describeErrors(v: ValidationResult): string {
  if (v.errors.length === 0) return 'no error detail';
  const first = v.errors[0];
  if (!first) return 'no error detail';
  const tail = v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : '';
  return `${first.code}${first.path ? ` @ ${first.path}` : ''}${tail}`;
}

/**
 * Whether the dotted path is populated in `data`. Treats empty string,
 * empty array, and null/undefined as not populated. Handles arrays in
 * the path by checking that EVERY element has the trailing path populated
 * (e.g. 'sections.html' = "every section has html").
 */
export function isFieldPopulated(data: unknown, path: SchemaFieldRef['path']): boolean {
  return walk(data, path.split('.'));
}

function walk(value: unknown, parts: string[]): boolean {
  if (parts.length === 0) {
    return isPopulated(value);
  }
  if (value == null) return false;
  const [head, ...rest] = parts;
  if (head === undefined) return isPopulated(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    // Treat the next segment as "for every element". If parts continues,
    // require every element to have it.
    return value.every((el) => walk(el, parts));
  }
  if (typeof value === 'object') {
    return walk((value as Record<string, unknown>)[head], rest);
  }
  return false;
}

function isPopulated(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
