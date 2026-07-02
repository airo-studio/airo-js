/**
 * MCP tools for the WordPress blog-post cartridge.
 *
 * Mirrors the Shopify cartridge's mcp.ts in shape. Three tools, all
 * answering from the same post-Transformer snapshot the HTML + JSON-LD
 * see. snapshotId stamped on every response so agents can verify
 * cross-surface consistency.
 */

import type { McpToolDefinition } from '@airo-js/cartridge-kit';
import type { PostSnapshot, WpConfig } from './types.js';

export interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildToolManifest(
  tools: McpToolDefinition<PostSnapshot, WpConfig>[],
): { tools: McpToolManifestEntry[] } {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}

export const POST_TOOLS: McpToolDefinition<PostSnapshot, WpConfig>[] = [
  {
    name: 'getPost',
    description:
      'Return the full post snapshot — id, slug, title, excerpt, full content, author, dates, categories, tags, featured image. Same data the HTML page renders and the JSON-LD payload contains.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
      return ctx.data;
    },
  },
  {
    name: 'getExcerpt',
    description:
      'Return a short text excerpt suitable for previews. Strips HTML.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
      return {
        title: ctx.data.title,
        excerpt: ctx.data.excerpt,
        url: ctx.data.link,
      };
    },
  },
  {
    name: 'getPublishInfo',
    description: 'Return who published the post and when (ISO 8601).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(_input, ctx) {
      return {
        publishedAt: ctx.data.publishedAt,
        modifiedAt: ctx.data.modifiedAt,
        author: ctx.data.author.name,
        site: ctx.data.siteName,
        siteUrl: ctx.data.siteUrl,
      };
    },
  },
];

const POST_SCHEMA_STUB = {
  parse(input: unknown): PostSnapshot {
    return input as PostSnapshot;
  },
  safeParse(input: unknown) {
    return { success: true as const, data: input as PostSnapshot };
  },
};

export async function dispatchTool(
  toolName: string,
  input: unknown,
  ctx: { data: PostSnapshot; config: WpConfig },
): Promise<{ result: unknown; snapshotId: string }> {
  const tool = POST_TOOLS.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`Unknown WP MCP tool: ${toolName}`);
  }
  const result = await tool.handler(input, {
    data: ctx.data,
    config: ctx.config,
    schema: POST_SCHEMA_STUB,
  });
  return { result, snapshotId: ctx.data.snapshotId };
}
