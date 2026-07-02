/**
 * Schema.org BlogPosting JSON-LD mapper — pure function.
 *
 * Used by the post JSON-LD PublicationAdapter. BlogPosting is the right
 * subtype for blog/news content; Article is the parent type. Both are
 * indexed by Google for Top Stories carousels + AI Overviews.
 *
 * Spec reference: https://schema.org/BlogPosting
 */

import type { PostSnapshot, PostJsonLd } from './types.js';

export function toArticleJsonLd(post: PostSnapshot): PostJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': String(post.id),
    headline: post.title,
    description: post.excerpt,
    image: post.featuredImageUrl ? [post.featuredImageUrl] : undefined,
    datePublished: post.publishedAt,
    dateModified: post.modifiedAt,
    author: {
      '@type': 'Person',
      name: post.author.name,
      url: post.author.url,
    },
    publisher: {
      '@type': 'Organization',
      name: post.siteName,
      url: post.siteUrl,
    },
    url: post.link,
    articleSection: post.categories.length > 0 ? post.categories : undefined,
    keywords: post.tags.length > 0 ? post.tags : undefined,
    'airo:snapshotId': post.snapshotId,
  };
}
