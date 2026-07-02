/**
 * Shared types for the WordPress blog-post cartridge.
 *
 *   - `PostSnapshot`  — post-Transformer data; consumed by view + JSON-LD
 *                       adapter + MCP tools. Carries `snapshotId` (v0
 *                       placeholder for framework Ask 2).
 *   - `WpConfig`      — cartridge configuration (site, post slug, locale).
 *   - `PostJsonLd`    — Schema.org BlogPosting output for inline embedding.
 */

export interface WpConfig {
  /** Hostname of the WordPress site (e.g. 'wordpress.org/news'). Scheme is optional; the client strips it. */
  site: string;
  /** Post slug to render. Empty string falls back to "latest post" (per_page=1). */
  postSlug: string;
  /** BCP-47 locale tag. */
  locale: string;
}

export interface PostSnapshot {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  link: string;
  publishedAt: string;
  modifiedAt: string;
  author: { name: string; url?: string };
  featuredImageUrl: string | null;
  categories: string[];
  tags: string[];
  siteName: string;
  siteUrl: string;
  snapshotId: string;
}

export interface PostJsonLd {
  '@context': 'https://schema.org';
  '@type': 'BlogPosting';
  '@id'?: string;
  headline: string;
  description: string;
  image?: string[];
  datePublished: string;
  dateModified: string;
  author: { '@type': 'Person'; name: string; url?: string };
  publisher: { '@type': 'Organization'; name: string; url?: string };
  url: string;
  articleSection?: string[];
  keywords?: string[];
  'airo:snapshotId'?: string;
}
