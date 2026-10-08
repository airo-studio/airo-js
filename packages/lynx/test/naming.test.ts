/**
 * The build rewrites `[name="value"]` to a class and the runtime puts that
 * class on matching elements. If the two disagreed by one character, the
 * state style would silently never apply on device — so this table runs the
 * same pairs through both sides and asserts they meet.
 */

import { describe, expect, it } from 'vitest';

import { normaliseCss } from '../src/build/normalise.js';
import { mirrorClasses } from '../src/runtime/tree.js';
import { attrClass, isMirroredValue, MAX_MIRRORED_VALUE, tagClass } from '../src/shared/attr-class.js';

const PAIRS: [name: string, value: string | null][] = [
  ['hidden', null],
  ['open', null],
  ['aria-pressed', 'true'],
  ['aria-current', 'page'],
  ['data-eighths', '3'],
  ['data-state', 'in-progress'],
  ['data-theme', 'dark'],
  ['data-kind', 'A_b'],
  ['data-x', ''],
  ['data-mixed', 'CamelCase'],
  ['data-dot', 'v1.2'],
  ['data-unicode', 'pão'],
  ['DATA-UPPER', 'x'],
];

/** The class the build writes for a one-attribute selector on `.t`. */
function buildSide(name: string, value: string | null): string {
  const selector = value === null ? `.t[${name}]` : `.t[${name}="${value}"]`;
  const { css } = normaliseCss(`${selector}{color:red}`);
  const m = /\.t\.([^{]+)\{/.exec(css);
  if (!m) throw new Error(`no class in ${css}`);
  return m[1]!.replace(/\\/g, '');
}

describe('attribute → class naming', () => {
  it.each(PAIRS)('[%s=%s]: the build rewrite and the runtime mirror agree', (name, value) => {
    const attrs = new Map([[name.toLowerCase(), value ?? '']]);
    const runtime = mirrorClasses(attrs);
    const built = buildSide(name, value);
    expect(runtime).toContain(built);
  });

  it('is injective: a name holding `--` cannot collide with a name/value pair', () => {
    expect(attrClass('a--b')).not.toBe(attrClass('a', 'b'));
    expect(attrClass('a-', 'v')).not.toBe(attrClass('a', '-v'));
    expect(attrClass('x', 'a-b')).not.toBe(attrClass('x', 'a_2d_b'));
    expect(attrClass('x', '')).not.toBe(attrClass('x'));
  });

  it('mirrors only short whitespace-free values', () => {
    expect(isMirroredValue('a'.repeat(MAX_MIRRORED_VALUE))).toBe(true);
    expect(attrClass('data-x', 'a'.repeat(MAX_MIRRORED_VALUE + 1))).toBeNull();
    expect(attrClass('data-text', 'two words')).toBeNull();
    expect(attrClass('href', '/a/b')).toBe('a-href--_2f_a_2f_b');
  });

  it('produces classes made only of characters a CSS class selector takes unescaped', () => {
    for (const [name, value] of PAIRS) {
      const c = value === null ? attrClass(name) : attrClass(name, value);
      expect(c).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    expect(tagClass('h1')).toBe('tag-h1');
  });

  it('a value class is not produced for unmirrored values, and the build reports the selector', () => {
    const { report } = normaliseCss(`.t[data-text="two words"]{color:red}`);
    expect(report.unsupported).toEqual([
      expect.objectContaining({ selector: '.t[data-text="two words"]', removed: false }),
    ]);
  });
});
