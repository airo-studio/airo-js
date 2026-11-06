/**
 * A stand-in for the Lynx main thread: the Element PAPI globals the runtime
 * calls, over a plain tree a test can read. `@lynx-js/testing-environment`
 * implements element creation but not `__AddEventListener`, so it cannot
 * drive taps or input events; `papi-conformance.test.ts` runs the tree pass
 * against it for what it does implement.
 */

export interface FakeElement {
  uid: number;
  tag: string;
  classes: string;
  id: string | null;
  attrs: Record<string, unknown>;
  children: FakeElement[];
  parent: FakeElement | null;
  /** Raw text elements only. */
  text?: string;
  /** What `__SetInlineStyles` set last. */
  style?: string;
  listeners: Map<string, Set<(event: unknown) => void>>;
  uiCalls: { method: string; params: Record<string, unknown> }[];
}

export interface FakeLynx {
  readonly flushes: number;
  /** The page element (created by the runtime). */
  page(): FakeElement;
  /** Tap `el`: a Lynx tap event bubbling from `el` to the page through native listeners. */
  tap(el: FakeElement): void;
  /** Fire a native control event (`input`, `focus`, `blur`, `confirm`) on `el`. */
  fire(el: FakeElement, name: string, detail?: Record<string, unknown>): void;
  /** Every element below (and including) `root`, depth first. */
  all(root?: FakeElement): FakeElement[];
  /** The first element whose classes include `cls`. */
  byClass(cls: string, root?: FakeElement): FakeElement;
  /** A compact rendering of the tree: `view.a(text("hi"))`. */
  render(root?: FakeElement): string;
  uninstall(): void;
}

const NAMES = [
  '__CreatePage', '__GetElementUniqueID', '__CreateView', '__CreateScrollView', '__CreateText', '__CreateRawText', '__CreateImage',
  '__CreateElement', '__AppendElement', '__InsertElementBefore', '__RemoveElement', '__ReplaceElement',
  '__SetClasses', '__SetID', '__SetAttribute', '__SetInlineStyles', '__AddEventListener', '__RemoveEventListener',
  '__InvokeUIMethod', '__FlushElementTree',
];

/**
 * `layout`, when given, answers `__GetComputedStyleByKey` (a laid-out size or
 * colour as the engine reports it); without it the global is absent, as the
 * runtime must also cope with.
 */
export function installFakePapi(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  layout?: (el: FakeElement, key: string) => string,
): FakeLynx {
  let uid = 0;
  let flushes = 0;
  let page: FakeElement | null = null;
  const make = (tag: string, text?: string): FakeElement => ({
    uid: ++uid,
    tag,
    classes: '',
    id: null,
    attrs: {},
    children: [],
    parent: null,
    ...(text !== undefined ? { text } : {}),
    listeners: new Map(),
    uiCalls: [],
  });
  const detach = (el: FakeElement): void => {
    if (!el.parent) return;
    el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = null;
  };
  const api: Record<string, (...args: never[]) => unknown> = {
    __CreatePage: () => (page = make('page')),
    __GetElementUniqueID: (el: FakeElement) => el.uid,
    __CreateView: () => make('view'),
    __CreateScrollView: () => make('scroll-view'),
    __CreateText: () => make('text'),
    __CreateRawText: (text: string) => make('raw-text', text),
    __CreateImage: () => make('image'),
    __CreateElement: (tag: string) => make(tag),
    __AppendElement: (parent: FakeElement, child: FakeElement) => {
      detach(child);
      child.parent = parent;
      parent.children.push(child);
    },
    __InsertElementBefore: (parent: FakeElement, child: FakeElement, before: FakeElement) => {
      detach(child);
      child.parent = parent;
      parent.children.splice(parent.children.indexOf(before), 0, child);
    },
    __RemoveElement: (parent: FakeElement, child: FakeElement) => {
      if (child.parent !== parent) throw new Error('fake PAPI: remove from the wrong parent');
      detach(child);
    },
    __ReplaceElement: (next: FakeElement, previous: FakeElement) => {
      const parent = previous.parent;
      if (!parent) throw new Error('fake PAPI: replace of a detached element');
      detach(next);
      parent.children[parent.children.indexOf(previous)] = next;
      next.parent = parent;
      previous.parent = null;
    },
    __SetClasses: (el: FakeElement, classes: string) => {
      el.classes = classes;
    },
    __SetID: (el: FakeElement, id: string | null) => {
      el.id = id;
    },
    __SetAttribute: (el: FakeElement, name: string, value: unknown) => {
      el.attrs[name] = value;
    },
    __SetInlineStyles: (el: FakeElement, css: string) => {
      el.style = css;
    },
    __AddEventListener: (el: FakeElement, name: string, fn: (e: unknown) => void) => {
      const set = el.listeners.get(name) ?? new Set();
      set.add(fn);
      el.listeners.set(name, set);
    },
    __RemoveEventListener: (el: FakeElement, name: string, fn: (e: unknown) => void) => {
      el.listeners.get(name)?.delete(fn);
    },
    __InvokeUIMethod: (el: FakeElement, method: string, params: Record<string, unknown>) => {
      el.uiCalls.push({ method, params });
      return [];
    },
    __FlushElementTree: () => {
      flushes++;
    },
  };
  for (const name of NAMES) scope[name] = api[name];
  if (layout) scope.__GetComputedStyleByKey = layout;

  const all = (root: FakeElement): FakeElement[] => [root, ...root.children.flatMap(all)];
  const render = (el: FakeElement): string => {
    if (el.tag === 'raw-text') return JSON.stringify(el.text);
    const cls = el.classes ? `.${el.classes.split(' ').join('.')}` : '';
    return `${el.tag}${cls}${el.children.length ? `(${el.children.map(render).join(', ')})` : ''}`;
  };

  return {
    get flushes() {
      return flushes;
    },
    page: () => page ?? (() => {
      throw new Error('fake PAPI: no page created');
    })(),
    tap(el) {
      for (let n: FakeElement | null = el; n; n = n.parent) {
        for (const fn of n.listeners.get('tap') ?? []) fn({ type: 'tap', target: { uid: el.uid }, currentTarget: { uid: n.uid }, detail: {} });
      }
    },
    fire(el, name, detail = {}) {
      for (const fn of el.listeners.get(name) ?? []) fn({ type: name, target: { uid: el.uid }, currentTarget: { uid: el.uid }, detail });
    },
    all: (root) => all(root ?? page!),
    byClass(cls, root) {
      const hit = all(root ?? page!).find((e) => e.classes.split(' ').includes(cls));
      if (!hit) throw new Error(`fake PAPI: no element with class ${cls}`);
      return hit;
    },
    render: (root) => render(root ?? page!),
    uninstall() {
      for (const name of NAMES) delete scope[name];
      delete scope.__GetComputedStyleByKey;
    },
  };
}
