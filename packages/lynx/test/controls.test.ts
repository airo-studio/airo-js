/**
 * The elements a browser gives behaviour of its own: `<details>`, `<dialog>`
 * and `<select>`, plus the two things the device cannot match by itself,
 * `:empty` and an image's own size.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopSink, resetSink, setSink } from '@airo-js/log';

import type { PickRequest } from '../src/runtime/select.js';
import { BACKDROP_CLASS, CLOSED_DIALOG_CLASS, EMPTY_CLASS, MODAL_CLASS, backdropClass } from '../src/shared/attr-class.js';
import { type El, type Page, page } from './harness.js';

let p: Page;
beforeEach(() => setSink(noopSink));
afterEach(() => {
  p?.fake.uninstall();
  resetSink();
});

/** Let queued events (`toggle`, `close`) and a pick's answer run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const onScreen = (cls: string): boolean => p.fake.all().some((e) => e.classes.split(' ').includes(cls));

describe(':empty', () => {
  it('is a class on an element with no child nodes, kept in step as content comes and goes', () => {
    p = page('<p class="toast" data-toast></p><p class="full">x</p>');
    expect(p.native('.toast').classes.split(' ')).toContain(EMPTY_CLASS);
    expect(p.native('.full').classes.split(' ')).not.toContain(EMPTY_CLASS);
    p.root.querySelector('.toast').textContent = 'Saved';
    expect(p.native('.toast').classes.split(' ')).not.toContain(EMPTY_CLASS);
    p.root.querySelector('.toast').textContent = '';
    expect(p.native('.toast').classes.split(' ')).toContain(EMPTY_CLASS);
  });

  it('counts whitespace as content, as browsers do', () => {
    p = page('<div class="w"> </div>');
    expect(p.native('.w').classes.split(' ')).not.toContain(EMPTY_CLASS);
  });
});

describe('img', () => {
  it('takes the size the stylesheet leaves open from the picture', () => {
    p = page('<img class="logo" src="/logo.png" width="900" height="340" alt="Logo">');
    expect(p.native('.logo').attrs).toMatchObject({ src: 'https://shop.example/logo.png', 'auto-size': true, 'accessibility-label': 'Logo' });
  });
});

describe('img with an SVG source', () => {
  it('is an svg with that src, since a Lynx image does not draw SVG, and swaps element when the source changes kind', () => {
    p = page('<img class="logo" src="/logo.svg?v=2" width="360" height="136" alt="Logo"><img class="d" src="data:image/svg+xml,%3Csvg%3E">');
    expect(p.native('.logo')).toMatchObject({ tag: 'svg', attrs: { src: 'https://shop.example/logo.svg?v=2', 'accessibility-label': 'Logo' } });
    expect(p.native('.logo').attrs.content).toBeUndefined();
    expect(p.native('.logo').style).toBe('aspect-ratio: 360 / 136');
    expect(p.native('.d').tag).toBe('svg');
    p.root.querySelector('.logo').setAttribute('src', '/logo.png');
    expect(p.native('.logo')).toMatchObject({ tag: 'image', attrs: { src: 'https://shop.example/logo.png' } });
  });
});

describe('<details>', () => {
  const HTML = '<details class="more"><summary class="s">More <b>2</b></summary><p class="body">Hidden</p></details>';

  it('shows only its summary while closed, and everything once open', () => {
    p = page(HTML);
    expect(onScreen('body')).toBe(false);
    expect(p.root.querySelector('.body').textContent).toBe('Hidden');
    p.root.querySelector('.more').open = true;
    expect(onScreen('body')).toBe(true);
    expect(p.native('.more').classes.split(' ')).toContain('a-open');
  });

  it('toggles on a tap on its summary, then fires toggle on the details only', async () => {
    p = page(HTML);
    const seen: string[] = [];
    p.root.querySelector('.more').addEventListener('toggle', (e: El) => seen.push(`details:${e.target.open}`));
    p.root.addEventListener('toggle', () => seen.push('root'));
    p.tap('.s');
    expect(p.root.querySelector('.more').open).toBe(true);
    expect(onScreen('body')).toBe(true);
    expect(seen).toEqual([]);
    await settle();
    expect(seen).toEqual(['details:true']);
    p.tap('.s');
    expect(onScreen('body')).toBe(false);
  });

  it('does not toggle when the click is prevented, or the tap is on a link inside the summary', () => {
    p = page('<details class="d"><summary class="s"><a class="l" href="/x">x</a> y</summary><p>z</p></details>');
    p.tap('.l');
    expect(p.navigate).toHaveBeenCalledWith(expect.objectContaining({ url: '/x' }));
    expect(p.root.querySelector('.d').open).toBe(false);
    p.root.querySelector('.s').addEventListener('click', (e: El) => e.preventDefault());
    p.tap('.s');
    expect(p.root.querySelector('.d').open).toBe(false);
  });

  it('closes from a handler, as `details.open = false` and removeAttribute do in a browser', () => {
    p = page('<details class="d" open><summary>s</summary><p class="body">b</p></details>');
    expect(onScreen('body')).toBe(true);
    p.root.querySelector('.d').open = false;
    expect(onScreen('body')).toBe(false);
    p.root.querySelector('.d').setAttribute('open', '');
    p.root.querySelector('.d').removeAttribute('open');
    expect(onScreen('body')).toBe(false);
  });
});

describe('<dialog>', () => {
  const HTML =
    '<main class="page"><button class="opener" type="button">Open</button>' +
    '<dialog class="sheet" id="s"><p class="msg">Sure?</p><button class="x" data-close type="button">Close</button></dialog>' +
    '<p class="after">after</p></main>';
  /** The wireDialog pattern: a click on the backdrop (the dialog itself) or a close button closes it. */
  const wire = (dialog: El): void =>
    dialog.addEventListener('click', (e: El) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close('dismissed');
    });

  it('is on screen while closed as an empty element the UA rule hides, its content in the model only', () => {
    p = page(HTML);
    expect(p.native('.sheet').classes.split(' ')).toContain(CLOSED_DIALOG_CLASS);
    expect(p.native('.sheet').children).toEqual([]);
    expect(p.root.querySelector('.msg').textContent).toBe('Sure?');
  });

  it('opens as a modal inside its backdrop, which carries a class per class of the dialog', () => {
    p = page(HTML);
    const before = p.native('.page');
    p.root.querySelector('.sheet').showModal();
    const dialog = p.native('.sheet');
    expect(dialog.classes.split(' ')).toContain(MODAL_CLASS);
    expect(dialog.classes.split(' ')).not.toContain(CLOSED_DIALOG_CLASS);
    const backdrop = dialog.parent!;
    expect(backdrop.classes.split(' ')).toEqual(expect.arrayContaining([BACKDROP_CLASS, backdropClass('sheet'), backdropClass('tag-dialog'), backdropClass('a-open')]));
    expect(backdrop.parent).toBe(before);
    expect(onScreen('msg')).toBe(true);
    // Only the dialog was rebuilt: the page around it is the same element.
    expect(p.native('.page')).toBe(before);
    expect(p.root.querySelector('.sheet').open).toBe(true);
  });

  it('closes on a tap on its backdrop, fires close afterwards, and keeps the returnValue', async () => {
    p = page(HTML);
    const sheet = p.root.querySelector('.sheet');
    wire(sheet);
    const closed = vi.fn();
    sheet.addEventListener('close', closed);
    sheet.showModal();
    p.fake.tap(p.fake.byClass(BACKDROP_CLASS));
    expect(sheet.open).toBe(false);
    expect(p.native('.sheet').classes.split(' ')).toContain(CLOSED_DIALOG_CLASS);
    expect(onScreen(BACKDROP_CLASS)).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    await settle();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sheet.returnValue).toBe('dismissed');
  });

  it('makes the page below inert: a tap outside it lands on the dialog', () => {
    p = page(HTML);
    const sheet = p.root.querySelector('.sheet');
    const opener = vi.fn();
    p.root.querySelector('.opener').addEventListener('click', opener);
    const targets: unknown[] = [];
    sheet.addEventListener('click', (e: El) => targets.push(e.target));
    sheet.showModal();
    p.tap('.after');
    expect(opener).not.toHaveBeenCalled();
    expect(targets).toEqual([sheet]);
    p.tap('.x', 0);
    expect(targets).toEqual([sheet, p.root.querySelector('.x')]);
  });

  it('closes from a button inside it, and opens again in the same place', () => {
    p = page(HTML);
    const sheet = p.root.querySelector('.sheet');
    wire(sheet);
    sheet.showModal();
    p.tap('.x');
    expect(sheet.open).toBe(false);
    sheet.showModal();
    expect(sheet.open).toBe(true);
    expect(p.native('.sheet').parent!.parent).toBe(p.native('.page'));
  });

  it('follows the browser on a second show: a no-op when it matches, InvalidStateError when it does not', () => {
    p = page(HTML);
    const sheet = p.root.querySelector('.sheet');
    sheet.showModal();
    sheet.showModal();
    expect(() => sheet.show()).toThrow(/already open as a modal/);
    sheet.close();
    sheet.show();
    expect(p.native('.sheet').classes.split(' ')).not.toContain(MODAL_CLASS);
    expect(onScreen(BACKDROP_CLASS)).toBe(false);
  });

  it('closes when a method="dialog" form inside it is submitted, with the submitter as returnValue', async () => {
    p = page('<dialog class="d"><form method="dialog"><button class="ok" value="ok">OK</button></form></dialog>');
    const d = p.root.querySelector('.d');
    d.showModal();
    p.tap('.ok');
    expect(d.open).toBe(false);
    expect(d.returnValue).toBe('ok');
    expect(p.navigate).not.toHaveBeenCalled();
  });

  it('refuses dialog members on anything else, by name', () => {
    p = page('<div class="d"></div>');
    expect(() => p.root.querySelector('.d').open).toThrow(/<div>\.open/);
    expect(() => p.root.querySelector('.d').close()).toThrow(/<div>\.close\(\)/);
  });
});

