/** A page built from HTML over the fake PAPI, with the facade wired as `mountLynx` wires it. */

import { vi } from 'vitest';

import type { LynxErrorInfo } from '../src/runtime/errors.js';
import { FacadeHost } from '../src/runtime/facade.js';
import type { NavigateRequest } from '../src/runtime/navigation.js';
import { fromParsed, insertChildren, LynxElement } from '../src/runtime/node-model.js';
import { getPapi } from '../src/runtime/papi.js';
import { NativeTree } from '../src/runtime/tree.js';
import { tokenize } from '../src/runtime/tokenize.js';
import { type FakeElement, type FakeLynx, installFakePapi } from './fake-papi.js';

/** The DOM-shaped surface tests drive the facade through. */
// biome-ignore lint/suspicious/noExplicitAny: the facade is a Proxy standing in for HTMLElement
export type El = any;

export interface Page {
  fake: FakeLynx;
  tree: NativeTree;
  host: FacadeHost;
  model: LynxElement;
  root: El;
  navigate: ReturnType<typeof vi.fn<(r: NavigateRequest) => void>>;
  errors: LynxErrorInfo[];
  /** The fake Lynx element for a model element found by selector. */
  native(selector: string): FakeElement;
  /** Tap the Lynx element standing for the first match of `selector` (or one of its text wrappers). */
  tap(selector: string, child?: number): void;
}

export function page(html: string): Page {
  const fake = installFakePapi();
  const papi = getPapi();
  const pageRef = papi.createPage('0', 0);
  const errors: LynxErrorInfo[] = [];
  const navigate = vi.fn<(r: NavigateRequest) => void>();
  let host!: FacadeHost;
  const tree = new NativeTree({
    papi,
    pid: papi.uniqueId(pageRef),
    baseUrl: 'https://shop.example/',
    onControlEvent: (el, event, native) => host.onControlEvent(el, event, native),
  });
  host = new FacadeHost({ tree, reporter: (info) => errors.push(info), navigate });
  papi.addEventListener(pageRef, 'tap', (e) => host.onTap(e));
  const model = new LynxElement('div', false);
  insertChildren(model, fromParsed(tokenize(html)));
  papi.append(pageRef, tree.project(model)!);
  const root = host.facade(model) as El;

  const modelOf = (selector: string): LynxElement => {
    const el = host.unwrap(root.querySelector(selector));
    if (!el) throw new Error(`harness: nothing matches ${selector}`);
    return el;
  };
  const native = (selector: string): FakeElement => {
    const el = modelOf(selector);
    const hit = fake.all().find((n) => tree.byUid.get(n.uid) === el && n.uid === el.uids[0]);
    if (!hit) throw new Error(`harness: ${selector} is not on screen`);
    return hit;
  };
  return {
    fake,
    tree,
    host,
    model,
    root,
    navigate,
    errors,
    native,
    tap(selector, child) {
      const n = native(selector);
      fake.tap(child === undefined ? n : n.children[child]!);
    },
  };
}
