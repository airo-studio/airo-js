/**
 * The elements a browser gives behaviour of its own: `<details>`, `<dialog>`
 * and `<select>`, plus the two things the device cannot match by itself,
 * `:empty` and an image's own size.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noopSink, resetSink, setSink } from '@airo-js/log';

import type { PickAnswer, PickRequest } from '../src/runtime/select.js';
import { formDataClass } from '../src/runtime/form-data.js';
import { BACKDROP_CLASS, CHECKED_CLASS, CLOSED_DIALOG_CLASS, EMPTY_CLASS, MODAL_CLASS, backdropClass } from '../src/shared/attr-class.js';
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

describe('img sizes, settled after the first layout', () => {
  /** Laid-out sizes by class, as the engine reports them; `width` can be changed between flushes. */
  const sizes: Record<string, { width: number; height: number }> = {};
  const layout = (el: { classes: string }, key: string): string => {
    const hit = Object.entries(sizes).find(([cls]) => el.classes.split(' ').includes(cls));
    return hit ? `${hit[1][key as 'width' | 'height']}px` : '';
  };
  const flushed = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('pins an image the stylesheet sizes at the height it was laid out at, and keeps the ratio as its width changes', async () => {
    Object.assign(sizes, { photo: { width: 350, height: 262.5 } });
    p = page('<div class="grid"><img class="photo" src="/p.jpg" width="1024" height="768"></div>', { layout });
    p.tree.markDirty();
    await flushed();
    expect(p.native('.photo').style).toBe('height: 262.5px');
    expect(p.native('.photo').attrs['auto-size']).toBeUndefined();
    sizes.photo = { width: 175, height: 262.5 };
    p.tree.markDirty();
    await flushed();
    expect(p.native('.photo').style).toBe('height: 131.25px');
  });

  it('rebuilds an image with a side left at 0 with auto-size, which Lynx reads only at creation', async () => {
    Object.assign(sizes, { logo: { width: 0, height: 56 }, wrap: { width: 350, height: 100 } });
    p = page('<div class="wrap"><img class="logo" src="/l.png"><img class="bare" src="/b.png"></div>', { layout });
    const before = p.native('.logo');
    p.tree.markDirty();
    await flushed();
    expect(p.native('.logo')).not.toBe(before);
    expect(p.native('.logo').attrs['auto-size']).toBe(true);
    // The height it was laid out at stays: auto-size alone hands a grid row the picture's natural height.
    expect(p.native('.logo').style).toBe('height: 56px');
    // No size at all, in a parent with a width: no size from the stylesheet either.
    expect(p.native('.bare').attrs['auto-size']).toBe(true);
  });

  it('gives an img with no height the ratio of its width and height attributes, as a browser does, then settles it', async () => {
    // As measured with `max-width: 100%`: the computed width reads 0 while the height follows the real width.
    const ratioLayout = (el: { classes: string; style?: string }, key: string): string => {
      if (el.classes.split(' ').includes('frame')) return key === 'width' ? '350px' : '0px';
      if (!el.classes.split(' ').includes('shot')) return '';
      return key === 'height' && el.style?.includes('aspect-ratio') ? '262.5px' : '0px';
    };
    p = page('<figure class="frame"><img class="shot" src="/s.jpg" width="1024" height="768"></figure>', { layout: ratioLayout });
    p.tree.markDirty();
    await flushed();
    expect(p.native('.shot').attrs['auto-size']).toBe(true);
    expect(p.native('.shot').style).toBe('aspect-ratio: 1024 / 768; height: 262.5px');
  });

  it('waits while an image and its parent have no size (a hidden parent)', async () => {
    Object.assign(sizes, { gone: { width: 0, height: 0 } });
    p = page('<div class="gone" hidden><img class="pic" src="/x.png"></div>', { layout });
    p.tree.markDirty();
    await flushed();
    expect(p.native('.pic').attrs['auto-size']).toBeUndefined();
    expect(p.native('.pic').style).toBeUndefined();
  });
});

