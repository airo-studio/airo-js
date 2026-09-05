// @vitest-environment node
/**
 * parseHtml / parseHtmlFragment — the env-agnostic seam.
 *
 * best-practices §5.3 documents these at length and steers cartridge authors
 * to pass `host.ownerDocument`. Until 1.0 they had no test and no consumer
 * anywhere in the repo — a documented public primitive nobody had exercised.
 *
 * This file runs in `node` ON PURPOSE. Under happy-dom a global `document`
 * exists, so every call would silently take the fallback branch and the
 * explicit-document path — the one the docs actually recommend — would never
 * be proven. Here there is no global, so passing a document is the only thing
 * that works, and the "no Document available" throw is reachable.
 */

import { Window } from 'happy-dom';
import { afterEach, describe, expect, test } from 'vitest';

import { parseHtml, parseHtmlFragment } from '../src/parse-html.js';

function freshDocument(): Document {
  return new Window().document as unknown as Document;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('parseHtml', () => {
  test('parses a single root and returns the element', () => {
    const node = parseHtml('<div class="x">hi</div>', freshDocument()) as HTMLElement;

    expect(node.nodeType).toBe(1);
    expect(node.tagName).toBe('DIV');
    expect(node.className).toBe('x');
    expect(node.textContent).toBe('hi');
  });

  test('returns the FIRST child when the input has several roots', () => {
    const node = parseHtml('<i>a</i><b>b</b>', freshDocument()) as HTMLElement;
    expect(node.tagName).toBe('I');
  });

  test('returns an empty Text node for empty input, so callers can append blind', () => {
    const node = parseHtml('', freshDocument());
    expect(node.nodeType).toBe(3);
    expect(node.textContent).toBe('');
  });

  test('nested structure survives intact', () => {
    const node = parseHtml(
      '<ul><li data-id="1">one</li><li data-id="2">two</li></ul>',
      freshDocument(),
    ) as HTMLElement;

    expect(node.children).toHaveLength(2);
    expect(node.children[1]!.getAttribute('data-id')).toBe('2');
  });

  test('creates nodes in the document it was GIVEN, not some ambient one', () => {
    // This is the whole point of the seam: rendering across frames, windows
    // or a server-side DOM must land in the right document.
    const doc = freshDocument();
    const node = parseHtml('<p>x</p>', doc);
    expect(node.ownerDocument).toBe(doc);
  });

  test('two documents stay isolated', () => {
    const a = freshDocument();
    const b = freshDocument();
    expect(parseHtml('<p>a</p>', a).ownerDocument).not.toBe(
      parseHtml('<p>b</p>', b).ownerDocument,
    );
  });

  describe('document resolution', () => {
    test('falls back to globalThis.document when no doc is passed', () => {
      (globalThis as { document?: unknown }).document = freshDocument();
      const node = parseHtml('<p>global</p>') as HTMLElement;
      expect(node.tagName).toBe('P');
    });

    test('an explicit doc WINS over globalThis.document', () => {
      const globalDoc = freshDocument();
      const explicit = freshDocument();
      (globalThis as { document?: unknown }).document = globalDoc;

      expect(parseHtml('<p>x</p>', explicit).ownerDocument).toBe(explicit);
    });

    test('throws a named, actionable error when neither is available', () => {
      expect(() => parseHtml('<p>x</p>')).toThrow(/\[@airo-js\/core\] parseHtml/);
      expect(() => parseHtml('<p>x</p>')).toThrow(/host\.ownerDocument/);
    });

    test('the error names the helper that failed', () => {
      // Both helpers share resolveDocument; the message must still identify
      // which one the caller invoked.
      expect(() => parseHtmlFragment('<p>x</p>')).toThrow(/parseHtmlFragment/);
      expect(() => parseHtmlFragment('<p>x</p>')).not.toThrow(/parseHtml:/);
    });
  });

  describe('a <script> element is inert markup — and that is ALL this guarantees', () => {
    test('a <script> in the input does not run', () => {
      const doc = freshDocument();
      (globalThis as { __pwned?: boolean }).__pwned = false;

      const node = parseHtml('<div><script>globalThis.__pwned = true;</script></div>', doc);

      expect((globalThis as { __pwned?: boolean }).__pwned).toBe(false);
      expect((node as HTMLElement).querySelector('script')).not.toBeNull();
      delete (globalThis as { __pwned?: boolean }).__pwned;
    });

    test('event-handler attributes SURVIVE — parseHtml is not a sanitiser', () => {
      // Pinned deliberately as a negative. The `<script>` case above is easy
      // to over-read as "parseHtml makes untrusted HTML safe", and it does
      // not: these attributes come through intact and a real browser fires
      // them the moment the node is appended to a live document. Untrusted
      // feed HTML must be sanitised BEFORE it reaches this function.
      const doc = freshDocument();
      const node = parseHtml('<img src="x" onerror="globalThis.__x=1">', doc) as HTMLElement;

      expect(node.getAttribute('onerror')).toBe('globalThis.__x=1');
    });

    test('a javascript: URL survives untouched', () => {
      const doc = freshDocument();
      const node = parseHtml('<a href="javascript:alert(1)">x</a>', doc) as HTMLElement;

      expect(node.getAttribute('href')).toBe('javascript:alert(1)');
    });
  });
});

describe('parseHtmlFragment', () => {
  test('returns a DocumentFragment holding every root', () => {
    const frag = parseHtmlFragment('<li>a</li><li>b</li><li>c</li>', freshDocument());

    expect(frag.nodeType).toBe(11);
    expect(frag.childNodes).toHaveLength(3);
    expect(frag.textContent).toBe('abc');
  });

  test('handles a single root too', () => {
    const frag = parseHtmlFragment('<li>only</li>', freshDocument());
    expect(frag.childNodes).toHaveLength(1);
  });

  test('an empty fragment is empty, not null', () => {
    const frag = parseHtmlFragment('', freshDocument());
    expect(frag.nodeType).toBe(11);
    expect(frag.childNodes).toHaveLength(0);
  });

  test('appends all roots in one call — the reason it exists', () => {
    const doc = freshDocument();
    const host = doc.createElement('ul');
    host.appendChild(parseHtmlFragment('<li>a</li><li>b</li>', doc));

    expect(host.children).toHaveLength(2);
  });

  test('honours the explicit document', () => {
    const doc = freshDocument();
    expect(parseHtmlFragment('<li>x</li>', doc).ownerDocument).toBe(doc);
  });
});
