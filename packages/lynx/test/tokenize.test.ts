/**
 * The tokenizer is strict on purpose: it accepts what airo-js templates write
 * and refuses the rest. The table pins both halves; the conformance block
 * holds its trees equal to linkedom's (a browser-grade parser) on real pages,
 * so "strict" never means "different".
 */

import { readdirSync, readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { HtmlParseError, type ParsedNode, tokenize } from '../src/runtime/tokenize.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

/** A compact rendering: `div.a[x=1](text "hi", br)`. */
function show(nodes: ParsedNode[]): string {
  return nodes
    .map((n) =>
      n.kind === 'text'
        ? JSON.stringify(n.text)
        : `${n.tag}${n.attrs.length ? `[${n.attrs.map(([k, v]) => `${k}=${v}`).join(' ')}]` : ''}${n.children.length ? `(${show(n.children)})` : ''}`,
    )
    .join(', ');
}

describe('tokenize: what it accepts', () => {
  it.each([
    ['<p class="a">hi</p>', 'p[class=a]("hi")'],
    ['<P CLASS=a>x</P>', 'p[class=a]("x")'],
    ["<a href='/x' data-on>y</a>", 'a[href=/x data-on=]("y")'],
    ['<img src="a.png" alt=""><br><input value="1"/>', 'img[src=a.png alt=], br, input[value=1]'],
    ['a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#233; &#x1F600;', '"a & b <c> \\"d\\" \'e\' é 😀"'],
    ['a & b', '"a & b"'],
    ['<p title="a &amp; b">x</p>', 'p[title=a & b]("x")'],
    ['<!-- note --><p>x</p>', 'p("x")'],
    ['<script type="application/ld+json">{"a":"<b>"}</script>', 'script[type=application/ld+json]("{\\"a\\":\\"<b>\\"}")'],
    ['<textarea>a &amp; <b></textarea>', 'textarea("a & <b>")'],
    [
      '<svg viewBox="0 0 24 24" stroke="currentColor"><path d="M1 2"/><circle r="3"></circle></svg>',
      'svg[viewBox=0 0 24 24 stroke=currentColor](path[d=M1 2], circle[r=3])',
    ],
    ['<svg><linearGradient id="g"/></svg>', 'svg(linearGradient[id=g])'],
    ['  <p>x</p>\n', '"  ", p("x"), "\\n"'],
  ])('%s', (html, expected) => {
    expect(show(tokenize(html))).toBe(expected);
  });

  it('marks svg and its subtree foreign', () => {
    const [svg] = tokenize('<svg><path d="x"/></svg><p></p>') as [ParsedNode & { kind: 'element' }, ParsedNode & { kind: 'element' }];
    expect(svg.foreign).toBe(true);
    expect((svg.children[0] as { foreign: boolean }).foreign).toBe(true);
    expect((tokenize('<p></p>')[0] as { foreign: boolean }).foreign).toBe(false);
  });
});

describe('tokenize: what it refuses, by name and position', () => {
  it.each([
    ['a&nbsp;b', /"&nbsp;" is not one escapeHtml writes/],
    ['AT&T', /"&T" is not a complete character reference/],
    ['&#xZZ;', /not a valid numeric reference/],
    ['<div><p>x</div>', /<\/div> does not close the open <p>/],
    ['<ul><li>a<li>b</ul>', /<\/ul> does not close the open <li>/],
    ['<div>', /<div> is never closed/],
    ['</p>', /<\/p> has no open element/],
    ['<br></br>', /closes a void element/],
    ['<div/>', /self-closes a non-void HTML element/],
    ['a < b', /"<" that does not start a tag/],
    ['<!doctype html>', /doctype/],
    ['<p class="a" class="b">', /duplicate attribute "class"/],
    ['<p title="x>y</p>', /unclosed attribute value/],
    ['<script>x', /unclosed <script>/],
  ])('%s', (html, message) => {
    expect(() => tokenize(html)).toThrow(HtmlParseError);
    expect(() => tokenize(html)).toThrow(message);
  });

  it('reports line and column', () => {
    try {
      tokenize('<p>\n  ok &nbsp;</p>');
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ line: 2, column: 6 });
    }
  });
});

// ── conformance ──────────────────────────────────────────────────────────────

interface Plain {
  tag?: string;
  attrs?: string[];
  text?: string;
  children?: Plain[];
}

/**
 * `class` compared as its token list: linkedom trims the attribute value
 * (`class=" a"` reads back as `"a"`) where a browser keeps it verbatim, and
 * the token list is what both `classList` and the tree pass use.
 */
const attr = (name: string, value: string): string =>
  name.toLowerCase() === 'class' ? `class=${value.split(/\s+/).filter(Boolean).join(' ')}` : `${name.toLowerCase()}=${value}`;

function fromTokenizer(nodes: ParsedNode[]): Plain[] {
  return nodes.map((n) =>
    n.kind === 'text'
      ? { text: n.text }
      : { tag: n.tag.toLowerCase(), attrs: n.attrs.map(([k, v]) => attr(k, v)), children: fromTokenizer(n.children) },
  );
}

/** linkedom's tree under <body>, comments dropped, in the same shape. */
function fromLinkedom(html: string): Plain[] {
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const walk = (node: { childNodes: ArrayLike<unknown> }): Plain[] => {
    const out: Plain[] = [];
    for (const child of Array.from(node.childNodes) as {
      nodeType: number;
      localName: string;
      textContent: string;
      attributes: ArrayLike<{ name: string; value: string }>;
      childNodes: ArrayLike<unknown>;
    }[]) {
      if (child.nodeType === 3) out.push({ text: child.textContent });
      else if (child.nodeType === 1) {
        out.push({
          tag: child.localName.toLowerCase(),
          attrs: Array.from(child.attributes).map((a) => attr(a.name, a.value)),
          children: walk(child),
        });
      }
    }
    // Adjacent text nodes are one node in the tokenizer's tree.
    return out.reduce<Plain[]>((acc, n) => {
      const last = acc[acc.length - 1];
      if (n.text !== undefined && last?.text !== undefined) last.text += n.text;
      else acc.push(n);
      return acc;
    }, []);
  };
  return walk(document.body as unknown as { childNodes: ArrayLike<unknown> });
}

describe('tokenize: conformance with a browser-grade parser', () => {
  const pages = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));

  it('has fixture pages to compare', () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
  });

  it.each(pages)('%s parses to the same tree as linkedom', (page) => {
    const html = readFileSync(new URL(page, FIXTURES), 'utf8');
    expect(fromTokenizer(tokenize(html))).toEqual(fromLinkedom(html));
  });
});
