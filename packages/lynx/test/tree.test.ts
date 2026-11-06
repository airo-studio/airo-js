import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnmappedElementError } from '../src/runtime/errors.js';
import { fromParsed, insertChildren, LynxElement, LynxText } from '../src/runtime/node-model.js';
import { getPapi } from '../src/runtime/papi.js';
import { NativeTree, resolveUrl } from '../src/runtime/tree.js';
import { tokenize } from '../src/runtime/tokenize.js';
import { type FakeLynx, installFakePapi } from './fake-papi.js';

let fake: FakeLynx;

function build(html: string, baseUrl = 'https://shop.example/a/b') {
  fake = installFakePapi();
  const papi = getPapi();
  const page = papi.createPage('0', 0);
  const onControlEvent = vi.fn();
  const tree = new NativeTree({ papi, pid: papi.uniqueId(page), baseUrl, onControlEvent });
  const root = new LynxElement('div', false);
  const nodes = fromParsed(tokenize(html));
  tree.validate(nodes);
  insertChildren(root, nodes);
  papi.append(page, tree.project(root)!);
  return { tree, root, page: fake.page(), onControlEvent };
}

/** The rendering of the root view's children, without the page and root wrappers. */
const inner = (): string => fake.render(fake.page().children[0]!).replace(/^view\.tag-div\((.*)\)$/, '$1');

afterEach(() => fake?.uninstall());

