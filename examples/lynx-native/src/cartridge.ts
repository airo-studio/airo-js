/**
 * The cartridge's browser half: hydrate-only views, exactly what a
 * server-rendered site ships to the browser. On device the same handlers run
 * through `@airo-js/lynx`'s DOM facade — nothing here knows it is native.
 */

import { type Cartridge, defineHydrateOnlyRenderer, type Template } from '@airo-js/cartridge-kit';
import type { RenderContext } from '@airo-js/core';

import type { NotesData } from './server.js';

type Ctx = RenderContext<string, { data: NotesData }>;

/** The delegation helper a browser codebase typically has. */
function on(root: HTMLElement, type: string, selector: string, fn: (event: Event, target: HTMLElement) => void): () => void {
  const listener = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(selector);
    if (target && root.contains(target)) fn(event, target);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

const homeBehaviour = (root: HTMLElement, _ctx: Ctx): (() => void) => {
  // Marks the page live, as browser code often does; on device the attribute
  // reaches the element as its mirror class, which the device report shows.
  root.querySelector('.app')?.setAttribute('data-hydrated', 'yes');
  const offs = [
    on(root, 'click', '[data-action="count"]', (_e, button) => {
      const n = button.querySelector('.counter__n');
      if (n) n.textContent = String(Number(n.textContent) + 1);
    }),
    on(root, 'click', '[data-action="toggle"]', (_e, toggle) => {
      const body = root.querySelector<HTMLElement>('.panel__body');
      if (!body) return;
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
    }),
    on(root, 'input', '.search__input', (_e, input) => {
      const echo = root.querySelector('.echo__value');
      if (echo) echo.textContent = (input as HTMLInputElement).value || 'nothing yet';
    }),
  ];
  return () => {
    for (const off of offs) off();
  };
};

/** Open a native `<dialog>`'s close paths: its close buttons, and a click on the backdrop (the dialog itself). */
function wireDialog(dialog: HTMLDialogElement): () => void {
  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) dialog.close();
  };
  dialog.addEventListener('click', onClick);
  return () => dialog.removeEventListener('click', onClick);
}

const controlsBehaviour = (root: HTMLElement, ctx: Ctx): (() => void) => {
  const sheet = root.querySelector<HTMLDialogElement>('#sheet');
  const toast = root.querySelector<HTMLElement>('[data-toast]');
  const picked = root.querySelector<HTMLElement>('.picked__value');
  // The newest toast clears itself; one cleared after the page is gone writes nowhere.
  let shown = 0;
  const offs = [
    on(root, 'click', '[data-action="sheet"]', () => sheet?.showModal()),
    on(root, 'click', '[data-action="toast"]', () => {
      if (!toast) return;
      toast.textContent = 'Saved';
      const mine = ++shown;
      setTimeout(() => {
        if (mine === shown) toast.textContent = '';
      }, 2000);
    }),
    on(root, 'change', '.sort__select', (_e, select) => {
      if (picked) picked.textContent = (select as HTMLSelectElement).value;
    }),
  ];
  if (sheet) {
    offs.push(wireDialog(sheet));
    if (ctx.app.data.open) sheet.showModal();
  }
  return () => {
    shown = -1;
    for (const off of offs) off();
  };
};

const view = (pageType: string, hydrate: (root: HTMLElement, ctx: Ctx) => (() => void) | void) => ({
  id: `${pageType}-view`,
  displayName: pageType,
  pageType,
  capabilities: ['hydrate-only' as const],
  factory: defineHydrateOnlyRenderer<string, { data: NotesData }>({ hydrate }),
});

export const cartridge: Cartridge<NotesData, Record<string, never>> = {
  id: 'notes',
  mailboxName: '__AIRO_NOTES_PAGES__',
  industry: 'publishing',
  displayName: 'Field notes',
  description: 'A small notes site, rendered on a server and shown natively.',
  version: '0.0.0',
  schema: {
    parse: (input) => input as NotesData,
    safeParse: (input) => ({ success: true as const, data: input as NotesData }),
  },
  dataSources: [],
  views: [
    view('home', homeBehaviour),
    view('note', () => {}),
    view('search', () => {}),
    view('done', () => {}),
    view('controls', controlsBehaviour),
  ],
  templates: [],
  defaultConfig: {},
  defaultTemplateId: 'site',
};

export const template: Template<Record<string, never>> = {
  id: 'site',
  displayName: 'Site',
  description: 'Every page of the notes site.',
  defaultConfig: {},
  pages: [
    { id: 'home', type: 'home', enabled: true },
    { id: 'note', type: 'note', enabled: true },
    { id: 'search', type: 'search', enabled: true },
    { id: 'done', type: 'done', enabled: true },
    { id: 'controls', type: 'controls', enabled: true },
  ],
};
