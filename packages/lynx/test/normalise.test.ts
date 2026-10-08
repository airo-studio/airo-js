/**
 * One block per rewrite, each with the case it must leave alone. The
 * expected CSS is the minified form css-tree generates.
 */

import { describe, expect, it } from 'vitest';

import { NormaliseError, normaliseCss } from '../src/build/normalise.js';

/** The output without the page base rule every run prepends. */
const BASE = '.airo-lynx-page{font-size:16px}.airo-lynx-viewport{width:100%;height:100%}.a-hidden{display:none;overflow:hidden}';
const body = (css: string): string => normaliseCss(css).css.replace(BASE, '');

describe('page rule', () => {
  it('prepends the browser defaults the device lacks: the root font-size (so rem is 16px), a page-sized viewport, and [hidden]', () => {
    expect(normaliseCss('').css).toBe(BASE);
  });

  it('turns html and body into the page element', () => {
    expect(body('body{color:red}html{line-height:1.5}')).toBe('.airo-lynx-page{color:red}.airo-lynx-page{line-height:1.5}');
  });

  it('leaves a class that happens to be called body alone', () => {
    expect(body('.body{color:red}')).toBe('.body{color:red}');
  });
});

describe('type selectors', () => {
  it('become the tag classes the runtime adds', () => {
    expect(body('h1,.x p{margin:0}')).toBe('.tag-h1,.x .tag-p{margin:0}');
  });

  it('keep the universal selector', () => {
    expect(body('*{box-sizing:border-box}')).toBe('*{box-sizing:border-box}');
  });

  it('report a selector that reaches inside an inline SVG', () => {
    const { report } = normaliseCss('.icon path{stroke-width:2}');
    expect(report.unsupported[0]).toMatchObject({ selector: '.icon path', removed: false });
    expect(report.unsupported[0]!.reason).toMatch(/inline SVG/);
  });
});

describe('attribute selectors', () => {
  it('rewrite presence and `=` to mirror classes, including inside :not()', () => {
    expect(body('[hidden]{display:none!important}')).toBe('.a-hidden{display:none!important;overflow:hidden!important}');
    expect(body('.chip[aria-pressed="true"]{color:red}')).toBe('.chip.a-aria-pressed--true{color:red}');
    expect(body('.x:not([data-open]){opacity:0}')).toBe('.x:not(.a-data-open){opacity:0}');
  });

  it('leave other operators as written and report them', () => {
    const { css, report } = normaliseCss('img[src*="/covers/"]{filter:none}');
    expect(css).toContain('.tag-img[src*="/covers/"]');
    expect(report.unsupported[0]).toMatchObject({ removed: false });
    expect(report.unsupported[0]!.reason).toMatch(/operator `\*=`/);
  });
});

describe('selectors the encoder rejects', () => {
  it('are split out so the rest of the list survives', () => {
    const { css, report } = normaliseCss('.a:focus-visible .i,.a:hover .i{color:red}');
    expect(css).toContain('.a:hover .i{color:red}');
    expect(css).not.toContain('focus-visible');
    expect(report.unsupported).toEqual([
      expect.objectContaining({ selector: '.a:focus-visible .i', removed: true }),
    ]);
    expect(report.rewrites['rejected-selector-split']).toBe(1);
  });

  it('drop the rule when every selector in it is rejected', () => {
    expect(body('.d::backdrop{background:red}.s:has(.x){gap:0}')).toBe('');
  });

  it('keep pseudo-elements the encoder parses', () => {
    expect(body('.in::placeholder{color:grey}')).toBe('.in::placeholder{color:grey}');
    const { report } = normaliseCss('.x::before{content:""}');
    expect(report.unsupported[0]).toMatchObject({ removed: false, reason: '::before content does not render on device' });
  });

  it('report structural pseudo-classes, which parse and never match', () => {
    const { css, report } = normaliseCss('li:first-child{margin:0}');
    expect(css).toContain('.tag-li:first-child');
    expect(report.unsupported[0]!.reason).toMatch(/never matches/);
  });
});

