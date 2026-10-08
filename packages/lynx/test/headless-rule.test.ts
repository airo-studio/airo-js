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
  // Where a modal dialog sits: the top layer's `::backdrop` box, and the
  // HTML UA stylesheet (§15.3.3). Its paint (border, padding, Canvas
  // colours, the backdrop's tint) and its centring margin are not emitted.
  'position: fixed': 'CSS Positioned Layout 4 `::backdrop { position: fixed }`',
  'top: 0': 'CSS Positioned Layout 4 `::backdrop { inset: 0 }`',
  'bottom: 0': 'CSS Positioned Layout 4 `::backdrop { inset: 0 }`',
  'left: 0': 'CSS Positioned Layout 4 `::backdrop { inset: 0 }`',
  'right: 0': 'CSS Positioned Layout 4 `::backdrop { inset: 0 }`',
  'overflow: auto': 'HTML §15.3.3 `dialog:modal`',
  // Not UA values: a modal is placed by its margins inside a fixed box the
  // size of the viewport, and Lynx honours `auto` margins only on a flex
  // item, so the backdrop (that same box) lays the dialog out as one.
  'display: flex': 'HTML §15.3.3 `dialog:modal` placement, as a flex item of its backdrop',
  'flex-direction: column': 'HTML §15.3.3 `dialog:modal` placement, as a flex item of its backdrop',
  'align-items: flex-start': 'HTML §15.3.3 `dialog { width: fit-content }`: not stretched across its backdrop',
  // Not a UA value: the top layer paints above every stacking context,
  // and the largest z-index is the nearest the device has to it.
  'z-index: 2147483647': 'CSS Positioned Layout 4, the top layer',
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
