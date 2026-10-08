import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AiroEvent, noopSink, resetSink, setSink } from '@airo-js/log';

import { LynxRefusalError, UnmappedElementError } from '../src/runtime/errors.js';
import { installGlobalGuards } from '../src/runtime/facade.js';
import { UnsupportedSelectorError } from '../src/runtime/matcher.js';
import { HtmlParseError } from '../src/runtime/tokenize.js';
import { attrClass } from '../src/shared/attr-class.js';
import { type El, type Page, page } from './harness.js';

let p: Page;
// Refusals are logged at error level; keep expected ones out of the test output.
beforeEach(() => setSink(noopSink));
afterEach(() => {
  p?.fake.uninstall();
  resetSink();
});

const classesOf = (selector: string): string[] => p.native(selector).classes.split(' ');

describe('queries, answered from the node model', () => {
  const HTML = '<section class="list"><ul><li class="item" data-id="1"><a href="/a">A</a></li><li class="item on" data-id="2">B</li></ul></section><p id="x">p</p>';

  it('querySelector / All with type, class, id, attribute, descendant and child', () => {
    p = page(HTML);
    expect(p.root.querySelector('.item.on').textContent).toBe('B');
    expect(p.root.querySelector('[data-id="2"]').textContent).toBe('B');
    expect(p.root.querySelector('[data-id="1"] a').getAttribute('href')).toBe('/a');
    expect(p.root.querySelector('#x').tagName).toBe('P');
    expect(p.root.querySelectorAll('ul > li').length).toBe(2);
    expect(p.root.querySelectorAll('section li, p').map((e: El) => e.tagName)).toEqual(['LI', 'LI', 'P']);
    expect(p.root.querySelector('.missing')).toBeNull();
  });

  it('hands out one object per element, so identity comparisons hold', () => {
    p = page(HTML);
    expect(p.root.querySelector('.on')).toBe(p.root.querySelectorAll('.item')[1]);
    expect(p.root.querySelector('a').parentElement).toBe(p.root.querySelector('li'));
  });

  it('closest, matches and contains', () => {
    p = page(HTML);
    const a = p.root.querySelector('a');
    expect(a.closest('.item')).toBe(p.root.querySelector('.item'));
    expect(a.closest('.nope')).toBeNull();
    expect(a.matches('.list a')).toBe(true);
    expect(p.root.contains(a)).toBe(true);
    expect(a.contains(p.root)).toBe(false);
    expect(p.root.contains({})).toBe(false);
  });

  it('refuses a selector it does not support, by name, and reports it', () => {
    p = page(HTML);
    expect(() => p.root.querySelector('li:first-child')).toThrow(UnsupportedSelectorError);
    expect(() => p.root.querySelector('li + li')).toThrow(/sibling combinator/);
    expect(() => p.root.querySelector('[href^="/"]')).toThrow(/attribute operator/);
    expect(p.errors.map((e) => e.member)).toEqual(['selector "li:first-child"', 'selector "li + li"', 'selector "[href^="/"]"']);
  });
});

