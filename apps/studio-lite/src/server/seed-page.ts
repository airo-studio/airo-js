/**
 * Seed StudioPageData — what /api/state returns when no save has landed yet.
 *
 * Markdown body shape per studio-lite-editor.md: H2 sections, H3 subsections,
 * fenced code blocks. The H1 is implicit (the typed `title` field).
 */

import type { StudioPageData } from './page-shape.js';

export const seedPage: StudioPageData = {
  slug: 'what-is-airo-js',
  title: 'What is airo-js?',
  description:
    'A vendor-neutral cartridge framework for AI Result Optimisation (AIO). Emit content for humans, search engines, and AI agents from one authoring action.',
  publishedAt: '2026-05-08T00:00:00.000Z',
  updatedAt: '2026-05-08T00:00:00.000Z',
  author: 'AI/RO contributors',
  tags: ['airo-js', 'aio', 'cartridge', 'framework'],
  ogImage: 'https://example.com/og/what-is-airo-js.png',
  body: `## Overview

airo-js is a rendering-only framework whose architecture **requires** multi-surface output. Every cartridge declares one schema and emits a Web view, a set of MCP tools, and Schema.org / vendor-feed PublicationAdapter outputs from the same post-Transformer snapshot. Author once, serve three audiences.

## Three audiences, one snapshot

SEO optimises content for search-crawler indexers. AIO targets retrieval-augmented agent surfaces. Humans get the rendered View. The cartridge gives you all three from a single source of truth, validated as a hard publish gate.

### Schema.org for SEO

JSON-LD lets search-crawler indexers parse structured data about this page. The DocPage cartridge emits a \`TechArticle\` entity with author, dates, headline, and canonical URL.

### llms.txt for AIO

llms.txt is the emerging convention for telling AI agents what's here and how to read it. The DocPage cartridge emits a markdown fragment with the page summary and section anchors.

### MCP for Agents

MCP tools let agents query and act on your content with typed inputs and outputs.

## Install

\`\`\`bash
pnpm add @airo-js/core @airo-js/cartridge-kit
\`\`\`

Cartridge packages (e.g. \`@airo-js/doc-cartridges\`) layer on top of these primitives.
`,
};
