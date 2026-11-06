/**
 * The mount's `URLSearchParams`, checked against the URL Standard's
 * examples and against Node's own, which is the standard's.
 */

import { describe, expect, it } from 'vitest';

import { MountURLSearchParams } from '../src/runtime/url-search-params.js';

const both = (init: string): [MountURLSearchParams, URLSearchParams] => [new MountURLSearchParams(init), new URLSearchParams(init)];

describe('URLSearchParams', () => {
  it('reads a query as a browser does: leading ?, + as space, percent escapes, a bare name, empty parts', () => {
    for (const query of ['?published', '?a=1&a=2&b=x+y', 'q=caf%C3%A9&&e=&=v', '?bad=%zz%41', 'k=a=b']) {
      const [ours, node] = both(query);
      expect([...ours]).toEqual([...node]);
      expect(ours.toString()).toBe(node.toString());
    }
  });

  it('writes values the way the standard serializer does', () => {
    const ours = new MountURLSearchParams();
    const node = new URLSearchParams();
    for (const [n, v] of [['q', "a b!'()~*-._"], ['é', '1&2=3'], ['plus', '+']]) {
      ours.append(n!, v!);
      node.append(n!, v!);
    }
    expect(ours.toString()).toBe(node.toString());
  });

  it('get, getAll, has, set, delete and sort follow the standard', () => {
    const [ours, node] = both('b=2&a=1&b=3&c=4');
    for (const p of [ours, node]) {
      p.set('b', '9');
      p.delete('c');
      p.append('a', '0');
      p.sort();
    }
    expect([...ours]).toEqual([...node]);
    expect([ours.get('a'), ours.get('zz'), ours.getAll('a'), ours.has('b', '9'), ours.has('b', '2'), ours.size]).toEqual([
      '1',
      null,
      ['1', '0'],
      true,
      false,
      3,
    ]);
  });

  it('takes pairs, a record or another params, and iterates keys, values and forEach', () => {
    expect(new MountURLSearchParams([['a', '1'], ['b', '2']]).toString()).toBe('a=1&b=2');
    expect(new MountURLSearchParams({ a: '1', b: 'x y' }).toString()).toBe('a=1&b=x+y');
    const copy = new MountURLSearchParams(new MountURLSearchParams('a=1'));
    expect([...copy.keys(), ...copy.values()]).toEqual(['a', '1']);
    const seen: string[] = [];
    copy.forEach((v, n) => {
      seen.push(`${n}:${v}`);
    });
    expect(seen).toEqual(['a:1']);
    expect(() => new MountURLSearchParams([['a']] as unknown as [string, string][])).toThrow(TypeError);
  });
});