describe('display', () => {
  it('display: none also clips, so the text inside does not paint, at the same importance', () => {
    expect(body('.x{display:none}.y{display:none!important}')).toBe(
      '.x{display:none;overflow:hidden}.y{display:none!important;overflow:hidden!important}',
    );
  });

  it('leaves a display: none rule that already sets overflow', () => {
    expect(body('.x{display:none;overflow:auto}')).toBe('.x{display:none;overflow:auto}');
  });

  it('inline-flex → flex', () => {
    expect(body('.b{display:inline-flex;gap:4px}')).toBe('.b{display:flex;gap:4px}');
  });

  it('leaves inline-block alone', () => {
    expect(body('.b{display:inline-block}')).toBe('.b{display:inline-block}');
  });
});

describe('font shorthand', () => {
  it('expands to longhands, resetting the omitted ones as the shorthand does', () => {
    expect(body('.t{font:600 1rem/1.4 "Outfit", sans-serif}')).toBe(
      '.t{font-style:normal;font-weight:600;font-size:1rem;line-height:1.4;font-family:"Outfit", sans-serif}',
    );
    expect(body('.t{font:italic 2rem serif}')).toBe(
      '.t{font-style:italic;font-weight:normal;font-size:2rem;line-height:normal;font-family:serif}',
    );
  });

  it('expands a CSS-wide keyword to every longhand', () => {
    expect(body('button{font:inherit}')).toBe(
      '.tag-button{font-style:inherit;font-weight:inherit;font-size:inherit;line-height:inherit;font-family:inherit}',
    );
  });

  it('leaves a shorthand it cannot split, and reports it', () => {
    const { css, report } = normaliseCss('.t{font:var(--body-font)}');
    expect(css).toContain('.t{font:var(--body-font)}');
    expect(report.unresolved[0]).toMatchObject({ property: 'font' });
  });
});

describe('calc()', () => {
  it('resolves static calc() in root tokens', () => {
    expect(body(':root{--radius:0.75rem;--radius-xl:calc(var(--radius) + 4px)}')).toBe(
      ':root{--radius:0.75rem;--radius-xl:16px}',
    );
  });

  it('keeps the unit when there is only one', () => {
    expect(body(':root{--s:calc(1rem * 2)}')).toBe(':root{--s:2rem}');
  });

  it('resolves each calc() in a multi-value border-radius', () => {
    expect(body(':root{--r:12px}.x{border-radius:calc(var(--r) - 2px) calc(var(--r) - 2px) 0 0}')).toContain(
      '.x{border-radius:10px 10px 0 0}',
    );
  });

  it('leaves calc() that depends on the element or viewport, and reports it', () => {
    const { css, report } = normaliseCss(':root{--tab:calc(5rem + env(safe-area-inset-bottom, 0px))}');
    expect(css).toContain('--tab:calc(5rem + env(safe-area-inset-bottom, 0px))');
    expect(report.unresolved).toHaveLength(1);
  });

  it('leaves calc() on a plain length, which Lynx evaluates', () => {
    expect(body('.x{width:calc(100% - 20px)}')).toBe('.x{width:calc(100% - 20px)}');
  });
});

describe('aspect-ratio', () => {
  it('adds width: 100% when the box relies on stretch for its width', () => {
    const { css, report } = normaliseCss('.pic{aspect-ratio:3/2}');
    expect(css).toContain('.pic{aspect-ratio:3/2;width:100%}');
    expect(report.emitted).toContainEqual(expect.objectContaining({ selector: '.pic', property: 'width', value: '100%' }));
  });

  it('adds nothing when a width or a height is set', () => {
    expect(body('.a{aspect-ratio:1;width:150px}.b{aspect-ratio:1;height:40px}')).toBe(
      '.a{aspect-ratio:1;width:150px}.b{aspect-ratio:1;height:40px}',
    );
  });
});

