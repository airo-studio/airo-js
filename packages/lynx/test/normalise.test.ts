/**
 * One block per rewrite, each with the case it must leave alone. The
 * expected CSS is the minified form css-tree generates.
 */

import { describe, expect, it } from 'vitest';

import { NormaliseError, normaliseCss } from '../src/build/normalise.js';

/** The output without the page base rule every run prepends. */
const BASE = [
  '.airo-lynx-page{font-size:16px}',
  '.airo-lynx-viewport{width:100%;height:100%}',
  '.a-hidden{display:none;overflow:hidden}',
  '.airo-lynx-closed{display:none}',
  '.airo-lynx-modal{overflow:auto}',
  '.airo-lynx-backdrop{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-start}',
].join('');
const body = (css: string): string => normaliseCss(css).css.replace(BASE, '');

describe('page rule', () => {
  it('prepends the browser defaults the device lacks: the root font-size (so rem is 16px), a page-sized viewport, [hidden], and the dialog rules that place it', () => {
    expect(normaliseCss('').css).toBe(BASE);
  });

  it('turns html and body into the page element', () => {
    expect(body('body{color:red}html{line-height:1.5}')).toBe('.airo-lynx-page{color:red}.airo-lynx-page{line-height:1.5}');
  });

  it('resolves a relative font-size on html or body to px, since rem follows that same element on device', () => {
    expect(body('body{font:400 1rem/1.5 serif}')).toContain('font-size:16px');
    expect(body('body{font-size:100%}')).toBe('.airo-lynx-page{font-size:16px}');
    expect(body('html{font-size:62.5%}body{font-size:1.6rem}')).toBe('.airo-lynx-page{font-size:10px}.airo-lynx-page{font-size:16px}');
    expect(body('.x{font-size:1rem}body .y{font-size:2em}')).toBe('.x{font-size:1rem}.airo-lynx-page .y{font-size:2em}');
    const { report } = normaliseCss('html{font-size:62.5%}body{font-size:1.6rem}');
    expect(report.rewrites['page-font-size']).toBe(2);
    expect(report.unresolved).toEqual([expect.objectContaining({ property: 'font-size', value: '1.6rem', reason: expect.stringMatching(/body's 16px where a browser's is html's 10px/) })]);
    expect(normaliseCss('body{font-size:1rem}').report.unresolved).toEqual([]);
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
    expect(body('.d::selection{background:red}.s:has(.x){gap:0}')).toBe('');
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

describe('inset', () => {
  it('expands to the four sides, as any box shorthand', () => {
    expect(body('.a{inset:0}')).toBe('.a{top:0;right:0;bottom:0;left:0}');
    expect(body('.a{inset:1px 2px}')).toBe('.a{top:1px;right:2px;bottom:1px;left:2px}');
    expect(body('.a{inset:1px 2px 3px!important}')).toBe(
      '.a{top:1px!important;right:2px!important;bottom:3px!important;left:2px!important}',
    );
    expect(body('.a{inset:auto 0 calc(1rem + 2px) 4px}')).toBe('.a{top:auto;right:0;bottom:calc(1rem + 2px);left:4px}');
  });

  it('leaves an inset whose var() hides how many sides it sets, and reports it', () => {
    const { css, report } = normaliseCss('.a{inset:var(--edges)}');
    expect(css).toContain('.a{inset:var(--edges)}');
    expect(report.unresolved[0]).toMatchObject({ property: 'inset' });
  });
});

describe('env()', () => {
  it('becomes its fallback, so a calc() round it stands', () => {
    expect(body('.bar{bottom:calc(0.75rem + env(safe-area-inset-bottom, 0px))}')).toBe('.bar{bottom:calc(0.75rem + 0px)}');
  });

  it('a safe-area inset with no fallback is 0px, which a token calc then resolves', () => {
    expect(body(':root{--tab:calc(5.5rem + env(safe-area-inset-bottom))}')).toBe(':root{--tab:5.5rem}');
  });

  it('leaves an env() it cannot know, and reports it', () => {
    const { css, report } = normaliseCss('.a{padding:env(titlebar-area-height)}');
    expect(css).toContain('env(titlebar-area-height)');
    expect(report.unresolved[0]!.reason).toMatch(/env\(\)/);
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
    const { css, report } = normaliseCss(':root{--tab:calc(5rem + 10vh)}');
    expect(css).toContain('--tab:calc(5rem + 10vh)');
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

  it('lowers oklch() in a token too: read through var(), it paints nothing on device', () => {
    expect(body(':root{--primary:oklch(0.8 0.17 125)}.p{color:var(--primary)}')).toBe(
      ':root{--primary:rgb(165, 208, 70)}.p{color:var(--primary)}',
    );
    expect(body(':root{--glass:oklch(0.99 0.004 105/0.92)}')).toBe(':root{--glass:rgba(252, 252, 249, 0.92)}');
  });

  it('lowers the rest of CSS Color 4, and leaves hex and comma rgb() alone', () => {
    expect(body('.s{box-shadow:0 1px 3px 0 rgb(0 0 0/0.1),0 1px 2px -1px rgb(0 0 0 / 10%)}')).toBe(
      '.s{box-shadow:0 1px 3px 0 rgba(0, 0, 0, 0.1),0 1px 2px -1px rgba(0, 0, 0, 0.1)}',
    );
    expect(body('.g{background:linear-gradient(to top,rgba(17,25,10,0.82),transparent)}')).toBe(
      '.g{background:linear-gradient(to top,rgba(17,25,10,0.82),transparent)}',
    );
    expect(body('.h{color:hsl(120, 100%, 25%);border-color:#fff}')).toBe('.h{color:rgb(0, 128, 0);border-color:#fff}');
    expect(body('.l{color:lab(50% 0 0);background:oklab(1 0 0)}')).toBe('.l{color:rgb(119, 119, 119);background:rgb(255, 255, 255)}');
    expect(normaliseCss('.a{color:oklch(0.5 0.1 100)}.b{color:#000}').report.rewrites['colour-function']).toBe(1);
  });

  it('leaves a colour it cannot resolve as written, and reports it', () => {
    const { css, report } = normaliseCss('.t{color:rgb(var(--tw-rgb) / 0.5)}');
    expect(css).toContain('.t{color:rgb(var(--tw-rgb) / 0.5)}');
    expect(report.unresolved[0]).toMatchObject({ property: 'color', value: 'rgb(var(--tw-rgb) / 0.5)' });
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

describe(':empty and :modal', () => {
  it('become the classes the runtime puts on an element with no children, and on an open modal', () => {
    expect(body('.toast:empty{display:none;overflow:hidden}')).toBe('.toast.airo-lynx-empty{display:none;overflow:hidden}');
    expect(body('.list:not(:empty){margin:0}')).toBe('.list:not(.airo-lynx-empty){margin:0}');
    expect(body('dialog:modal{padding:0}')).toBe('.tag-dialog.airo-lynx-modal{padding:0}');
    const { report } = normaliseCss('.a:empty{color:red}.b:modal{color:red}');
    expect(report.rewrites).toMatchObject({ empty: 1, modal: 1 });
    expect(report.unsupported).toEqual([]);
  });
});

describe('::backdrop', () => {
  it("becomes the backdrop's class for each class of its dialog, types and attributes included", () => {
    expect(body('.sheet::backdrop{opacity:0.5}')).toBe('.airo-lynx-backdrop--sheet{opacity:0.5}');
    expect(body('dialog.sheet[open]::backdrop{opacity:0.5}')).toBe(
      '.airo-lynx-backdrop--tag-dialog.airo-lynx-backdrop--sheet.airo-lynx-backdrop--a-open{opacity:0.5}',
    );
    expect(body('.page .sheet::backdrop{opacity:0.5}')).toBe('.page .airo-lynx-backdrop--sheet{opacity:0.5}');
    expect(body('::backdrop{opacity:0.5}')).toBe('.airo-lynx-backdrop{opacity:0.5}');
  });

  it('lowers its colours like any rule, with a dark twin', () => {
    const css = ':root{--o:#000}@media (prefers-color-scheme: dark){:root{--o:#fff}}.s::backdrop{background:color-mix(in srgb,var(--o) 50%,transparent)}';
    expect(normaliseCss(css).css).toContain('.airo-lynx-backdrop--s{background:rgba(0, 0, 0, 0.5)}');
    expect(normaliseCss(css).css).toContain('.airo-lynx-dark .airo-lynx-backdrop--s{background:rgba(255, 255, 255, 0.5)}');
  });

  it('is split out and reported when its dialog is named by something the backdrop cannot carry', () => {
    const { css, report } = normaliseCss('#d::backdrop,.s::backdrop{opacity:0.5}');
    expect(css).toContain('.airo-lynx-backdrop--s{opacity:0.5}');
    expect(css).not.toContain('#d');
    expect(report.unsupported[0]).toMatchObject({ selector: '#d::backdrop', removed: true });
  });
});
