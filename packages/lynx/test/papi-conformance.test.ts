/**
 * The tree pass against `@lynx-js/testing-environment`, Lynx's own
 * JavaScript implementation of Element PAPI: every call the projection makes
 * must be one the reference accepts, and the tree it builds there must be
 * the tree the fake PAPI (which the other suites use) records. The reference
 * has no `__AddEventListener`, `__RemoveEventListener` or `__InvokeUIMethod`,
 * so those three are stubbed here and exercised against the fake.
 */

import { readFileSync } from 'node:fs';

import { LynxTestingEnv } from '@lynx-js/testing-environment';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { fromParsed, insertChildren, LynxElement } from '../src/runtime/node-model.js';
import { getPapi } from '../src/runtime/papi.js';
import { NativeTree } from '../src/runtime/tree.js';
import { tokenize } from '../src/runtime/tokenize.js';
import { installFakePapi } from './fake-papi.js';

const g = globalThis as unknown as Record<string, unknown>;
const STUBBED = ['__AddEventListener', '__RemoveEventListener', '__InvokeUIMethod'];

function project(html: string): { page: unknown } {
  const papi = getPapi();
  const page = papi.createPage('0', 0);
  const tree = new NativeTree({ papi, pid: papi.uniqueId(page), baseUrl: 'https://shop.example/', onControlEvent: () => {} });
  const root = new LynxElement('div', false);
  const nodes = fromParsed(tokenize(html));
  tree.validate(nodes);
  insertChildren(root, nodes);
  papi.append(page, tree.project(root)!);
  papi.flush();
  return { page };
}

interface DomLike {
  nodeType: number;
  localName: string;
  textContent: string;
  childNodes: ArrayLike<DomLike>;
  getAttribute(name: string): string | null;
}

/** The reference tree in the fake's rendering: `view.a(text("hi"))`. */
function renderReference(el: DomLike): string {
  if (el.nodeType === 3) return JSON.stringify(el.textContent);
  if (el.localName === 'raw-text') return JSON.stringify(el.getAttribute('text') ?? el.textContent);
  const cls = el.getAttribute('class');
  const children = Array.from(el.childNodes).filter((c) => c.nodeType === 1 || c.nodeType === 3);
  return `${el.localName}${cls ? `.${cls.split(' ').join('.')}` : ''}${children.length ? `(${children.map(renderReference).join(', ')})` : ''}`;
}

afterEach(() => {
  for (const name of [...STUBBED, '__CreatePage']) delete g[name];
});

describe('the tree pass on the Lynx reference PAPI', () => {
  it.each(['invite.html', 'example-home.html', 'example-essay.html', 'example-members.html'])(
    '%s builds the same element tree as the fake records',
    (fixture) => {
      const html = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8');

      const fake = installFakePapi();
      project(html);
      const expected = fake.render();
      fake.uninstall();
      // Not two empty pages agreeing: the fixture's text made it into the tree.
      expect(fake.all().length).toBeGreaterThan(5);

      const env = new LynxTestingEnv({ window: new JSDOM().window } as ConstructorParameters<typeof LynxTestingEnv>[0]);
      g.lynxTestingEnv = env;
      env.switchToMainThread();
      for (const name of STUBBED) g[name] ??= () => [];
      const { page } = project(html);
      expect(renderReference(page as DomLike)).toBe(expected);
    },
  );
});
