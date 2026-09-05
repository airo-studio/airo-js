/**
 * Tests for `@airo-js/core`'s escaping primitives. Lives in cartridge-kit's
 * test folder because cartridge-kit already has a vitest config (node env)
 * and these fns are pure — no DOM required. Same arrangement as
 * `nav-encoding.test.ts`; when core ships test infrastructure they move.
 *
 * Escaping is where head-metadata XSS actually lives.
 *
 * The pre-0.9 framework only ever emitted JSON-LD, which is data-only — so
 * framework code had never had to get ATTRIBUTE escaping right. From 0.9,
 * `renderDocument` interpolates snapshot-derived strings into
 * `content="…"`, `href="…"` and `<title>`. A snapshot field containing a
 * double quote followed by `onload=` is a live XSS on the host's own
 * origin, so these tests are the load-bearing ones.
 */

import { describe, expect, test } from 'vitest';

import { escapeAttr, escapeHtml } from '@airo-js/core';

describe('escapeHtml', () => {
  test('escapes all five characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  test('escapes ampersand FIRST so entities are not double-encoded', () => {
    // A naive sequential-replace that ran `<` before `&` would turn
    // '<' into '&lt;' and then into '&amp;lt;'.
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  test('leaves ordinary text untouched', () => {
    expect(escapeHtml('Plain title, 100% fine — dashes and ünïcode')).toBe(
      'Plain title, 100% fine — dashes and ünïcode',
    );
  });

  test('empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  test('is NOT idempotent — escape once, at interpolation', () => {
    expect(escapeHtml(escapeHtml('&'))).toBe('&amp;amp;');
  });

  test('neutralises a tag-injection payload', () => {
    expect(escapeHtml('</title><script>alert(1)</script>')).toBe(
      '&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  test('is stateless across calls — the shared global regex must not carry lastIndex', () => {
    // A `.test()` fast path against a /g regex would make the second call
    // start mid-string and silently skip characters.
    for (let i = 0; i < 5; i++) {
      expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
    }
  });

  test('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a&b&c')).toBe('a&amp;b&amp;c');
  });
});

describe('escapeAttr', () => {
  test('escapes quotes — the attribute-breakout characters', () => {
    expect(escapeAttr('"')).toBe('&quot;');
    expect(escapeAttr("'")).toBe('&#39;');
  });

  test('neutralises the canonical attribute-breakout XSS', () => {
    const out = escapeAttr('" onload="alert(1)');
    expect(out).not.toContain('"');
    expect(`<meta content="${out}">`).toBe(
      '<meta content="&quot; onload=&quot;alert(1)">',
    );
  });

  test('neutralises a single-quoted breakout too', () => {
    const out = escapeAttr("' onerror='alert(1)");
    expect(out).not.toContain("'");
  });

  test('matches escapeHtml — one implementation, two contract names', () => {
    for (const s of ['&<>"\'', 'plain', '', 'a&b', '</script>', '"><img src=x>']) {
      expect(escapeAttr(s)).toBe(escapeHtml(s));
    }
  });

  test('does NOT sanitise urls — escaping is not validation', () => {
    // Documented non-goal: a javascript: href contains none of the five
    // characters and survives untouched. Callers validate schemes.
    expect(escapeAttr('javascript:alert(1)')).toBe('javascript:alert(1)');
  });
});
