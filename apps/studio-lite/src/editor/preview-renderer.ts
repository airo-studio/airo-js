/**
 * Preview rendering helpers — pure functions that produce the three preview
 * outputs <studio-preview-triple> displays. Browser-only (require `document`).
 *
 * Three preview surfaces, three readers of the same post-Transformer
 * snapshot:
 *   - human       cartridge view, rendered into an isolated iframe via srcdoc
 *   - seo-aio     cartridge's first json-ld PublicationAdapter, rendered as
 *                 a Google-AI-Overview-shaped snippet card
 *   - agent       MCP tool inventory + sample handler invocations against the
 *                 current snapshot (only tools with empty `required` array
 *                 are auto-invoked at slice 3c; the rest show schema only)
 */

import { EventBus, type RenderContext } from '@airo-js/core';
import type {
  Cartridge,
  CartridgeAppContext,
  McpToolDefinition,
  PublicationAdapter,
  PublicationContext,
  ToolContext,
} from '@airo-js/cartridge-kit';

export type RenderResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ───────────────────────── Human preview ─────────────────────────

export interface HumanPreviewOutput {
  /** Inner HTML produced by the cartridge's first view, ready to embed in an iframe. */
  html: string;
  /** The view id used to render. */
  viewId: string;
  /** The pageType the view is registered for. */
  pageType: string;
}

export function renderHumanPreview<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  data: TData,
): RenderResult<HumanPreviewOutput> {
  const view = cartridge.views[0];
  if (!view) return { ok: false, error: 'Cartridge has no views declared.' };
  try {
    const target = document.createElement('div');
    const renderer = view.factory();
    const ctx: RenderContext<string, CartridgeAppContext<TData, TConfig>> = {
      page: {
        id: 'preview',
        type: view.pageType,
        enabled: true,
        layout: { regionOrder: [], regions: {} },
      },
      app: {
        cartridgeId: cartridge.id,
        config: cartridge.defaultConfig,
        data,
      },
      events: new EventBus(),
      navState: { page: 'preview' },
      navigate: () => {
        /* preview pane is non-interactive */
      },
    };
    renderer.render(target, ctx);
    return {
      ok: true,
      value: { html: target.innerHTML, viewId: view.id, pageType: view.pageType },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Wrap a fragment in a minimal HTML shell suitable for `<iframe srcdoc>`. */
export function buildIframeSrcdoc(fragment: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    color: #0a0a0a;
    background: #ffffff;
    padding: 16px;
    line-height: 1.55;
  }
  pre, code { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { padding: 10px; background: #f6f8fa; border-radius: 6px; overflow-x: auto; }
  a { color: #2d70ff; }
  h1 { font-size: 24px; letter-spacing: -0.01em; margin: 0 0 8px; }
  h2, h3 { letter-spacing: -0.01em; }
</style>
</head>
<body>${fragment}</body>
</html>`;
}

// ───────────────────────── SEO-AIO snippet ───────────────────────

export interface SeoAioSnippet {
  /** Headline pulled from JSON-LD `headline` or `name`. */
  title: string;
  /** Description pulled from JSON-LD `description`. */
  description: string;
  /** URL pulled from JSON-LD `url`. */
  url: string;
  /** Author name, if present. */
  authorName?: string;
  /** Image URL, if present. */
  imageUrl?: string;
  /** Published or modified date — preferred dateModified > datePublished. */
  date?: string;
  /** Schema.org @type discriminator (e.g. 'TechArticle', 'Article', 'Product'). */
  schemaType?: string;
  /** The full raw JSON-LD object for inspection. */
  raw: Record<string, unknown>;
}

export async function renderSeoAioSnippet<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  data: TData,
): Promise<RenderResult<SeoAioSnippet>> {
  const adapters = (cartridge.publicationAdapters ?? []) as PublicationAdapter<
    TData,
    unknown,
    TConfig
  >[];
  const adapter = adapters.find((a) => a.format === 'json-ld');
  if (!adapter) return { ok: false, error: 'No json-ld PublicationAdapter declared.' };

  try {
    const ctx: PublicationContext<TConfig> = {
      config: cartridge.defaultConfig,
      locale: 'en',
      country: 'US',
    };
    const out = (await adapter.generate(data, ctx)) as Record<string, unknown>;
    const snippet: SeoAioSnippet = {
      title: pickString(out, 'headline') ?? pickString(out, 'name') ?? '(untitled)',
      description: pickString(out, 'description') ?? '',
      url: pickString(out, 'url') ?? '',
      raw: out,
    };
    const author = out['author'];
    if (author && typeof author === 'object') {
      const name = (author as Record<string, unknown>)['name'];
      if (typeof name === 'string') snippet.authorName = name;
    }
    const image = out['image'];
    if (typeof image === 'string') snippet.imageUrl = image;
    snippet.date = pickString(out, 'dateModified') ?? pickString(out, 'datePublished');
    const type = out['@type'];
    if (typeof type === 'string') snippet.schemaType = type;
    return { ok: true, value: snippet };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

// ───────────────────────── Agent preview ─────────────────────────

export interface AgentToolPreview {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Set when the tool was auto-invoked (no required input) and succeeded. */
  sampleOutput?: unknown;
  /** Set when the tool was invoked but threw; or skipped because required input wasn't auto-derivable. */
  note?: string;
}

export async function renderAgentPreview<TData, TConfig>(
  cartridge: Cartridge<TData, TConfig>,
  data: TData,
): Promise<AgentToolPreview[]> {
  const tools = (cartridge.mcpTools ?? []) as McpToolDefinition<TData, TConfig>[];
  const ctx: ToolContext<TData, TConfig> = {
    data,
    config: cartridge.defaultConfig,
    schema: cartridge.schema,
    locale: 'en',
  };
  return Promise.all(tools.map((tool) => previewTool(tool, ctx)));
}

async function previewTool<TData, TConfig>(
  tool: McpToolDefinition<TData, TConfig>,
  ctx: ToolContext<TData, TConfig>,
): Promise<AgentToolPreview> {
  const required = (tool.inputSchema as { required?: string[] })?.required ?? [];
  if (required.length > 0) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      note: `Skipped auto-invocation — required input fields: ${required.join(', ')}`,
    };
  }
  try {
    const out = await tool.handler({}, ctx);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      sampleOutput: out,
    };
  } catch (e) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      note: `Handler threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
