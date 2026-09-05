/**
 * Theme — CSS custom properties + a custom-CSS escape hatch.
 *
 * A public 1.0 export with no test until now. Two things carry real risk:
 *
 *   - `destroy()` removing only the keys THIS instance applied. It tracks
 *     them in a Set, so a token removed from a later `apply()` is still
 *     tracked and still cleaned up — but a property the host set itself must
 *     survive, or unmounting a widget vandalises the page around it.
 *   - `customCSS: ''` removing the block rather than writing an empty one,
 *     which is the documented contract and the difference between "reset" and
 *     "leave a dangling <style> behind on every update".
 *
 * The headless invariant applies here too: constructing a Theme and applying
 * nothing must write nothing.
 */

import { beforeEach, describe, expect, test } from 'vitest';

import { Theme } from '../src/theme.js';

let target: HTMLElement;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  target = document.createElement('div');
  document.body.appendChild(target);
});

function customStyles(root: ParentNode = document.head): HTMLStyleElement[] {
  return Array.from(root.querySelectorAll<HTMLStyleElement>('style[data-airo-theme="custom"]'));
}

describe('tokens', () => {
  test('writes each token as a CSS custom property on the target', () => {
    new Theme(target).apply({ tokens: { 'brand-primary': '#f00', 'space-1': '4px' } });

    expect(target.style.getPropertyValue('--brand-primary')).toBe('#f00');
    expect(target.style.getPropertyValue('--space-1')).toBe('4px');
  });

  test('adds the -- prefix when missing and leaves it alone when present', () => {
    new Theme(target).apply({ tokens: { plain: 'a', '--prefixed': 'b' } });

    expect(target.style.getPropertyValue('--plain')).toBe('a');
    expect(target.style.getPropertyValue('--prefixed')).toBe('b');
    expect(target.style.getPropertyValue('----prefixed')).toBe('');
  });

  test('update() merges — untouched tokens survive', () => {
    const theme = new Theme(target);
    theme.apply({ tokens: { a: '1', b: '2' } });
    theme.update({ tokens: { b: 'changed' } });

    expect(target.style.getPropertyValue('--a')).toBe('1');
    expect(target.style.getPropertyValue('--b')).toBe('changed');
  });

  test('an empty token bag writes nothing and throws nothing', () => {
    new Theme(target).apply({ tokens: {} });
    expect(target.getAttribute('style')).toBeFalsy();
  });

  test('writes to the target element, never to document.body or :root', () => {
    new Theme(target).apply({ tokens: { a: '1' } });

    expect(document.body.style.getPropertyValue('--a')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--a')).toBe('');
  });
});

describe('customCSS', () => {
  test('appends a <style> into the style root, tagged for identification', () => {
    new Theme(target).apply({ customCSS: '.x { color: red; }' });

    const styles = customStyles();
    expect(styles).toHaveLength(1);
    expect(styles[0]!.textContent).toBe('.x { color: red; }');
  });

  test('reuses the SAME style element across updates', () => {
    const theme = new Theme(target);
    theme.apply({ customCSS: '.a {}' });
    const first = customStyles()[0];
    theme.update({ customCSS: '.b {}' });

    expect(customStyles()).toHaveLength(1);
    expect(customStyles()[0]).toBe(first);
    expect(customStyles()[0]!.textContent).toBe('.b {}');
  });

  test('an empty string REMOVES the block rather than emptying it', () => {
    const theme = new Theme(target);
    theme.apply({ customCSS: '.a {}' });
    theme.update({ customCSS: '' });

    expect(customStyles()).toHaveLength(0);
  });

  test('an omitted customCSS leaves an existing block alone', () => {
    const theme = new Theme(target);
    theme.apply({ customCSS: '.a {}' });
    theme.update({ tokens: { x: '1' } });

    expect(customStyles()).toHaveLength(1);
  });

  test('appends into an explicit style root — a shadow root', () => {
    const shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });

    new Theme(target, shadow).apply({ customCSS: '.scoped {}' });

    expect(customStyles(shadow)).toHaveLength(1);
    expect(customStyles(document.head)).toHaveLength(0);
  });

  test('two themes with different roots do not collide', () => {
    const shadowHost = document.createElement('div');
    document.body.appendChild(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });

    new Theme(target).apply({ customCSS: '.head {}' });
    new Theme(target, shadow).apply({ customCSS: '.shadow {}' });

    expect(customStyles(document.head)[0]!.textContent).toBe('.head {}');
    expect(customStyles(shadow)[0]!.textContent).toBe('.shadow {}');
  });
});

describe('destroy', () => {
  test('removes every property this instance applied', () => {
    const theme = new Theme(target);
    theme.apply({ tokens: { a: '1', b: '2' } });
    theme.destroy();

    expect(target.style.getPropertyValue('--a')).toBe('');
    expect(target.style.getPropertyValue('--b')).toBe('');
  });

  test('removes tokens applied across SEVERAL applies, not just the last', () => {
    const theme = new Theme(target);
    theme.apply({ tokens: { first: '1' } });
    theme.update({ tokens: { second: '2' } });
    theme.destroy();

    expect(target.style.getPropertyValue('--first')).toBe('');
    expect(target.style.getPropertyValue('--second')).toBe('');
  });

  test('leaves properties the HOST set alone — unmount must not vandalise the page', () => {
    target.style.setProperty('--host-owned', 'keep me');
    const theme = new Theme(target);
    theme.apply({ tokens: { 'theme-owned': 'x' } });
    theme.destroy();

    expect(target.style.getPropertyValue('--host-owned')).toBe('keep me');
    expect(target.style.getPropertyValue('--theme-owned')).toBe('');
  });

  test('removes the custom style element', () => {
    const theme = new Theme(target);
    theme.apply({ customCSS: '.a {}' });
    theme.destroy();

    expect(customStyles()).toHaveLength(0);
  });

  test('is safe to call twice', () => {
    const theme = new Theme(target);
    theme.apply({ tokens: { a: '1' }, customCSS: '.a {}' });
    theme.destroy();

    expect(() => theme.destroy()).not.toThrow();
  });

  test('is safe on a theme that never applied anything', () => {
    expect(() => new Theme(target).destroy()).not.toThrow();
  });

  test('a theme can be re-applied after destroy', () => {
    const theme = new Theme(target);
    theme.apply({ tokens: { a: '1' }, customCSS: '.a {}' });
    theme.destroy();
    theme.apply({ tokens: { a: '2' }, customCSS: '.b {}' });

    expect(target.style.getPropertyValue('--a')).toBe('2');
    expect(customStyles()).toHaveLength(1);
  });

  test('destroying one theme does not disturb another on the same target', () => {
    const a = new Theme(target);
    const b = new Theme(target);
    a.apply({ tokens: { 'from-a': '1' } });
    b.apply({ tokens: { 'from-b': '2' } });
    a.destroy();

    expect(target.style.getPropertyValue('--from-a')).toBe('');
    expect(target.style.getPropertyValue('--from-b')).toBe('2');
  });
});

describe('the headless invariant', () => {
  test('constructing a Theme writes nothing', () => {
    new Theme(target);

    expect(target.getAttribute('style')).toBeFalsy();
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
  });

  test('apply({}) ships no default tokens and no default stylesheet', () => {
    new Theme(target).apply({});

    expect(target.getAttribute('style')).toBeFalsy();
    expect(document.head.querySelectorAll('style')).toHaveLength(0);
  });
});
