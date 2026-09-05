/**
 * Style isolation — the shadow-boundary mechanism.
 *
 * The headless invariant (§5) lives here: the framework attaches a boundary
 * and creates a wrapper, and injects ZERO CSS. Several tests below assert the
 * absence of styling rather than its presence, because "the framework quietly
 * started shipping a default" is exactly the regression the invariant exists
 * to prevent and nothing else would catch it.
 *
 * The DSD adoption path is the subtle one. `<template shadowrootmode>` gives
 * the browser a shadow root with content already in it, and `setupIsolationRoot`
 * must adopt that shadow rather than call `attachShadow` (which throws) and
 * must move the existing children into the wrapper rather than orphan them —
 * that is the zero-FOUC SSR path, so dropping the content means a blank widget.
 */

import { describe, expect, test } from 'vitest';

import { resolveStyleRoot, setupIsolationRoot, wrapInShadow } from '../src/style.js';

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe("setupIsolationRoot — 'light'", () => {
  test('renders into the host itself, styles into document.head', () => {
    const el = host();
    const root = setupIsolationRoot(el, 'light');

    expect(root.renderRoot).toBe(el);
    expect(root.styleRoot).toBe(document.head);
    expect(root.isolated).toBe(false);
  });

  test('attaches no shadow boundary at all', () => {
    const el = host();
    setupIsolationRoot(el, 'light');
    expect(el.shadowRoot).toBeNull();
  });

  test('leaves existing host content untouched', () => {
    const el = host();
    el.innerHTML = '<p>existing</p>';
    setupIsolationRoot(el, 'light');
    expect(el.innerHTML).toBe('<p>existing</p>');
  });
});

describe("setupIsolationRoot — 'shadow'", () => {
  test('attaches an open shadow root and returns a wrapper inside it', () => {
    const el = host();
    const root = setupIsolationRoot(el, 'shadow');

    expect(el.shadowRoot).not.toBeNull();
    expect(root.isolated).toBe(true);
    expect(root.styleRoot).toBe(el.shadowRoot);
    expect(root.renderRoot.className).toBe('airo-shadow-root');
    expect(root.renderRoot.parentNode).toBe(el.shadowRoot);
  });

  test('the shadow is open, so hosts can inspect it', () => {
    const el = host();
    setupIsolationRoot(el, 'shadow');
    expect(el.shadowRoot).not.toBeNull();
  });

  test('is idempotent — a second call returns the SAME wrapper', () => {
    const el = host();
    const first = setupIsolationRoot(el, 'shadow');
    const second = setupIsolationRoot(el, 'shadow');

    expect(second.renderRoot).toBe(first.renderRoot);
    expect(el.shadowRoot!.querySelectorAll('.airo-shadow-root')).toHaveLength(1);
  });

  test('a second call does not wipe content painted into the wrapper', () => {
    const el = host();
    setupIsolationRoot(el, 'shadow').renderRoot.innerHTML = '<p>painted</p>';
    expect(setupIsolationRoot(el, 'shadow').renderRoot.innerHTML).toBe('<p>painted</p>');
  });

  describe('the headless invariant', () => {
    test('injects NO stylesheet into the shadow root', () => {
      const el = host();
      const root = setupIsolationRoot(el, 'shadow');

      expect(el.shadowRoot!.querySelectorAll('style')).toHaveLength(0);
      expect(el.shadowRoot!.querySelectorAll('link')).toHaveLength(0);
      expect((root.styleRoot as ShadowRoot).adoptedStyleSheets ?? []).toHaveLength(0);
    });

    test('the wrapper carries no inline style and no class but its own', () => {
      const root = setupIsolationRoot(host(), 'shadow');

      expect(root.renderRoot.getAttribute('style')).toBeNull();
      expect(root.renderRoot.className).toBe('airo-shadow-root');
    });

    test('the shadow root contains ONLY the wrapper', () => {
      const el = host();
      setupIsolationRoot(el, 'shadow');
      expect(el.shadowRoot!.childNodes).toHaveLength(1);
    });
  });

  describe('Declarative Shadow DOM adoption', () => {
    test('adopts a pre-existing shadow root instead of re-attaching', () => {
      const el = host();
      const preAttached = el.attachShadow({ mode: 'open' });

      // attachShadow throws on re-attach; adopting is the only way this can
      // work, so reaching the assertion at all is half the test.
      const root = setupIsolationRoot(el, 'shadow');
      expect(root.styleRoot).toBe(preAttached);
    });

    test('MOVES pre-existing shadow content into the wrapper — the zero-FOUC path', () => {
      const el = host();
      const shadow = el.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<p id="ssr">server rendered</p>';

      const root = setupIsolationRoot(el, 'shadow');

      // The content must survive: dropping it is a blank widget on the SSR
      // path this branch exists to serve.
      expect(root.renderRoot.querySelector('#ssr')?.textContent).toBe('server rendered');
      expect(shadow.childNodes).toHaveLength(1);
      expect(shadow.firstChild).toBe(root.renderRoot);
    });

    test('preserves multiple pre-existing roots, in order', () => {
      const el = host();
      const shadow = el.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<i>a</i><b>b</b><u>c</u>';

      const root = setupIsolationRoot(el, 'shadow');
      expect(Array.from(root.renderRoot.children).map((c) => c.tagName)).toEqual([
        'I',
        'B',
        'U',
      ]);
    });

    test('a pre-existing shadow that ALREADY has the wrapper is left alone', () => {
      const el = host();
      const shadow = el.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<div class="airo-shadow-root"><p>already wrapped</p></div>';

      const root = setupIsolationRoot(el, 'shadow');
      expect(root.renderRoot.innerHTML).toBe('<p>already wrapped</p>');
      expect(shadow.querySelectorAll('.airo-shadow-root')).toHaveLength(1);
    });
  });
});