describe('<select>', () => {
  const HTML =
    '<form action="/find"><select class="sel" name="size">' +
    '<option value="">Any</option><optgroup label="Small"><option value="s">S</option><option value="m" selected>M</option></optgroup>' +
    '<option value="l" disabled>L</option></select><button class="go">Go</button></form>';
  const label = (): string => p.native('.sel').children.map((t) => t.children[0]?.text).join('');

  it('shows the selected option, and keeps the options in the model only', () => {
    p = page(HTML);
    expect(label()).toBe('M');
    expect(onScreen('tag-option')).toBe(false);
    expect(p.root.querySelector('.sel').value).toBe('m');
    expect(p.root.querySelector('.sel').selectedIndex).toBe(2);
  });

  it('selects the first enabled option when the markup selects none', () => {
    p = page('<select class="sel"><option disabled>a</option><option>b</option></select>');
    expect(label()).toBe('b');
    expect(p.root.querySelector('.sel').value).toBe('b');
  });

  it('asks the host on a tap, then changes and fires input and change as a pick does', async () => {
    const pick = vi.fn((_r: PickRequest) => Promise.resolve('s'));
    p = page(HTML, { pick });
    const seen: string[] = [];
    for (const type of ['input', 'change']) p.root.addEventListener(type, (e: El) => seen.push(`${type}:${e.target.value}`));
    p.tap('.sel');
    expect(pick).toHaveBeenCalledWith({
      kind: 'select',
      name: 'size',
      value: 'm',
      options: [
        { value: '', label: 'Any', disabled: false },
        { value: 's', label: 'S', disabled: false, group: 'Small' },
        { value: 'm', label: 'M', disabled: false, group: 'Small' },
        { value: 'l', label: 'L', disabled: true },
      ],
    });
    await settle();
    expect(label()).toBe('S');
    expect(seen).toEqual(['input:s', 'change:s']);
  });

  it('leaves it as it was when the host answers nothing, or the same value', async () => {
    const answers = [null, undefined, 'm'];
    p = page(HTML, { pick: () => answers.shift() });
    const change = vi.fn();
    p.root.addEventListener('change', change);
    for (let i = 0; i < 3; i++) {
      p.tap('.sel');
      await settle();
    }
    expect(label()).toBe('M');
    expect(change).not.toHaveBeenCalled();
  });

  it('reports an answer that is not an enabled option, and a tap with no onPick', async () => {
    p = page(HTML, { pick: () => 'l' });
    p.tap('.sel');
    await settle();
    expect(p.errors.map((e) => String(e.error))).toEqual([expect.stringMatching(/answered "l".*no enabled option/)]);
    p.fake.uninstall();
    p = page(HTML);
    p.tap('.sel');
    expect(p.errors.map((e) => String(e.error))).toEqual([expect.stringMatching(/<select name="size"> was tapped: mountLynx has no onPick/)]);
  });

  it('answers value, selectedIndex, options, selected and text as a browser does, and fires nothing for a script', () => {
    p = page(HTML);
    const sel = p.root.querySelector('.sel');
    const change = vi.fn();
    sel.addEventListener('change', change);
    expect(sel.options.map((o: El) => o.text)).toEqual(['Any', 'S', 'M', 'L']);
    expect([...sel.options].find((o: El) => o.hasAttribute('selected'))?.value).toBe('m');
    sel.value = 's';
    expect(label()).toBe('S');
    expect(sel.options[1].selected).toBe(true);
    sel.value = 'nope';
    expect(sel.selectedIndex).toBe(-1);
    expect(sel.value).toBe('');
    expect(label()).toBe('');
    sel.selectedIndex = 0;
    expect(label()).toBe('Any');
    sel.options[2].selected = true;
    expect(sel.value).toBe('m');
    expect(change).not.toHaveBeenCalled();
  });

  it('submits its value with the form, and nothing when no enabled option is selected', () => {
    p = page(HTML);
    p.tap('.go');
    expect(p.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { size: 'm' } }));
    p.root.querySelector('.sel').value = 'l';
    p.tap('.go');
    expect(p.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ fields: {} }));
  });

  it('does nothing on a tap when disabled', () => {
    const pick = vi.fn();
    p = page('<select class="sel" disabled><option>a</option></select>', { pick });
    p.tap('.sel');
    expect(pick).not.toHaveBeenCalled();
  });
});
