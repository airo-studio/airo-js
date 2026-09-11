/**
 * `renderAppToHTML` and `Page.private` (0.11.0 pre-landing review).
 *
 * The promise is on the page graph, so the low-level renderer keeps it
 * too: a private entry is refused with `skipped: { reason: 'private' }`
 * unless the host passes `renderPrivate: true`; a public entry is
 * unaffected either way; `fellBack` rides along with a refusal.
 */

import { describe, expect, test } from 'vitest';

import type { AppConfig, PageRenderer } from '@airo-js/core';

import { renderAppToHTML } from '../src/render-app.js';

function ssrRenderer(label: string): PageRenderer {
  return {
    render() {},
    renderSSR(container) {
      container.innerHTML = `<div data-marker="${label}">${label}</div>`;
    },
    destroy() {},
  };
}

const layout = { regionOrder: [], regions: {} };
const graph: AppConfig = {
  appId: 'app',
  pages: [
    { id: 'home', type: 'home', enabled: true, layout },
    { id: 'members', type: 'members', enabled: true, layout, private: true },
  ],
};
const membersFirst: AppConfig = { ...graph, pages: [...graph.pages].reverse() };

function render(config: AppConfig, extra: { page?: string; renderPrivate?: boolean } = {}) {
  return renderAppToHTML(config, {
    document: globalThis.document,
    resolveRenderer: (pageType) => () => ssrRenderer(pageType),
    appContext: {},
    ...(extra.page ? { initialNavState: { page: extra.page } } : {}),
    ...(extra.renderPrivate !== undefined ? { renderPrivate: extra.renderPrivate } : {}),
  });
}

describe('renderAppToHTML — private pages', () => {
  test('a private entry without renderPrivate is refused: empty html, skipped.reason "private"', () => {
    const result = render(graph, { page: 'members' });
    expect(result.html).toBe('');
    expect(result.skipped).toEqual({ pageType: 'members', reason: 'private' });
    expect(result.fellBack).toBeUndefined();
  });

  test('with renderPrivate: true the private entry renders', () => {
    const result = render(graph, { page: 'members', renderPrivate: true });
    expect(result.html).toContain('data-marker="members"');
    expect(result.skipped).toBeUndefined();
  });

  test('a public entry renders with or without renderPrivate', () => {
    expect(render(graph, { page: 'home' }).html).toContain('data-marker="home"');
    expect(render(graph, { page: 'home', renderPrivate: true }).html).toContain('data-marker="home"');
  });

  test('a members-first graph: an unknown page falls back to the private default and the result carries BOTH fellBack and skipped', () => {
    const result = render(membersFirst, { page: 'nope' });
    expect(result.html).toBe('');
    expect(result.skipped?.reason).toBe('private');
    expect(result.fellBack).toEqual({ requested: 'nope', reason: 'unknown-page' });
  });
});