describe('wrapInShadow', () => {
  test("is a no-op in 'light' mode, returning the host unchanged", () => {
    const el = host();
    el.innerHTML = '<p>ssr</p>';

    expect(wrapInShadow(el, 'light')).toBe(el);
    expect(el.shadowRoot).toBeNull();
    expect(el.innerHTML).toBe('<p>ssr</p>');
  });

  test('moves light-DOM SSR content into a shadow wrapper', () => {
    const el = host();
    el.innerHTML = '<p id="ssr">server rendered</p>';

    const wrapper = wrapInShadow(el, 'shadow');

    expect(el.shadowRoot).not.toBeNull();
    expect(wrapper.className).toBe('airo-shadow-root');
    expect(wrapper.querySelector('#ssr')?.textContent).toBe('server rendered');
  });

  test('the light DOM is emptied — content moved, not duplicated', () => {
    const el = host();
    el.innerHTML = '<p>ssr</p>';
    wrapInShadow(el, 'shadow');

    expect(el.innerHTML).toBe('');
  });

  test('is idempotent — a re-call returns the wrapper without re-wrapping', () => {
    const el = host();
    el.innerHTML = '<p>ssr</p>';

    const first = wrapInShadow(el, 'shadow');
    const second = wrapInShadow(el, 'shadow');

    expect(second).toBe(first);
    expect(second.innerHTML).toBe('<p>ssr</p>');
  });

  test('a re-call does not nest a second wrapper', () => {
    const el = host();
    el.innerHTML = '<p>ssr</p>';
    wrapInShadow(el, 'shadow');
    wrapInShadow(el, 'shadow');

    expect(el.shadowRoot!.querySelectorAll('.airo-shadow-root')).toHaveLength(1);
  });

  test('handles an empty host', () => {
    const el = host();
    expect(wrapInShadow(el, 'shadow').innerHTML).toBe('');
  });
});

describe('resolveStyleRoot', () => {
  test('returns the ShadowRoot for a node inside a shadow', () => {
    const el = host();
    const root = setupIsolationRoot(el, 'shadow');
    const inner = document.createElement('span');
    root.renderRoot.appendChild(inner);

    expect(resolveStyleRoot(inner)).toBe(el.shadowRoot);
  });

  test('returns the wrapper\'s own shadow root when given the wrapper', () => {
    const el = host();
    expect(resolveStyleRoot(setupIsolationRoot(el, 'shadow').renderRoot)).toBe(el.shadowRoot);
  });

  test('falls back to document.head for a light-DOM node', () => {
    expect(resolveStyleRoot(host())).toBe(document.head);
  });

  test('resolves through a nested shadow to the NEAREST boundary', () => {
    const outer = host();
    const outerRoot = setupIsolationRoot(outer, 'shadow');
    const innerHost = document.createElement('div');
    outerRoot.renderRoot.appendChild(innerHost);
    const innerRoot = setupIsolationRoot(innerHost, 'shadow');

    expect(resolveStyleRoot(innerRoot.renderRoot)).toBe(innerHost.shadowRoot);
    expect(resolveStyleRoot(innerRoot.renderRoot)).not.toBe(outer.shadowRoot);
  });

  test('prefers the node\'s OWN ownerDocument over the global one', () => {
    // The SSR case: a deno-dom / linkedom document must be reachable, so the
    // helper must not reach for globalThis.document when the node knows.
    const detached = document.implementation.createHTMLDocument('other');
    const el = detached.createElement('div');

    expect(resolveStyleRoot(el)).toBe(detached.head);
    expect(resolveStyleRoot(el)).not.toBe(document.head);
  });

  test('a detached node still resolves via its ownerDocument', () => {
    expect(resolveStyleRoot(document.createElement('div'))).toBe(document.head);
  });
});
