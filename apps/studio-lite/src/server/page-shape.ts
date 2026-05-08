/**
 * Studio's persisted page shape — the source of truth for editing.
 *
 * Per studio-lite-editor.md: the markdown body is canonical. Typed
 * metadata fields (title, description, slug, author, ogImage, tags,
 * dates) are columns; the H1 + lede in the rendered preview render from
 * `title` and `description`, NOT from the markdown body. The markdown
 * body starts at H2.
 *
 * The studio stores `StudioPageData` rows. The DocPage cartridge consumes
 * `DocPageData` (with structured headings/sections/codeBlocks). The
 * studio bridges between them via studioToDocPage(), parsing markdown
 * server-side via markdown-it.
 *
 * Slice 1: studio is single-cartridge / single-page. Slice 2 introduces
 * the multi-page `pages` table and renames StudioPageData rows to share
 * the same shape across cartridge types.
 */

import type { DocPageData } from '@airo-js/doc-cartridges';

import { parseMarkdownBody } from './markdown.js';

export interface StudioPageData {
  slug: string;
  title: string;
  description: string;

  /** ISO 8601. */
  publishedAt: string;
  /** ISO 8601. */
  updatedAt: string;

  /** Optional. Single string at v0; resolves to `{ name: author }` for the cartridge. */
  author?: string;
  ogImage?: string;
  /** Comma-separated v0; tags table v0.1. */
  tags?: string[];

  /** Markdown body — source of truth. */
  body: string;
}

export function isStudioPageData(v: unknown): v is StudioPageData {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.slug === 'string' &&
    typeof o.title === 'string' &&
    typeof o.description === 'string' &&
    typeof o.publishedAt === 'string' &&
    typeof o.updatedAt === 'string' &&
    typeof o.body === 'string'
  );
}

/**
 * Bridge: derive the cartridge-shaped DocPageData from the studio's row.
 * Parses markdown body once; returns a shape the DocPage cartridge accepts
 * unchanged.
 */
export function studioToDocPage(p: StudioPageData): DocPageData {
  const parsed = parseMarkdownBody(p.body);
  const out: DocPageData = {
    slug: p.slug,
    title: p.title,
    description: p.description,
    publishedAt: p.publishedAt,
    updatedAt: p.updatedAt,
    body: p.body,
    headings: parsed.headings,
    sections: parsed.sections,
    codeBlocks: parsed.codeBlocks,
  };
  if (p.author) out.author = { name: p.author };
  if (p.tags && p.tags.length > 0) out.tags = p.tags;
  if (p.ogImage) out.ogImage = p.ogImage;
  return out;
}
