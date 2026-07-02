/**
 * Cartridge envelope — WordPress blog post.
 *
 * Companion to `src/shopify/cartridge.ts`. Same contract shape, different
 * data source (WP REST API) and different schema (BlogPosting instead of
 * Product). Demonstrates the airo-js framework's portability claim — the
 * same primitives compose against an entirely different backend.
 */

import type {
  Cartridge,
  DataSource,
  ViewDefinition,
  Template,
  SchemaDefinition,
} from '@airo-js/cartridge-kit';
import { defineSSRSafeRenderer } from '@airo-js/cartridge-kit';

import { postJsonLdAdapter } from './adapters.js';
import { POST_TOOLS } from './mcp.js';
import { fetchWpPost } from './client.js';
import { hashSnapshot } from '../snapshot-id.js';
import type { PostSnapshot, WpConfig } from './types.js';

const postSchema: SchemaDefinition<PostSnapshot> = {
  parse(input: unknown): PostSnapshot {
    return input as PostSnapshot;
  },
  safeParse(input: unknown) {
    return { success: true as const, data: input as PostSnapshot };
  },
};

export const wpPostDataSource: DataSource<PostSnapshot, WpConfig> = {
  id: 'wordpress-rest',
  displayName: 'WordPress REST API',
  onboardingShape: {
    kind: 'url-input',
    placeholder: 'https://your-wordpress-site.com',
  },
  cacheTtlMs: 0,

  async fetch(input, ctx): Promise<PostSnapshot> {
    const site = ctx.config.site;
    const postSlug = (input.kind === 'custom' && (input.payload as { slug?: string })?.slug)
      || ctx.config.postSlug;
    if (!site) {
      throw new Error('[wp-blog-post] Missing ctx.config.site');
    }

    const raw = await fetchWpPost({ site, postSlug, signal: ctx.signal });

    const featuredImageUrl = raw._embedded?.['wp:featuredmedia']?.[0]?.source_url ?? null;
    const author = raw._embedded?.author?.[0];
    const termGroups = raw._embedded?.['wp:term'] ?? [];
    const categories = (termGroups.find((arr) => arr[0]?.taxonomy === 'category') ?? [])
      .map((t) => t.name);
    const tags = (termGroups.find((arr) => arr[0]?.taxonomy === 'post_tag') ?? [])
      .map((t) => t.name);

    const snapshotMinusId = {
      id: raw.id,
      slug: raw.slug,
      title: stripHtml(raw.title.rendered),
      excerpt: stripHtml(raw.excerpt.rendered).trim(),
      content: stripHtml(raw.content.rendered),
      link: raw.link,
      publishedAt: ensureZulu(raw.date_gmt),
      modifiedAt: ensureZulu(raw.modified_gmt),
      author: {
        name: author?.name ?? 'Unknown',
        url: author?.url ?? author?.link,
      },
      featuredImageUrl,
      categories,
      tags,
      siteName: raw.siteHost,
      siteUrl: `https://${raw.siteHost}`,
    } satisfies Omit<PostSnapshot, 'snapshotId'>;

    const snapshotId = await hashSnapshot(snapshotMinusId);
    return { ...snapshotMinusId, snapshotId };
  },

  cacheKey(input) {
    if (input.kind === 'custom') {
      const slug = (input.payload as { slug?: string })?.slug ?? 'latest';
      return `wp-post:${slug}`;
    }
    return 'wp-post:latest';
  },
};

const postView: ViewDefinition<PostSnapshot, WpConfig> = {
  id: 'blog-post-card',
  displayName: 'Blog post card',
  pageType: 'post',
  capabilities: ['ssr-safe', 'hydratable'],
  factory: defineSSRSafeRenderer<
    'post',
    { cartridgeId: string; config: WpConfig; data: PostSnapshot }
  >({
    template(ctx) {
      const post = ctx.app.data;
      const heroSrc = post.featuredImageUrl ?? '';
      const dateStr = formatDate(post.publishedAt);
      const primaryCategory = post.categories[0];
      return `
        <article class="airo-blog-post" data-cartridge="wp-blog-post" data-snapshot-id="${escapeAttr(post.snapshotId)}">
          ${heroSrc ? `<img class="airo-blog-post__image" src="${escapeAttr(heroSrc)}" alt="${escapeAttr(post.title)}" loading="lazy" />` : ''}
          <div class="airo-blog-post__body">
            <p class="airo-blog-post__meta">
              <span class="airo-blog-post__site">${escapeHtml(post.siteName)}</span>${primaryCategory ? ` · <span class="airo-blog-post__category">${escapeHtml(primaryCategory)}</span>` : ''}${dateStr ? ` · <time datetime="${escapeAttr(post.publishedAt)}">${escapeHtml(dateStr)}</time>` : ''}
            </p>
            <h1 class="airo-blog-post__title">${escapeHtml(post.title)}</h1>
            ${post.author?.name ? `<p class="airo-blog-post__author">by ${escapeHtml(post.author.name)}</p>` : ''}
            <p class="airo-blog-post__excerpt">${escapeHtml(truncate(post.excerpt, 280))}</p>
            <a class="airo-blog-post__read" href="${escapeAttr(post.link)}" target="_blank" rel="noopener noreferrer">Read on ${escapeHtml(post.siteName)} →</a>
            <p class="airo-blog-post__snapshot">snapshot · <code>${escapeHtml(post.snapshotId)}</code></p>
          </div>
        </article>
      `.trim();
    },
    hydrate(_root, _ctx) {
      return undefined;
    },
  }),
};

const defaultConfig: WpConfig = {
  site: 'wordpress.org/news',
  postSlug: '',
  locale: 'en-US',
};

const defaultTemplate: Template<WpConfig> = {
  id: 'default',
  displayName: 'Default blog post layout',
  description: 'Single blog post page; uses the configured site + postSlug as the entry.',
  pages: [
    {
      id: 'post',
      type: 'post',
      enabled: true,
      layout: {
        regionOrder: ['main'],
        regions: { main: { id: 'main', components: [] } },
      },
    },
  ],
  defaultConfig,
};

export const wpPostCartridge: Cartridge<PostSnapshot, WpConfig> = {
  id: 'wp-blog-post',
  industry: 'content',
  displayName: 'WordPress blog post',
  description:
    'Edge-rendered blog-post card backed by the WordPress REST API. Emits human HTML, Schema.org BlogPosting JSON-LD, and an MCP tool manifest from one render snapshot.',
  version: '0.1.0',

  schema: postSchema,
  dataSources: [wpPostDataSource],
  views: [postView],
  templates: [defaultTemplate],
  publicationAdapters: [postJsonLdAdapter],
  mcpTools: POST_TOOLS,

  defaultConfig,
  defaultTemplateId: 'default',
  mailboxName: '__AIRO_WP_BLOG_POST_PAGES__',
};

// --- helpers ---

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureZulu(iso: string): string {
  return iso.endsWith('Z') ? iso : `${iso}Z`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
