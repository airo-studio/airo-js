/**
 * Sample DocPageData fixture — the canonical "what is airo-js" page,
 * pre-structured so the studio-lite preview pane can render against
 * something meaningful from day one.
 *
 * Other doc-cartridge types (APIRef, Tutorial, Example, FAQ) bring their
 * own fixtures when they land.
 */

import type { DocPageData } from './doc-page.js';

export const sampleDocPageData: DocPageData = {
  slug: 'what-is-airo-js',
  title: 'What is airo-js?',
  description:
    'A vendor-neutral cartridge framework for AI Result Optimisation (AIO) — emit content for humans, search engines, and AI agents from one authoring action.',
  publishedAt: '2026-05-08T00:00:00.000Z',
  updatedAt: '2026-05-08T00:00:00.000Z',
  author: { name: 'AI/RO contributors' },
  tags: ['airo-js', 'aio', 'cartridge', 'framework'],
  ogImage: 'https://example.com/og/what-is-airo-js.png',

  headings: [
    { id: 'overview', depth: 2, title: 'Overview' },
    { id: 'three-audiences', depth: 2, title: 'Three audiences, one snapshot' },
    { id: 'cartridges', depth: 2, title: 'Cartridges' },
    { id: 'data-source', depth: 3, title: 'DataSource' },
    { id: 'transformer', depth: 3, title: 'Transformer' },
    { id: 'view-mcp-adapters', depth: 3, title: 'View, MCP tools, PublicationAdapters' },
    { id: 'install', depth: 2, title: 'Install' },
  ],

  sections: [
    {
      id: 'overview',
      depth: 2,
      title: 'Overview',
      html: '<p>airo-js is a rendering-only framework whose architecture <em>requires</em> multi-surface output. Every cartridge declares one schema and emits a Web view, a set of MCP tools, and Schema.org / vendor-feed PublicationAdapter outputs from the same post-Transformer snapshot. Author once, serve three audiences.</p>',
    },
    {
      id: 'three-audiences',
      depth: 2,
      title: 'Three audiences, one snapshot',
      html: '<p>SEO optimises content for search-crawler indexers. AIO (AI Result Optimisation) extends that idea to the surfaces an AI assistant queries when answering a user — Schema.org-backed AI Overviews, MCP tool calls, llms.txt fragments — alongside the classic crawler surface. The framework keeps these in lockstep by guaranteeing snapshot fidelity: the Web view, MCP tools, and adapters all consume the same post-Transformer data.</p>',
    },
    {
      id: 'cartridges',
      depth: 2,
      title: 'Cartridges',
      html: '<p>A cartridge is a self-contained bundle of: data schema, data sources, transformers, views, MCP tools, publication adapters, templates, and onboarding flow. Host apps consume cartridges via a registry — they never import cartridge code directly.</p>',
    },
    {
      id: 'data-source',
      depth: 3,
      title: 'DataSource',
      html: '<p>Async load surface. The cartridge declares one or more sources (URL, file, OAuth, custom); the host app renders the matching onboarding affordance from the discriminated <code>onboardingShape</code>.</p>',
    },
    {
      id: 'transformer',
      depth: 3,
      title: 'Transformer',
      html: '<p>Pure, sync, shape-preserving function from <code>TData</code> to <code>TData</code>. Transformers run in declared order before render. Async work belongs upstream in the DataSource.</p>',
    },
    {
      id: 'view-mcp-adapters',
      depth: 3,
      title: 'View, MCP tools, PublicationAdapters',
      html: '<p>Three readers, one source of truth. The View renders the post-Transformer snapshot to HTML. MCP tools answer agent queries against the same snapshot. PublicationAdapters fan the snapshot out to surface-specific outputs (Schema.org JSON-LD, llms.txt, vendor XML feeds) with coverage gating and validation as a hard publish gate.</p>',
    },
    {
      id: 'install',
      depth: 2,
      title: 'Install',
      html: '<pre><code class="language-bash">pnpm add @airo-js/core @airo-js/cartridge-kit</code></pre><p>Cartridge packages (e.g. <code>@airo-js-cartridges/doc-page</code>) layer on top of these primitives.</p>',
    },
  ],

  codeBlocks: [
    {
      language: 'bash',
      code: 'pnpm add @airo-js/core @airo-js/cartridge-kit',
      sectionId: 'install',
    },
  ],
};