describe('img with an SVG source', () => {
  it('pins its height once laid out, so a parent with no height of its own counts it', async () => {
    const svgLayout = (el: { classes: string }, key: string): string =>
      el.classes.split(' ').includes('cover') ? (key === 'width' ? '169px' : '169px') : '';
    p = page('<div class="media"><img class="cover" src="/c.svg" width="10" height="10"><img class="half" src="/h.svg"></div>', { layout: svgLayout });
    p.tree.markDirty();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.native('.cover').style).toBe('aspect-ratio: 10 / 10; height: 169px');
    // Not laid out with both sides: no picture to take one from, so it waits, and is never auto-sized.
    expect(p.native('.half').style).toBe('');
    expect(p.native('.half').attrs['auto-size']).toBeUndefined();
  });

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

describe('checkbox and radio', () => {
  // The site's switch: the input is visually hidden, the label takes the tap, the track is drawn by `:checked + …`.
  const SWITCH =
    '<form action="/prefs" method="post"><label class="sw"><span class="sw__label">Mail me</span>' +
    '<input class="sr" type="checkbox" name="mail" data-pref="mail"><span class="sw__track"></span></label>' +
    '<label class="sw2"><input class="c2" type="checkbox" name="news" value="weekly" checked> News</label>' +
    '<button class="save">Save</button></form>';
  const checkedClass = (selector: string): boolean => p.native(selector).classes.split(' ').includes(CHECKED_CLASS);

  it('is an empty view the stylesheet draws, carrying the checked class while checked', () => {
    p = page(SWITCH);
    expect(p.native('.sr').tag).toBe('view');
    expect(p.native('.sr').children).toEqual([]);
    expect(checkedClass('.sr')).toBe(false);
    expect(checkedClass('.c2')).toBe(true);
  });

  it('toggles on a tap on its label: the label\'s click, then the box toggled before its own click, then input and change', () => {
    p = page(SWITCH);
    const seen: string[] = [];
    for (const type of ['click', 'input', 'change']) p.root.addEventListener(type, (e: El) => seen.push(`${type}:${e.target.tagName}:${p.root.querySelector('.sr').checked}`));
    p.tap('.sw__track');
    expect(p.root.querySelector('.sr').checked).toBe(true);
    expect(checkedClass('.sr')).toBe(true);
    // The label's own click comes first, with the box as it was; the click it passes on sees it toggled.
    expect(seen).toEqual(['click:SPAN:false', 'click:INPUT:true', 'input:INPUT:true', 'change:INPUT:true']);
    p.tap('.sw__label');
    expect(p.root.querySelector('.sr').checked).toBe(false);
  });

  it('puts the state back when a handler cancels the click', () => {
    p = page(SWITCH);
    const change = vi.fn();
    p.root.querySelector('.sr').addEventListener('click', (e: El) => e.preventDefault());
    p.root.addEventListener('change', change);
    p.tap('.sw__track');
    expect(p.root.querySelector('.sr').checked).toBe(false);
    expect(checkedClass('.sr')).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it('submits a checked box with its value, `on` without one, and nothing for an unchecked one', () => {
    p = page(SWITCH);
    p.tap('.save');
    expect(p.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { news: 'weekly' } }));
    p.root.querySelector('.sr').checked = true;
    p.tap('.save');
    expect(p.navigate).toHaveBeenLastCalledWith(expect.objectContaining({ fields: { mail: 'on', news: 'weekly' } }));
  });

  it('follows the checked attribute until a tap or a script has set it, and fires nothing for a script', () => {
    p = page(SWITCH);
    const sr = p.root.querySelector('.sr');
    const change = vi.fn();
    p.root.addEventListener('change', change);
    sr.setAttribute('checked', '');
    expect(sr.checked).toBe(true);
    sr.checked = false;
    sr.setAttribute('checked', '');
    expect(sr.checked).toBe(false);
    expect(change).not.toHaveBeenCalled();
  });

  it('checks one radio of a group at a time; a tap on the checked one changes nothing', () => {
    p = page(
      '<fieldset><label class="l1"><input class="r1" type="radio" name="theme" value="light" checked><span>Light</span></label>' +
        '<label class="l2"><input class="r2" type="radio" name="theme" value="dark"><span>Dark</span></label>' +
        '<label class="l3"><input class="r3" type="radio" name="lang" value="pt" checked><span>PT</span></label></fieldset>',
    );
    const change = vi.fn();
    p.root.addEventListener('change', change);
    p.tap('.l2');
    expect([1, 2, 3].map((i) => p.root.querySelector(`.r${i}`).checked)).toEqual([false, true, true]);
    expect([1, 2].map((i) => checkedClass(`.r${i}`))).toEqual([false, true]);
    expect(change).toHaveBeenCalledTimes(1);
    p.tap('.l2');
    expect(change).toHaveBeenCalledTimes(1);
  });

  it('sets the classes of what follows a toggled box again: Lynx does not restyle a `+` sibling by itself', () => {
    p = page(SWITCH);
    const setClasses = vi.spyOn(globalThis as unknown as { __SetClasses: (el: unknown, c: string) => void }, '__SetClasses');
    p.tap('.sw__track');
    expect(setClasses.mock.calls.some(([el]) => el === p.native('.sw__track'))).toBe(true);
    setClasses.mockRestore();
  });

  it('reaches a control by the label\'s `for`, and refuses `checked` on anything else', () => {
    p = page('<label class="l" for="x">Agree</label><input id="x" class="x" type="checkbox"><div class="d"></div>');
    p.tap('.l');
    expect(p.root.querySelector('.x').checked).toBe(true);
    expect(() => p.root.querySelector('.d').checked).toThrow(/<div>\.checked/);
  });
});

describe('file input', () => {
  const HTML =
    '<form class="f" action="/up" method="post"><label class="pick"><span>Photo</span>' +
    '<input class="file" type="file" name="photo" accept="image/*"></label><input name="title" value="Chair"><button class="go">Send</button></form>';
  const photo = { name: 'chair.jpg', type: 'image/jpeg', uri: 'ph://1' };

  it('asks the host for files on a tap on its label, then sets them and fires input and change', async () => {
    const pick = vi.fn((_r: PickRequest): PickAnswer => [photo, { name: 'other.jpg' }]);
    p = page(HTML, { pick });
    const seen: string[] = [];
    p.root.addEventListener('change', (e: El) => seen.push(`${e.target.files.length}:${e.target.value}`));
    expect(p.native('.file').tag).toBe('view');
    p.tap('.pick');
    expect(pick).toHaveBeenCalledWith({ kind: 'file', name: 'photo', accept: 'image/*', multiple: false });
    await settle();
    const input = p.root.querySelector('.file');
    expect(input.files).toEqual([photo]);
    expect(seen).toEqual(['1:C:\\fakepath\\chair.jpg']);
    input.value = '';
    expect(input.files).toEqual([]);
    expect(() => {
      input.value = 'x';
    }).toThrow(/only to ""/);
  });

  it('refuses to post a form holding a picked file through onNavigate, which cannot carry it', async () => {
    p = page(HTML, { pick: () => [photo] });
    p.tap('.pick');
    await settle();
    p.tap('.go');
    expect(p.navigate).not.toHaveBeenCalled();
    expect(p.errors.map((e) => String(e.error))).toEqual([expect.stringMatching(/onNavigate cannot carry files/)]);
  });

  it('gives FormData its entries by the form rules, the host\'s file objects included', async () => {
    p = page(HTML + '<div class="d"></div>', { pick: () => [photo] });
    p.tap('.pick');
    await settle();
    const FormData = formDataClass((v) => p.host.unwrap(v), (m) => p.host.refuse(m));
    const data = new FormData(p.root.querySelector('.f'));
    expect([...data.entries()]).toEqual([
      ['photo', photo],
      ['title', 'Chair'],
    ]);
    expect(data.get('title')).toBe('Chair');
    data.set('title', 'Table');
    data.append('tag', 7);
    expect(data.getAll('tag')).toEqual(['7']);
    expect(data.get('title')).toBe('Table');
    expect(() => new FormData(p.root.querySelector('.d'))).toThrow(/new FormData/);
  });

  it('reports an answer that is not a list, and a select answered with a list', async () => {
    p = page(HTML + '<select class="s"><option>a</option><option>b</option></select>', { pick: (r) => (r.kind === 'file' ? 'nope' : ['b']) });
    p.tap('.pick');
    p.tap('.s');
    await settle();
    expect(p.errors.map((e) => String(e.error))).toEqual([
      expect.stringMatching(/not a list of files/),
      expect.stringMatching(/not a value/),
    ]);
  });
});
