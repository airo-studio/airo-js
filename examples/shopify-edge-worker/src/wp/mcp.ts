/**
 * MCP tool declarations for the WordPress blog-post cartridge.
 *
 * Declarations only — `@airo-js/mcp` supplies the manifest and the
 * dispatcher. This file and its Shopify sibling used to carry a private copy
 * of both, in one example, differing only in the types they closed over:
 * `buildToolManifest as buildWpManifest` next to `buildToolManifest as
 * buildShopifyManifest` in the worker's imports was the tell.
 *
 * Three tools, all answering from the same post-Transformer snapshot the
 * HTML + JSON-LD see. snapshotId stamped on every response so agents can
 * verify cross-surface consistency.
 */

import type { McpToolDefinition } from '@airo-js/cartridge-kit';
import type { PostSnapshot, WpConfig } from './types.js';

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

