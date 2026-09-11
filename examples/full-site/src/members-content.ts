/**
 * Content for one signed-in visitor — SERVER-ONLY.
 *
 * Lives in its own module so it is never in the client bundle's module
 * graph: `cartridge.ts` (which esbuild bundles into `client.js`) imports
 * `content.ts` for the public docs, and until 0.11.0 the member notes sat
 * beside them, kept out of the bundle only by dead-code elimination — one
 * reachable reference away from shipping every note to every anonymous
 * visitor. Now nothing the client imports can reach this file, and the
 * smoke asserts `/client.js` carries no note.
 *
 * Only `memberSliceFor` in `server.ts` reads `MEMBER_NOTES`, and only for a
 * private page with a verified session. `DEMO_USER` is the one account the
 * demo identity provider knows.
 */

import type { Doc, MemberUser } from './content.js';

/** The demo provider knows exactly one account: `demo` / `demo`. */
export const DEMO_USER: MemberUser = { id: 'u_demo', name: 'Demo Member' };

export const MEMBER_NOTES: Doc[] = [
  {
    slug: 'roadmap',
    title: 'What ships next',
    description: 'The three lines after 1.0, in the order the consumers asked for them.',
    publishedAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-09T09:00:00.000Z',
    tags: ['members', 'roadmap'],
    sections: [
      {
        id: '',
        depth: 2,
        title: 'The freeze',
        html: '<p>1.0 freezes the surface. Everything below it is additive by construction.</p>',
      },
      {
        id: '',
        depth: 2,
        title: 'After the freeze',
        html: '<p>A gate-chunking hook once the precheck ratio justifies it; a studio config shape for gate instances; a second example that shares the demo identity provider.</p>',
      },
    ],
  },
  {
    slug: 'release-checklist',
    title: 'The release checklist',
    description: 'What gets checked before a line is cut, and who checks it.',
    publishedAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-09-05T09:00:00.000Z',
    tags: ['members', 'process'],
    sections: [
      {
        id: '',
        depth: 2,
        title: 'Before the cut',
        html: '<p>Every consumer report has a framework response. The publish preflight is green. Both consumers have run their suites against the branch.</p>',
      },
    ],
  },
];

export function findNote(slug: string): Doc | undefined {
  return MEMBER_NOTES.find((d) => d.slug === slug);
}