describe('colour', () => {
  it('lowers a literal oklch() in a declaration to sRGB', () => {
    expect(body('.p{background-color:oklch(0.8 0.17 125)}')).toBe('.p{background-color:rgb(165, 208, 70)}');
  });

  it('leaves oklch() in a token, which resolves on device through var()', () => {
    expect(body(':root{--primary:oklch(0.8 0.17 125)}.p{color:var(--primary)}')).toBe(
      ':root{--primary:oklch(0.8 0.17 125)}.p{color:var(--primary)}',
    );
  });

  it('evaluates color-mix() with premultiplied alpha', () => {
    expect(body('.m{color:color-mix(in srgb, #ff0000 50%, #0000ff)}')).toBe('.m{color:rgb(128, 0, 128)}');
    expect(body('.m{color:color-mix(in oklab, #ff0000 20%, transparent)}')).toBe('.m{color:rgba(255, 0, 0, 0.2)}');
  });

  it('scales alpha when the percentages sum below 100%', () => {
    expect(body('.m{color:color-mix(in srgb, #ff0000 30%, #0000ff 20%)}')).toBe('.m{color:rgba(153, 0, 102, 0.5)}');
  });

  it('bakes a light value in place and a dark twin when the tokens differ by theme', () => {
    const css = [
      ':root{--bg:#ffffff}',
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#000000}}',
      '.card:hover{background:color-mix(in srgb, var(--bg) 50%, transparent)}',
    ].join('');
    const out = body(css);
    expect(out).toContain('.card:hover{background:rgba(255, 255, 255, 0.5)}');
    expect(out).toContain('.airo-lynx-dark .card:hover{background:rgba(0, 0, 0, 0.5)}');
  });

  it('does not take light tokens from a root rule keyed on an attribute', () => {
    const css = ':root{--bg:#ffffff}:root[data-theme="dark"]{--bg:#000000}.c{color:color-mix(in srgb, var(--bg) 50%, transparent)}';
    expect(body(css)).toContain('.c{color:rgba(255, 255, 255, 0.5)}');
  });

  it('uses the dark tokens inside a dark media block, with no twin', () => {
    const css = ':root{--bg:#ffffff}@media (prefers-color-scheme: dark){:root{--bg:#000000}.c{color:color-mix(in srgb, var(--bg) 50%, transparent)}}';
    const out = body(css);
    expect(out).toContain('.airo-lynx-dark .c{color:rgba(0, 0, 0, 0.5)}');
    expect(out).not.toContain('255, 255, 255');
  });

  it('uses a var() fallback when the token is missing', () => {
    expect(body('.c{color:color-mix(in srgb, var(--nope, #ff0000) 50%, #0000ff)}')).toBe('.c{color:rgb(128, 0, 128)}');
  });

  it('fails the build, with the location, when a colour reads a var the build cannot see', () => {
    const css = '.house{--ink:#ff0000}\n.house .t{color:color-mix(in oklab, var(--ink) 50%, white)}';
    expect(() => normaliseCss(css, { filename: 'site.css' })).toThrow(NormaliseError);
    expect(() => normaliseCss(css, { filename: 'site.css' })).toThrow(/site\.css:2:\d+: .*--ink is not a :root token/);
  });
});

describe('@media', () => {
  it('turns prefers-color-scheme: dark into the dark page class', () => {
    expect(body('@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--a:#000}.logo--light{display:none}}')).toBe(
      '.airo-lynx-page.airo-lynx-dark:not(.a-data-theme--light){--a:#000}.airo-lynx-dark .logo--light{display:none;overflow:hidden}',
    );
  });

  it('turns prefers-color-scheme: light into not-dark', () => {
    expect(body('@media (prefers-color-scheme: light){.x{color:red}}')).toBe(
      '.airo-lynx-page:not(.airo-lynx-dark) .x{color:red}',
    );
  });

  it('keeps every other query, normalised inside, and reports it as dropped at engine 3.9', () => {
    const { css, report } = normaliseCss('@media (min-width: 40rem){h1{display:inline-flex}}');
    expect(css).toContain('@media (min-width:40rem){.tag-h1{display:flex}}');
    expect(report.droppedMedia).toEqual([expect.objectContaining({ query: '(min-width:40rem)' })]);
  });

  it('leaves keyframe selectors alone', () => {
    expect(body('@keyframes pulse{from{opacity:0}to{opacity:1}}')).toBe('@keyframes pulse{from{opacity:0}to{opacity:1}}');
  });
});
