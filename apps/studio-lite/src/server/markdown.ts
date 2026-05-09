/**
 * Markdown parsing for the studio's compose drawer.
 *
 * Per the design spec: the markdown body is the source of truth, but the
 * DocPage cartridge consumes structured `headings` / `sections` / `codeBlocks`.
 * This module parses the user's markdown body into both — server-side, so
 * the cartridge stays zero-dep (the markdown-it dep lives in studio-lite,
 * not in @airo-js/* packages).
 *
 * The structured derivation rules:
 *   - H2/H3/H4 lines become `headings` entries (depth = level).
 *   - The text between an H2/H3/H4 and the next sibling-or-shallower heading
 *     becomes a `section` whose `html` is the rendered HTML of that span,
 *     and whose `id` matches its parent heading.
 *   - Fenced code blocks become `codeBlocks` entries, attributed to the
 *     section they fall under by the most-recent-heading rule.
 *
 * H1 is NOT parsed from markdown — title comes from the typed metadata
 * field per the spec ("The markdown body starts at H2"). If a user pastes
 * an `# H1` line, we treat it as content (it gets rendered as such).
 */

import MarkdownIt from 'markdown-it';
import markdownItAnchor from 'markdown-it-anchor';

import type {
  DocPageCodeBlock,
  DocPageHeading,
  DocPageHeadingDepth,
  DocPageSection,
} from '@airo-js-cartridges/doc-page';

const md = new MarkdownIt({
  html: false, // user markdown can't inject raw HTML for v0
  linkify: true,
  typographer: true,
}).use(markdownItAnchor, {
  level: [2, 3, 4, 5, 6], // skip H1 — that's the typed title
  permalink: false, // anchors only; no permalink hash
  slugify: defaultSlugify,
});

export interface ParsedBody {
  headings: DocPageHeading[];
  sections: DocPageSection[];
  codeBlocks: DocPageCodeBlock[];
}

export function parseMarkdownBody(markdown: string): ParsedBody {
  const tokens = md.parse(markdown ?? '', {});
  const headings: DocPageHeading[] = [];
  const sections: DocPageSection[] = [];
  const codeBlocks: DocPageCodeBlock[] = [];

  // Walk tokens. Each heading_open/inline/heading_close triple marks a new
  // section boundary. Tokens between one heading_close and the next
  // heading_open belong to the active section.
  let activeSection:
    | { id: string; depth: DocPageHeadingDepth; title: string; tokens: typeof tokens }
    | null = null;

  function flushSection(): void {
    if (!activeSection) return;
    const html = md.renderer.render(activeSection.tokens, md.options, {});
    sections.push({
      id: activeSection.id,
      depth: activeSection.depth,
      title: activeSection.title,
      html: html.trim(),
    });
    activeSection = null;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok.type === 'heading_open' && /^h[2-6]$/.test(tok.tag)) {
      flushSection();
      const depthStr = tok.tag.slice(1);
      const depth = Number(depthStr) as DocPageHeadingDepth;
      const inline = tokens[i + 1];
      const titleText = inline?.type === 'inline' ? inline.content : '';
      const id =
        (tok.attrs?.find((a) => a[0] === 'id')?.[1] as string | undefined) ??
        defaultSlugify(titleText);
      headings.push({ id, depth, title: titleText });
      activeSection = { id, depth, title: titleText, tokens: [] };
      // Skip the inline + heading_close tokens — they belong to the heading,
      // not the section body. The renderer would otherwise re-emit the heading
      // markup inside the section html.
      const closeIdx = findIndex(
        tokens,
        (t) => t.type === 'heading_close' && t.tag === tok.tag,
        i + 1,
      );
      if (closeIdx !== -1) i = closeIdx;
      continue;
    }

    if (activeSection) {
      activeSection.tokens.push(tok);
      // Capture fenced code blocks while we're walking the section.
      if (tok.type === 'fence') {
        codeBlocks.push({
          language: tok.info.trim(),
          code: tok.content.replace(/\n$/, ''),
          sectionId: activeSection.id,
        });
      }
    } else if (tok.type === 'fence') {
      // Code block before any heading — attribute to a synthetic 'preamble' section id.
      codeBlocks.push({
        language: tok.info.trim(),
        code: tok.content.replace(/\n$/, ''),
        sectionId: 'preamble',
      });
    }
  }

  flushSection();

  return { headings, sections, codeBlocks };
}

/** Render the full body markdown to HTML — used by audience-Human stage in slice 4. */
export function renderMarkdownBodyHtml(markdown: string): string {
  return md.render(markdown ?? '');
}

function defaultSlugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function findIndex<T>(arr: T[], pred: (v: T) => boolean, from: number): number {
  for (let i = from; i < arr.length; i += 1) {
    const v = arr[i];
    if (v !== undefined && pred(v)) return i;
  }
  return -1;
}