describe('attributes: every write keeps the mirror classes in step (D8)', () => {
  const writes: [string, (el: El) => void, string, boolean][] = [
    ['setAttribute', (el) => el.setAttribute('aria-pressed', 'true'), attrClass('aria-pressed', 'true')!, true],
    ['setAttribute (change)', (el) => el.setAttribute('data-state', 'closed'), attrClass('data-state', 'closed')!, true],
    ['setAttribute drops the old value class', (el) => el.setAttribute('data-state', 'closed'), attrClass('data-state', 'open')!, false],
    ['removeAttribute', (el) => el.removeAttribute('data-state'), attrClass('data-state'), false],
    ['toggleAttribute on', (el) => el.toggleAttribute('open'), attrClass('open'), true],
    ['toggleAttribute off', (el) => el.toggleAttribute('data-state', false), attrClass('data-state'), false],
    ['hidden = true', (el) => { el.hidden = true; }, attrClass('hidden'), true],
    ['disabled = true', (el) => { el.disabled = true; }, attrClass('disabled'), true],
    ['dataset.mode = …', (el) => { el.dataset.mode = 'dark'; }, attrClass('data-mode', 'dark')!, true],
    ['delete dataset.state', (el) => { delete el.dataset.state; }, attrClass('data-state'), false],
    ['classList.add', (el) => el.classList.add('is-on'), 'is-on', true],
    ['classList.toggle off', (el) => el.classList.toggle('chip', false), 'chip', false],
    ['className =', (el) => { el.className = 'other'; }, 'other', true],
    ['id =', (el) => { el.id = 'z'; }, attrClass('id'), false],
  ];

  it.each(writes)('%s', (_label, write, cls, present) => {
    p = page('<button class="chip" data-state="open" type="button">x</button>');
    write(p.root.querySelector('button'));
    expect(classesOf('button').includes(cls)).toBe(present);
  });

  it('hidden reads the attribute, and un-hiding removes the class', () => {
    p = page('<div class="d" hidden></div>');
    const d = p.root.querySelector('.d');
    expect(d.hidden).toBe(true);
    d.hidden = false;
    expect(d.hasAttribute('hidden')).toBe(false);
    expect(classesOf('.d')).not.toContain('a-hidden');
  });

  it('dataset reads data-* as camelCase', () => {
    p = page('<div data-invite-url="/x" data-n="2"></div>');
    const d = p.root.querySelector('div');
    expect(d.dataset.inviteUrl).toBe('/x');
    expect(Object.keys(d.dataset)).toEqual(['inviteUrl', 'n']);
    expect('n' in d.dataset).toBe(true);
  });

  it('an attribute inside an svg updates the svg content', () => {
    p = page('<svg class="i"><path d="M1"/></svg>');
    p.root.querySelector('svg').setAttribute('stroke', 'red');
    expect(p.native('svg').attrs.content).toBe('<svg class="i" stroke="red"><path d="M1"/></svg>');
  });
});

describe('content', () => {
  it('textContent re-projects the element', () => {
    p = page('<p class="price">€1</p>');
    p.root.querySelector('.price').textContent = '€2';
    expect(p.fake.render(p.native('.price'))).toBe('text.price.tag-p("€2")');
  });

  it('a hundred writes in one handler cost one flush', async () => {
    p = page('<p class="clock">0</p>');
    await Promise.resolve();
    const before = p.fake.flushes;
    const clock = p.root.querySelector('.clock');
    for (let i = 1; i <= 100; i++) clock.textContent = String(i);
    expect(p.fake.flushes).toBe(before);
    await Promise.resolve();
    expect(p.fake.flushes).toBe(before + 1);
    expect(clock.textContent).toBe('100');
  });

  it('innerHTML parses through the tokenizer and reads back', () => {
    p = page('<div class="box"></div>');
    const box = p.root.querySelector('.box');
    box.innerHTML = '<p class="n">Hi &amp; bye</p>';
    expect(box.innerHTML).toBe('<p class="n">Hi &amp; bye</p>');
    expect(box.querySelector('.n').textContent).toBe('Hi & bye');
    expect(p.fake.render(p.native('.box'))).toBe('view.box.tag-div(text.n.tag-p("Hi & bye"))');
  });

  it('insertAdjacentHTML in all four positions', () => {
    p = page('<ul class="l"><li class="m">m</li></ul>');
    const m = p.root.querySelector('.m');
    m.insertAdjacentHTML('beforebegin', '<li>a</li>');
    m.insertAdjacentHTML('afterend', '<li>z</li>');
    m.insertAdjacentHTML('afterbegin', '<b>[</b>');
    m.insertAdjacentHTML('beforeend', '<b>]</b>');
    expect(p.root.querySelector('.l').textContent).toBe('a[m]z');
  });

  it('markup it cannot build is refused with the page unchanged', () => {
    p = page('<div class="box"><p>kept</p></div>');
    const box = p.root.querySelector('.box');
    expect(() => {
      box.innerHTML = 'a&nbsp;b';
    }).toThrow(HtmlParseError);
    expect(() => {
      box.innerHTML = '<video></video>';
    }).toThrow(UnmappedElementError);
    expect(box.textContent).toBe('kept');
    expect(p.errors).toHaveLength(2);
  });

  it('value is mirrored for controls and pushed with setValue after the flush', async () => {
    p = page('<input class="q" name="q" value="a"><data class="n" value="3">3</data>');
    const q = p.root.querySelector('.q');
    expect(q.value).toBe('a');
    q.value = 'typed';
    expect(q.value).toBe('typed');
    expect(p.native('.q').uiCalls).toEqual([]);
    await Promise.resolve();
    expect(p.native('.q').uiCalls).toEqual([{ method: 'setValue', params: { value: 'typed' } }]);
    expect(p.root.querySelector('.n').value).toBe('3');
  });
});

