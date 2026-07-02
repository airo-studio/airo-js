/**
 * WordPress REST API client — fetches a single post by slug, with
 * embedded author + featured media + terms in one round trip via
 * `?_embed=true`.
 *
 * Spec: https://developer.wordpress.org/rest-api/reference/posts/
 *
 * Works against:
 *   - Self-hosted WP (any site with REST API enabled — default since 4.7)
 *   - WordPress.com sites (also serves `/wp-json/wp/v2/...`)
 *
 * Public posts don't require auth. Read-only.
 */

export interface RawAuthor {
  name: string;
  url?: string;
  link?: string;
}

export interface RawFeaturedMedia {
  source_url: string;
  alt_text?: string;
}

export interface RawTerm {
  name: string;
  taxonomy: string;
}

export interface RawPost {
  id: number;
  slug: string;
  link: string;
  date_gmt: string;
  modified_gmt: string;
  title: { rendered: string };
  excerpt: { rendered: string };
  content: { rendered: string };
  _embedded?: {
    author?: RawAuthor[];
    'wp:featuredmedia'?: RawFeaturedMedia[];
    'wp:term'?: RawTerm[][];
  };
}

export interface FetchPostOptions {
  site: string;
  postSlug?: string;
  signal?: AbortSignal;
}

export interface FetchPostResult extends RawPost {
  siteHost: string;
}

export async function fetchWpPost(opts: FetchPostOptions): Promise<FetchPostResult> {
  // Same defensive normalization as the Shopify client — accept scheme,
  // trailing slash, or full URL.
  const host = opts.site
    .replace(/^https?:\/\//, '')
    .replace(/[/?].*$/, '');

  // Treat trailing path segments after the host as part of the site
  // (e.g. 'wordpress.org/news' uses /news as a sub-path for the REST
  // API: 'https://wordpress.org/news/wp-json/wp/v2/posts').
  const subPath = opts.site
    .replace(/^https?:\/\//, '')
    .replace(/^[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');

  const base = `https://${host}${subPath}/wp-json/wp/v2/posts`;
  const url = opts.postSlug
    ? `${base}?slug=${encodeURIComponent(opts.postSlug)}&_embed=true`
    : `${base}?per_page=1&_embed=true`;

  console.log('[wp] GET', url);

  const res = await fetch(url, {
    signal: opts.signal,
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    const body = await res.text();
    console.log('[wp] response', res.status, res.statusText,
      'content-type=', res.headers.get('content-type'),
      'body-first-300=', body.slice(0, 300));
    throw new Error(`WordPress REST API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }

  const posts = (await res.json()) as RawPost[];
  const first = Array.isArray(posts) ? posts[0] : undefined;
  if (!first) {
    throw new Error(
      `WordPress post not found: site=${host}${subPath} slug="${opts.postSlug ?? '(latest)'}"`,
    );
  }
  return { ...first, siteHost: `${host}${subPath}` };
}
