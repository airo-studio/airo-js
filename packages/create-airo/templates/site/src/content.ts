/**
 * Your content. Stands in for a CMS, a folder of markdown, or a database —
 * replace it with yours.
 *
 * This module has no framework imports on purpose: it keeps the seam between
 * "where content lives" and "how it renders" visible. Sections arrive already
 * structured, so the cartridge never parses markdown; which parser you use is
 * your choice, made here.
 */

export type HeadingDepth = 2 | 3 | 4;

export interface Section {
  /** Anchor id. Left empty here: the `anchor-ids` transformer fills it in. */
  id: string;
  depth: HeadingDepth;
  title: string;
  /** Trusted HTML you authored. It is inserted as-is, never escaped. */
  html: string;
}

export interface Post {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  /** ISO date. An empty string keeps the post off search engines — see below. */
  updatedAt: string;
  sections: Section[];
}

export interface Site {
  name: string;
  /**
   * Your absolute origin, with no trailing slash. Canonical urls, the sitemap
   * and the agent tools all build links from it, so set it to where the site
   * really lives before you deploy.
   */
  url: string;
  tagline: string;
}

export const SITE: Site = {
  name: '__DISPLAY_NAME__',
  url: 'https://example.com',
  tagline: 'Server-rendered pages that hydrate, with search and agent surfaces from the same data.',
};

/**
 * The third post has an empty `updatedAt`, deliberately. The crawler adapter
 * refuses to publish a page that cannot say when it last changed, so that one
 * url answers 404 and stays out of the sitemap while the others publish
 * normally. That is the publish gate working per page, not per site. Delete
 * the post once you have seen it.
 */
export const POSTS: Post[] = [
  {
    slug: 'hello',
    title: 'Hello',
    description: 'What this starter gives you, and where to change it.',
    publishedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    sections: [
      {
        id: '',
        depth: 2,
        title: 'One snapshot, every audience',
        html: '<p>This page, its search-engine metadata and the answer an agent gets from <code>/mcp/call</code> are all built from the same data. They cannot disagree, because there is only one copy to disagree with.</p>',
      },
      {
        id: '',
        depth: 2,
        title: 'Where to start',
        html: '<p>Content lives in <code>src/content.ts</code>. How it looks lives in <code>src/cartridge.ts</code>. The server in <code>src/server.ts</code> is ordinary Express.</p>',
      },
    ],
  },
  {
    slug: 'server-first',
    title: 'Server first',
    description: 'Every page is rendered on the server, then the browser takes over without repainting.',
    publishedAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-03T09:00:00.000Z',
    sections: [
      {
        id: '',
        depth: 2,
        title: 'Hydration, not a second render',
        html: '<p>The browser adopts the markup the server sent and attaches listeners to it. Nothing is thrown away and drawn again.</p>',
      },
    ],
  },
  {
    slug: 'unfinished',
    title: 'An unfinished post',
    description: 'Started, not finished, and kept off search engines until it is.',
    publishedAt: '2026-09-04T09:00:00.000Z',
    updatedAt: '', // ← no date, so this post is not published. See above.
    sections: [{ id: '', depth: 2, title: 'Todo', html: '<p>Nothing here yet.</p>' }],
  },
];

export function findPost(slug: string): Post | undefined {
  return POSTS.find((p) => p.slug === slug);
}