describe('refusals', () => {
  it('names the member, logs it, reports it and throws', () => {
    const events: AiroEvent[] = [];
    setSink({ emit: (e) => events.push(e) });
    p = page('<div class="d"></div>');
    const d = p.root.querySelector('.d');
    expect(() => d.getBoundingClientRect()).toThrow(LynxRefusalError);
    expect(() => d.showModal()).toThrow(/<div>\.showModal\(\) is not available on device/);
    expect(() => {
      d.style.color = 'red';
    }).toThrow(/Element\.style/);
    expect(() => {
      d.onclick = () => {};
    }).toThrow(/setting Element\.onclick/);
    expect(p.errors.map((e) => e.member)).toEqual(['Element.getBoundingClientRect', '<div>.showModal()', 'Element.style', 'setting Element.onclick']);
    expect(events.filter((e) => e.level === 'error' && e.channel === 'lynx')).toHaveLength(4);
  });

  it('refuses event types the device never delivers, and capture listeners', () => {
    p = page('<div></div>');
    expect(() => p.root.addEventListener('keydown', () => {})).toThrow(/addEventListener\("keydown"\)/);
    expect(() => p.root.addEventListener('click', () => {}, true)).toThrow(/capture/);
  });

  it('`value` on an element without one is refused', () => {
    p = page('<div class="d"></div>');
    expect(() => p.root.querySelector('.d').value).toThrow(/<div>\.value/);
  });

  it('is invisible to introspection: thenables, JSON and symbols do not trip it', async () => {
    p = page('<div class="d"></div>');
    const d = p.root.querySelector('.d');
    expect(await Promise.resolve(d)).toBe(d);
    expect(JSON.stringify({ d: 1 })).toBe('{"d":1}');
    expect(String(d)).toContain('LynxFacadeElement <div>');
    expect(p.errors).toHaveLength(0);
  });
});

