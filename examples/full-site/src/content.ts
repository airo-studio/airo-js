/**
 * The content store — stands in for a CMS, a filesystem of markdown, or a
 * database. Deliberately a plain module with zero framework imports, so the
 * seam between "where content lives" and "how it renders" stays visible.
 *
 * The cartridge NEVER parses markdown. Sections arrive pre-structured, which
 * keeps `@airo-js/*` zero-dependency and puts the parser choice with the host
 * where it belongs.
 */

export type HeadingDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface DocSection {
  /** Slug-derived anchor id. Filled in by the transformer, not authored. */
  id: string;
  depth: HeadingDepth;
  title: string;
  /** HTML for the section body. Authored trusted; escaped at render only where interpolated. */
  html: string;
}

export interface Doc {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt: string;
  tags: string[];
  sections: DocSection[];
}

export interface Site {
  name: string;
  /** Absolute origin. Canonicals are composed from this — see the crawler adapter. */
  url: string;
  tagline: string;
}

export const SITE: Site = {
  name: 'Field Notes',
  url: 'https://field-notes.example',
  tagline: 'Short essays on building things that outlast their authors.',
};

/**
 * Note the third entry: `updatedAt` is empty. It is deliberately incomplete,
 * and it is what makes the publish gate observable — the crawler adapter's
 * `validate()` blocks it, so it 404s rather than reaching a crawler half-made,
 * while every other page publishes normally. Per page, not per feed.
 */
export const DOCS: Doc[] = [
  {
    slug: 'why-snapshots',
    title: 'Why one snapshot',
    description:
      'A rendered page, a JSON-LD block and an agent answer that disagree are three bugs wearing one coat.',
    publishedAt: '2026-01-04T09:00:00.000Z',
    updatedAt: '2026-02-11T09:00:00.000Z',
    tags: ['architecture', 'seo'],
    sections: [
      {
        id: '',
        depth: 2,
        title: 'The drift problem',
        html: '<p>Most sites derive their title three times: once for the heading, once for <code>&lt;title&gt;</code>, once for structured data. Each derivation is a chance to disagree, and nothing fails when they do.</p>',
      },
      {
        id: '',
        depth: 2,
        title: 'One derivation, many surfaces',
        html: '<p>If every surface reads the same post-transformer snapshot, drift stops being discouraged and starts being impossible. That is the whole trick, and it is mostly a discipline about where data is shaped.</p>',
      },
    ],
  },
  {
    slug: 'silent-failures',
    title: 'The failures that do not fail',
    description:
      'The expensive bugs are not the ones that throw. They are the ones where the wrong behaviour looks right in isolation.',
    publishedAt: '2026-03-02T09:00:00.000Z',
    updatedAt: '2026-03-19T09:00:00.000Z',
    tags: ['debugging'],
    sections: [
      {
        id: '',
        depth: 2,
        title: 'Nothing throws',
        html: '<p>A hook that never runs. A warning below the log threshold. A page that answers 200 under two urls. None of these raise anything, and every test passes.</p>',
      },
      {
        id: '',
        depth: 2,
        title: 'Make the silence loud',
        html: '<p>The fix is rarely cleverness. It is usually a discriminator on a result, or a warning at the moment a decision is made — something that turns an invisible state into a visible one.</p>',
      },
    ],
  },
  {
    slug: 'unfinished-draft',
    title: 'An unfinished note',
    description: 'Started, not finished — and deliberately so.',
    publishedAt: '2026-04-01T09:00:00.000Z',
    updatedAt: '', // ← blocks its own publish. See the note above.
    tags: [],
    sections: [
      { id: '', depth: 2, title: 'Todo', html: '<p>Nothing here yet.</p>' },
    ],
  },
];

export function findDoc(slug: string): Doc | undefined {
  return DOCS.find((d) => d.slug === slug);
}

// ─────────────────────────── the members area ───────────────────────────
//
// Only the TYPE lives here. The notes themselves and the demo account are in
// `members-content.ts`, which nothing the client bundle imports can reach —
// so no member byte is in `client.js` by construction, not by dead-code
// elimination.

export interface MemberUser {
  id: string;
  name: string;
}