describe('mapping table', () => {
  it('text-level tags with only text become text', () => {
    build('<h1 class="t">Hello</h1><p>world</p>');
    expect(inner()).toBe('text.t.tag-h1("Hello"), text.tag-p("world")');
  });

  it('inline tags inside running text become nested text', () => {
    build('<p>Pay <strong class="n">€5</strong> now</p>');
    expect(inner()).toBe('text.tag-p("Pay ", text.n.tag-strong("€5"), " now")');
  });

  it('containers become views and their loose text a synthesised text', () => {
    build('<div class="row"><svg viewBox="0 0 1 1"></svg>Label</div>');
    expect(inner()).toBe('view.row.tag-div(svg.airo-lynx-empty.tag-svg.a-viewbox, text("Label"))');
  });

  it('a text tag with a block or an svg inside becomes a view', () => {
    build('<p class="meta"><svg></svg>Lisbon</p>');
    expect(inner()).toBe('view.meta.tag-p(svg.airo-lynx-empty.tag-svg, text("Lisbon"))');
  });

  it('a and button outside running text are views', () => {
    build('<a href="/x">Go</a><button type="submit">Join</button>');
    expect(inner()).toBe('view.tag-a.a-href.a-href--_2f_x(text("Go")), view.tag-button.a-type.a-type--submit(text("Join"))');
  });

  it('img becomes image, its src resolved against the base url', () => {
    build('<img src="/img/a.jpg" alt="A chair">');
    const image = fake.byClass('tag-img');
    expect(image.tag).toBe('image');
    expect(image.attrs).toMatchObject({ src: 'https://shop.example/img/a.jpg', mode: 'scaleToFill', 'accessibility-label': 'A chair' });
  });

  it('svg becomes svg with its own markup as content', () => {
    build('<svg class="i" viewBox="0 0 24 24" stroke="currentColor"><path d="M1 2"/><circle r="3"></circle></svg>');
    expect(fake.byClass('i').attrs.content).toBe(
      '<svg class="i" viewBox="0 0 24 24" stroke="currentColor"><path d="M1 2"/><circle r="3"/></svg>',
    );
  });

  it('text inputs and textareas become controls with their value and listeners', () => {
    const { onControlEvent } = build('<input type="email" name="e" value="a@b.c" placeholder="Email"><textarea name="t">Hi &amp; bye</textarea>');
    const input = fake.byClass('tag-input');
    expect(input.tag).toBe('input');
    expect(input.attrs).toMatchObject({ type: 'email', placeholder: 'Email', 'default-value': 'a@b.c', disabled: false });
    expect([...input.listeners.keys()].sort()).toEqual(['blur', 'confirm', 'focus', 'input']);
    expect(fake.byClass('tag-textarea').attrs['default-value']).toBe('Hi & bye');
    fake.fire(input, 'input', { value: 'x' });
    expect(onControlEvent).toHaveBeenCalledWith(expect.objectContaining({ tag: 'input' }), 'input', expect.anything());
  });

  it('hidden inputs, scripts and templates stay in the model only', () => {
    const { root } = build('<form><input type="hidden" name="code" value="X"><script type="application/ld+json">{}</script><button>Go</button></form>');
    expect(inner()).toBe('view.tag-form(view.tag-button(text("Go")))');
    expect(root.children[0]!.kind === 'element' && root.children[0].children.length).toBe(3);
  });

  it('refuses an element it has no mapping for, by name', () => {
    expect(() => build('<div><video src="a.mp4"></video></div>')).toThrow(UnmappedElementError);
    expect(() => build('<select multiple></select>')).toThrow(/<select multiple>/);
    expect(() => build('<select size="4"></select>')).toThrow(/<select size="4">/);
    expect(() => build('<input type="range">')).toThrow(/input type="range"/);
  });

  it('refuses a relative src with no base url', () => {
    expect(() => build('<img src="a.png">', '')).toThrow(/needs mountLynx's baseUrl/);
  });
});

describe('the viewport', () => {
  it('is a vertical scroll-view carrying the viewport class, and stays one when re-projected', () => {
    fake = installFakePapi();
    const papi = getPapi();
    const page = papi.createPage('0', 0);
    const tree = new NativeTree({ papi, pid: papi.uniqueId(page), onControlEvent: () => {} });
    const root = new LynxElement('div', false);
    insertChildren(root, fromParsed(tokenize('<p>a</p>')));
    tree.viewport = root;
    papi.append(page, tree.project(root)!);
    const scroller = fake.page().children[0]!;
    expect(scroller.tag).toBe('scroll-view');
    expect(scroller.attrs['scroll-orientation']).toBe('vertical');
    expect(scroller.classes.split(' ')).toContain('airo-lynx-viewport');
    root.children = [];
    insertChildren(root, [new LynxText('b')]);
    tree.reproject(root);
    expect(fake.render()).toBe('page(scroll-view.airo-lynx-viewport.tag-div(text("b")))');
  });
});

describe('whitespace', () => {
  it('collapses runs and trims the edges of running text, as a browser lays it out', () => {
    build('<p>\n   Hello \n  <em>you</em>   there\n</p>');
    expect(inner()).toBe('text.tag-p("Hello ", text.tag-em("you"), " there")');
  });

  it('drops whitespace-only text between blocks', () => {
    build('<div>\n  <p>a</p>\n  <p>b</p>\n</div>');
    expect(inner()).toBe('view.tag-div(text.tag-p("a"), text.tag-p("b"))');
  });

  it('keeps <pre> text as written, less the newline straight after the tag, inline tags included', () => {
    build('<pre class="code">\nmount({\n  fetch,   <b>x</b>\n})</pre>');
    expect(inner()).toBe('text.code.tag-pre("mount({\\n  fetch,   ", text.tag-b("x"), "\\n})")');
  });

  it('turns <br> in running text into a line break', () => {
    build('<p>a<br>b</p>');
    expect(inner()).toBe('text.tag-p("a", "\\n", "b")');
  });
});

describe('mirror classes', () => {
  it('every element carries its tag class and one class per attribute', () => {
    build('<div class="card" data-state="open" hidden aria-pressed="true" id="c1"></div>');
    const el = fake.byClass('card');
    expect(el.classes).toBe(
      'airo-lynx-empty card tag-div a-data-state a-data-state--open a-hidden a-hidden-- a-aria-pressed a-aria-pressed--true',
    );
    expect(el.id).toBe('c1');
  });
});

describe('keeping in step', () => {
  it('re-projects a changed element in place, keeping its siblings', () => {
    const { tree, root } = build('<div class="a"><p>one</p></div><div class="b"></div>');
    const a = root.children[0] as LynxElement;
    const oldRef = a.ref;
    a.children = [];
    insertChildren(a, [new LynxText('two')]);
    tree.reproject(a);
    expect(a.ref).not.toBe(oldRef);
    expect(inner()).toBe('view.a.tag-div(text("two")), view.airo-lynx-empty.b.tag-div');
  });

  it('re-projects from the outermost text when inline content changes', () => {
    const { tree, root } = build('<p>Total <span class="n">1</span></p>');
    const span = (root.children[0] as LynxElement).children[1] as LynxElement;
    span.children = [];
    insertChildren(span, [new LynxText('2')]);
    tree.reproject(span);
    expect(inner()).toBe('text.tag-p("Total ", text.n.tag-span("2"))');
  });

  it('changes kind when content changes: a text that gains a block becomes a view', () => {
    const { tree, root } = build('<li>plain</li>');
    const li = root.children[0] as LynxElement;
    li.children = [];
    insertChildren(li, fromParsed(tokenize('<div>block</div>')));
    tree.reproject(li);
    expect(inner()).toBe('view.tag-li(view.tag-div(text("block")))');
  });

  it('maps every Lynx element it creates back to its model element, text wrappers included', () => {
    const { tree, root } = build('<button class="b"><svg></svg>Join</button>');
    const button = root.children[0] as LynxElement;
    const wrapper = fake.byClass('b').children[1]!;
    expect(tree.byUid.get(wrapper.uid)).toBe(button);
    tree.reproject(button);
    expect(tree.byUid.has(wrapper.uid)).toBe(false);
  });

  it('flushes once per task, however many changes', async () => {
    const { tree, root } = build('<p class="x">a</p>');
    const before = fake.flushes;
    for (let i = 0; i < 50; i++) tree.reproject(root.children[0] as LynxElement);
    expect(fake.flushes).toBe(before);
    await Promise.resolve();
    expect(fake.flushes).toBe(before + 1);
  });
});

describe('resolveUrl', () => {
  it.each([
    ['https://cdn.example/x.png', 'https://cdn.example/x.png'],
    ['//cdn.example/x.png', 'https://cdn.example/x.png'],
    ['/img/x.png', 'https://shop.example/img/x.png'],
    ['x.png', 'https://shop.example/a/x.png'],
    ['?v=2', 'https://shop.example/a/b?v=2'],
  ])('%s', (href, expected) => {
    expect(resolveUrl(href, 'https://shop.example/a/b')).toBe(expected);
  });
});