describe('events', () => {
  it('a tap is a click that bubbles from the tapped element, target first', () => {
    p = page('<div class="card"><button class="b" type="button"><svg></svg>Go</button></div>');
    const seen: string[] = [];
    const button = p.root.querySelector('.b');
    button.addEventListener('click', (e: El) => seen.push(`button target=${e.target.tagName} current=${e.currentTarget.tagName}`));
    p.root.addEventListener('click', (e: El) => seen.push(`root target=${e.target.tagName} current=${e.currentTarget === p.root}`));
    p.tap('.b', 1); // the text wrapper of "Go" maps to the button
    expect(seen).toEqual(['button target=BUTTON current=BUTTON', 'root target=BUTTON current=true']);
  });

  it('stopPropagation, once and removeEventListener behave as in a browser', () => {
    p = page('<div class="card"><button class="b" type="button">Go</button></div>');
    const root = vi.fn();
    const once = vi.fn();
    const removed = vi.fn();
    const button = p.root.querySelector('.b');
    button.addEventListener('click', (e: El) => e.stopPropagation());
    button.addEventListener('click', once, { once: true });
    button.addEventListener('click', removed);
    button.removeEventListener('click', removed);
    p.root.addEventListener('click', root);
    p.tap('.b');
    p.tap('.b');
    expect(root).not.toHaveBeenCalled();
    expect(once).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('a listener that throws is reported and the next one still runs', () => {
    p = page('<button class="b" type="button">Go</button>');
    const after = vi.fn();
    p.root.querySelector('.b').addEventListener('click', () => {
      throw new Error('boom');
    });
    p.root.addEventListener('click', after);
    p.tap('.b');
    expect(after).toHaveBeenCalled();
    expect(p.errors).toEqual([expect.objectContaining({ phase: 'event', error: expect.objectContaining({ message: 'boom' }) })]);
  });

  it('a delegation helper written for the browser works unchanged', () => {
    p = page('<ul class="list"><li><button class="del" data-id="7" type="button">x</button></li></ul>');
    const on = (root: El, type: string, selector: string, fn: (e: El, t: El) => void) => {
      const listener = (event: El) => {
        const target = event.target?.closest(selector);
        if (target && root.contains(target)) fn(event, target);
      };
      root.addEventListener(type, listener);
      return () => root.removeEventListener(type, listener);
    };
    const hits: string[] = [];
    on(p.root, 'click', '[data-id]', (_e, t) => hits.push(t.dataset.id));
    p.tap('.del');
    expect(hits).toEqual(['7']);
  });
});

describe('input and change (D14)', () => {
  it('input fires per edit; change once, on blur, only when the value changed', () => {
    p = page('<input class="q" name="q" value="">');
    const log: string[] = [];
    for (const type of ['focus', 'input', 'change', 'blur']) p.root.querySelector('.q').addEventListener(type, (e: El) => log.push(`${type}:${e.target.value}`));
    p.root.addEventListener('input', () => log.push('root input'));
    p.root.addEventListener('change', () => log.push('root change'));
    const native = p.native('.q');
    p.fake.fire(native, 'focus', { value: '' });
    p.fake.fire(native, 'input', { value: 'a' });
    p.fake.fire(native, 'input', { value: 'ab' });
    p.fake.fire(native, 'blur', { value: 'ab' });
    p.fake.fire(native, 'focus', { value: 'ab' });
    p.fake.fire(native, 'blur', { value: 'ab' });
    expect(log).toEqual([
      'focus:',
      'input:a',
      'root input',
      'input:ab',
      'root input',
      'change:ab',
      'root change',
      'blur:ab',
      'focus:ab',
      'blur:ab',
    ]);
  });

  it('confirm commits the change, and the blur after it does not repeat it', () => {
    p = page('<input class="q" name="q">');
    const change = vi.fn();
    p.root.addEventListener('change', change);
    const native = p.native('.q');
    p.fake.fire(native, 'focus', { value: '' });
    p.fake.fire(native, 'input', { value: 'x' });
    p.fake.fire(native, 'confirm', { value: 'x' });
    p.fake.fire(native, 'blur', { value: 'x' });
    expect(change).toHaveBeenCalledTimes(1);
  });
});

describe('rollback (O5)', () => {
  it('removes the listeners a recording saw added', () => {
    p = page('<div class="a"></div>');
    p.root.addEventListener('click', () => {});
    const recording = p.host.record();
    p.root.addEventListener('click', () => {});
    p.root.querySelector('.a').addEventListener('input', () => {});
    expect(p.host.listenerCount()).toBe(3);
    p.host.rollback(recording);
    expect(p.host.listenerCount()).toBe(1);
  });
});

describe('browser globals', () => {
  it('a missing global refuses every use by name; the engine’s own globals are left alone', () => {
    p = page('<div></div>');
    const scope: Record<string, unknown> = { setTimeout: () => 0 };
    const undo = installGlobalGuards(p.host, scope);
    const win = scope.window as El;
    expect(typeof win).toBe('function');
    expect(() => win.location.assign('/x')).toThrow(/window\.location is not available on device/);
    expect(() => (scope.localStorage as El).getItem('k')).toThrow(/localStorage\.getItem/);
    expect(() => new (scope.IntersectionObserver as El)(() => {})).toThrow(/new IntersectionObserver\(\)/);
    expect(() => (scope.fetch as El)('/x')).toThrow(/fetch\(\)/);
    expect(typeof scope.setTimeout).toBe('function');
    expect(() => (scope.setTimeout as () => number)()).not.toThrow();
    undo();
    expect('window' in scope).toBe(false);
  });
});
