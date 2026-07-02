/**
 * PublicationAdapter — Schema.org BlogPosting JSON-LD, inline-in-host.
 *
 * Same pattern as the Shopify product adapter: post-Transformer snapshot
 * → Schema.org structured data → inlined in HTML head before widget
 * markup. Google's Top Stories carousel + AI Overviews + Search News
 * card all read this.
 */

import type { PublicationAdapter, SchemaFieldRef } from '@airo-js/cartridge-kit';

import type { PostJsonLd, PostSnapshot, WpConfig } from './types.js';
import { toArticleJsonLd } from './jsonld.js';

const REQUIRES: SchemaFieldRef[] = [
  { path: 'id', required: 'always' },
  { path: 'title', required: 'always' },
  { path: 'excerpt', required: 'preferred' },
  { path: 'publishedAt', required: 'always' },
  { path: 'author.name', required: 'always' },
  { path: 'siteName', required: 'always' },
  { path: 'link', required: 'always' },
  { path: 'featuredImageUrl', required: 'preferred' },
  { path: 'categories', required: 'optional' },
  { path: 'tags', required: 'optional' },
];

function validate(output: PostJsonLd): {
  valid: boolean;
  errors: { code: string; path?: string; message: string; remediation?: string }[];
  warnings: { code: string; path?: string; message: string }[];
  coverage?: { covered: number; total: number };
} {
  const errors: { code: string; path?: string; message: string; remediation?: string }[] = [];
  const warnings: { code: string; path?: string; message: string }[] = [];

  if (!output.headline) {
    errors.push({ code: 'missing-headline', path: 'headline', message: 'Article must have a headline' });
  }
  if (!output.author?.name) {
    errors.push({ code: 'missing-author', path: 'author.name', message: 'Article must declare an author' });
  }
  if (!output.url) {
    errors.push({ code: 'missing-url', path: 'url', message: 'Article must have a canonical url' });
  }
  if (!output.datePublished) {
    errors.push({ code: 'missing-date', path: 'datePublished', message: 'Article must have a publish date' });
  }
  if (!output.image || output.image.length === 0) {
    warnings.push({
      code: 'no-images',
      path: 'image',
      message: 'Article has no featured image — Top Stories carousels typically require one',
    });
  }
  if (!output.description || output.description.length < 30) {
    warnings.push({
      code: 'short-description',
      path: 'description',
      message: 'Article excerpt is short — Google prefers >=30 chars',
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    coverage: {
      covered: REQUIRES.filter((r) => r.required !== 'optional').length,
      total: REQUIRES.length,
    },
  };
}

export const postJsonLdAdapter: PublicationAdapter<PostSnapshot, PostJsonLd, WpConfig> = {
  id: 'post-json-ld',
  displayName: 'BlogPosting JSON-LD',
  description:
    'Emits Schema.org BlogPosting JSON-LD for inline embedding. Indexable by Google Top Stories + AI Overviews; agent-readable via the same post snapshot the human view + /wp/mcp tools see.',
  format: 'json-ld',
  delivery: 'inline-in-host',
  requires: REQUIRES,
  refreshCadence: {
    min: { ms: 0 },
    max: { ms: 6 * 60 * 60 * 1000 },
  },
  onValidationFail: 'block-publish',

  async generate(snapshot, _ctx) {
    return toArticleJsonLd(snapshot);
  },

  validate(output) {
    return validate(output);
  },
};
