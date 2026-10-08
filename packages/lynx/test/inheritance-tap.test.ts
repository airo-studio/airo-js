/**
 * The tap reaches into an internal chain name of a 0.1.x package. These
 * tests are the guard: patched when the name is there, a failed build when
 * it is not, and a failed build when a bundle still says `false`.
 */

import { describe, expect, it } from 'vitest';

import {
  assertInheritanceInBundles,
  type ChainLike,
  InheritanceTapError,
  tapCssInheritance,
} from '../src/build/inheritance-tap.js';

/** A chain with the given plugin names; records what each tap returns. */
function fakeChain(names: string[]): ChainLike & { args: Map<string, unknown[]> } {
  const args = new Map<string, unknown[]>(names.map((n) => [n, [{ targetSdkVersion: '3.9' }, 'second']]));
  return {
    args,
    plugins: { store: new Map(names.map((n) => [n, {}])) },
    plugin: (name) => ({
      tap(fn) {
        args.set(name, fn(args.get(name)!));
        return undefined;
      },
    }),
  };
}

describe('tapCssInheritance', () => {
  it('sets the flag on every vanilla template plugin and keeps their other options', () => {
    const chain = fakeChain(['lynx:vanilla:template:main', 'lynx:vanilla:template:card', 'lynx:encode']);
    expect(tapCssInheritance(chain, 'lynx')).toBe(2);
    expect(chain.args.get('lynx:vanilla:template:main')).toEqual([
      { targetSdkVersion: '3.9', enableCSSInheritance: true },
      'second',
    ]);
    expect(chain.args.get('lynx:encode')).toEqual([{ targetSdkVersion: '3.9' }, 'second']);
  });

  it('passes a custom inheritance list through', () => {
    const chain = fakeChain(['lynx:vanilla:template:main']);
    tapCssInheritance(chain, 'lynx', { customCSSInheritanceList: ['text-align'] });
    expect(chain.args.get('lynx:vanilla:template:main')![0]).toMatchObject({ customCSSInheritanceList: ['text-align'] });
  });

  it('fails the build when the chain entry is gone (renamed upstream, or no vanilla plugin)', () => {
    const chain = fakeChain(['lynx:template:main', 'lynx:encode']);
    expect(() => tapCssInheritance(chain, 'lynx')).toThrow(InheritanceTapError);
    expect(() => tapCssInheritance(chain, 'lynx')).toThrow(/lynx:template:main, lynx:encode/);
  });
});

describe('assertInheritanceInBundles', () => {
  const bundle = (flag: boolean): string => `\u0000tasm{"pageConfig":{"enableCSSInheritance":${flag},"x":1}}`;

  it('passes when every bundle with a page config carries true', () => {
    expect(
      assertInheritanceInBundles([
        { name: 'main.lynx.bundle', source: Buffer.from(bundle(true), 'latin1') },
        { name: 'main.web.bundle', source: '{"no":"config"}' },
        { name: 'background.js', source: '"enableCSSInheritance":false' },
      ]),
    ).toEqual(['main.lynx.bundle']);
  });

  it('fails naming the bundle that still says false', () => {
    expect(() =>
      assertInheritanceInBundles([
        { name: 'main.lynx.bundle', source: bundle(true) },
        { name: 'main.web.bundle', source: bundle(false) },
      ]),
    ).toThrow(/off in main\.web\.bundle/);
  });

  it('fails when bundles were emitted and none carries the flag', () => {
    expect(() => assertInheritanceInBundles([{ name: 'main.lynx.bundle', source: 'binary' }])).toThrow(InheritanceTapError);
  });

  it('is silent when nothing was emitted, as in a failed compile', () => {
    expect(assertInheritanceInBundles([])).toEqual([]);
  });
});
