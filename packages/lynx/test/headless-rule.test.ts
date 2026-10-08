/**
 * The framework ships no visual policy (airo-js is headless). The normaliser
 * emits CSS the cartridge did not write, which is allowed only as browser
 * semantics: each declaration it adds must be the value a browser would use
 * for the same case. This test holds every emitted declaration to a table of
 * those values, each with the spec text it comes from. A new emitter that
 * invents a value fails here before it reaches a device.
 */

import { describe, expect, it } from 'vitest';

import { normaliseCss } from '../src/build/normalise.js';

/** property: value → where a browser takes that value from. */
const BROWSER_VALUES: Record<string, string> = {
  'font-size: 16px': 'CSS Fonts 4 §2.5 `medium` / HTML UA root font-size',
  'width: 100%': 'CSS 2.1 §10.3.3 used width of `auto` for a block in normal flow',
  'font-style: normal': 'CSS Fonts 4 initial value',
  'font-weight: normal': 'CSS Fonts 4 initial value',
  'line-height: normal': 'CSS Inline 3 initial value',
  'display: none': 'HTML §15.3.1 UA stylesheet `[hidden]`',
  'height: 100%': 'CSS 2.1 §10.1 the viewport is the size of the screen; its stand-in fills the page',
  // Not an initial value: the translation of what `display: none` means
  // (no descendant renders) onto an engine that still paints them.
  'overflow: hidden': 'CSS Display 3 §2.5 `display: none` renders no descendants',
};

/** Every rewrite that emits something, in one sheet. */
const SHEET = [
  'body{margin:0}',
  '.gone{display:none}',
  '.pic{aspect-ratio:3/2}',
  '.t1{font:1rem serif}',
  '.t2{font:700 1rem/1.5 serif}',
  '.t3{font:italic 1rem serif}',
  '@media (prefers-color-scheme: dark){.pic{aspect-ratio:1}}',
].join('\n');

describe('the headless rule', () => {
  const { report } = normaliseCss(SHEET);

  it('emits something, so the table below is exercised', () => {
    expect(report.emitted.length).toBeGreaterThanOrEqual(5);
  });

  it.each(report.emitted.map((e) => [`${e.selector} { ${e.property}: ${e.value} }`, e] as const))(
    '%s is a browser initial or UA value, and says which',
    (_label, emitted) => {
      expect(Object.keys(BROWSER_VALUES)).toContain(`${emitted.property}: ${emitted.value}`);
      expect(emitted.cite).toMatch(/CSS|HTML/);
    },
  );

  it('never emits a colour, a font family, or a spacing value', () => {
    for (const e of report.emitted) {
      expect(e.property).not.toMatch(/color|background|family|margin|padding|gap|border/);
    }
  });

  it('emits overflow: hidden only next to display: none', () => {
    const { css } = normaliseCss('.a{overflow:visible}.b{display:flex}.c{display:none}');
    expect(css.match(/overflow:hidden/g)).toHaveLength(2); // the [hidden] default, and .c
  });
});
