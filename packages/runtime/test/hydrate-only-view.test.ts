/**
 * A hydrate-only view, mounted for real (0.11.2).
 *
 * The claim `defineHydrateOnlyRenderer` rests on is a runtime one: a
 * `mode: 'hydrate'` mount calls `hydrate()` and never `render()`, so a
 * browser bundle that holds listeners without templates is enough for a
 * site whose pages are server-rendered. A consumer measured two-thirds of
 * their entry bundle as markup code that never ran; this is the test that
 * says they can drop it.
 *
 * The second half pins the other side of the deal: the paths that DO need
 * a template fail loudly, and the error says what to do.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { defineHydrateOnlyRenderer } from '@airo-js/cartridge-kit';

import { mountCartridge } from '../src/mount-cartridge.js';
import { fakeCartridge, fakeTemplate, type TestConfig, type TestData } from './fixtures.js';

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

const SERVER_HTML = '<div data-ssr="yes">server-rendered content</div>';

function cartridgeWith(hydrate: (root: HTMLElement) => (() => void) | void) {
  return fakeCartridge({
    views: [
      {
        id: 'home-view',
        displayName: 'Home',
        pageType: 'home',
        capabilities: ['hydrate-only'],
        factory: defineHydrateOnlyRenderer({ hydrate }),
      },
    ],
  });
}

function mount(
  hydrate: (root: HTMLElement) => (() => void) | void,
  mode: 'hydrate' | 'csr' = 'hydrate',
  styleIsolation: 'shadow' | 'light' = 'light',
) {
  if (mode === 'hydrate') host.innerHTML = SERVER_HTML;
  return mountCartridge<TestData, TestConfig>({
    cartridge: cartridgeWith(hydrate),
    config: {},
    template: fakeTemplate(),
    host,
    preloadedData: { items: [] },
    styleIsolation,
    mode,
  });
}

describe('a hydrate mount needs no template in the browser', () => {
  test('hydrate() runs and the server markup is left exactly as it was', async () => {
    const hydrate = vi.fn();
    const mounted = await mount(hydrate);

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(host.innerHTML).toContain('data-ssr="yes"');
    mounted.destroy();
  });

  test('listeners attached by hydrate() work on the server\'s DOM', async () => {
    // Assert against the root the handler was handed: where that sits
    // (the host itself, or a render root inside it) is the isolation
    // mode's business, not this test's.
    let hydrated: HTMLElement | undefined;
    const mounted = await mount((root) => {
      hydrated = root;
      root.addEventListener('click', () => root.setAttribute('data-clicked', 'yes'));
    });

    const painted = hydrated?.querySelector('[data-ssr]');
    expect(painted, 'hydrate() should be handed the root holding the server markup').not.toBeNull();
    (painted as HTMLElement).click();

    expect(hydrated?.getAttribute('data-clicked')).toBe('yes');
    mounted.destroy();
  });

  test('the cleanup a hydrate handler returns runs on destroy', async () => {
    const cleanup = vi.fn();
    const mounted = await mount(() => cleanup);

    expect(cleanup).not.toHaveBeenCalled();
    mounted.destroy();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('it hydrates under shadow isolation too', async () => {
    const hydrate = vi.fn();
    const mounted = await mount(hydrate, 'hydrate', 'shadow');

    expect(hydrate).toHaveBeenCalledTimes(1);
    mounted.destroy();
  });
});

describe('the paths that need a template say so', () => {
  test('a csr mount of a hydrate-only view throws, naming the page', async () => {
    await expect(mount(() => undefined, 'csr')).rejects.toThrow(
      /hydrate-only view.*page "home"/s,
    );
  });

  test('the error points at the two ways out', async () => {
    await expect(mount(() => undefined, 'csr')).rejects.toThrow(/resolveView|full renderer/);
  });
});
